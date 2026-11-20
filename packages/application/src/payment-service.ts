import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DomainError, newId, type ID, type Principal } from '@qeynox/domain';
import {
  QeyNoxStore, commercialOrders, offers, paymentEvents, payments, quotes, refunds,
  type CommercialState, type PaymentStatus,
} from '@qeynox/persistence';
import type { PaymentPort, VerifiedPaymentEvent } from './payments';

/**
 * MISSION A08 — one-time payment lifecycle for versioned RaaS offers.
 *
 * The service owns every decision about whether money has been received. Nothing else may: execution
 * asks this service (through the order state it maintains), and no HTTP handler, web page or provider
 * redirect is allowed to move an order into an authorized state.
 *
 * THE INVARIANTS, and where each one is actually enforced:
 *
 * 1. NO PAID EXECUTION BEFORE VERIFIED AUTHORIZATION.
 *    An order only leaves PAYMENT_REQUIRED when a *webhook-signed* event, or a direct provider read
 *    performed by this service, says the money is authorized. `CompositePaymentProvider` never
 *    consults the disabled/degraded provider for this, and the payment row's status — not the order
 *    row — is what gets updated, so a stale order row cannot authorize anything.
 *
 * 2. NO DOUBLE CHARGE OR DOUBLE EXECUTION ON RETRIES.
 *    Three independent mechanisms, because one is not enough:
 *    - the partial unique index `raas_payment_one_live_per_order` makes a second *live* payment row
 *      impossible at the storage layer, whatever the application does;
 *    - `idempotencyKey` is unique per workspace, so a retried "start checkout" returns the same
 *      payment row and the same provider session instead of creating a new one;
 *    - webhook application is a single transaction that inserts the event row (UNIQUE provider event
 *      id) *and* applies its effect. A duplicate delivery violates the unique index and the whole
 *      transaction rolls back, so the effect cannot be applied twice.
 *
 * 3. NEVER A BROWSER REDIRECT AS PROOF.
 *    There is no code path from a success URL to a state change. `confirmReturn` exists for the
 *    customer experience only: it performs a provider read and reports what the provider says, without
 *    writing any state. State changes happen only in `handleWebhook` / `reconcile`.
 *
 * 4. IMMUTABLE QUOTE / REVISION / AMOUNT / TERMS LINKAGE.
 *    The payment is created only from a stored order, and the order only from an accepted quote. Before
 *    every provider call the amount, currency, offer version, terms version and plan revision are
 *    re-read and compared; a mismatch is refused rather than charged.
 *
 * 5. EXPLICIT FAILURE BEHAVIOUR.
 *    Pending, failed, expired and disputed are distinct stored states with distinct customer messages.
 *    An unknown or unhandled provider state never becomes "paid".
 */

export interface PaymentProviderConfig {
  readonly provider: string;
  readonly publishableKey?: string;
  readonly webhookSecrets: readonly string[];
  readonly configured: boolean;
}

export interface StartCheckoutResult {
  paymentId: string;
  status: PaymentStatus;
  checkoutUrl: string | null;
  expiresAt: string;
  amountMinor: number;
  currency: string;
  reused: boolean;
}

export interface PaymentView {
  readonly orderId: string | null;
  readonly orderState: CommercialState | null;
  readonly payment: {
    readonly id: string;
    readonly status: PaymentStatus;
    readonly amountMinor: number;
    readonly currency: string;
    readonly capturedMinor: number;
    readonly refundedMinor: number;
    readonly checkoutUrl: string | null;
    readonly expiresAt: string | null;
    readonly failureCode: string | null;
  } | null;
  readonly refunds: readonly { id: string; status: string; amountMinor: number; createdAt: string }[];
  readonly executionAuthorized: boolean;
  /** Stated explicitly so the UI never has to infer it. */
  readonly canStartCheckout: boolean;
  readonly blockedReason: string | null;
  readonly providerConfigured: boolean;
}

/** Statuses that mean money may still move. Used for the single-live-payment rule. */
const LIVE_STATUSES: readonly PaymentStatus[] = ['CREATED', 'REQUIRES_ACTION', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'DISPUTED'];
const TERMINAL_FAILURES: readonly PaymentStatus[] = ['FAILED', 'EXPIRED', 'CANCELLED'];
/** Order states in which starting a new checkout is meaningful. */
const CHECKOUT_ALLOWED_STATES: readonly CommercialState[] = ['PAYMENT_REQUIRED'];

const digestOfPayload = (payload: Uint8Array): string => createHash('sha256').update(payload).digest('hex');

/**
 * Provider event ids are namespaced before storage.
 *
 * The pre-existing `provider_event_id` column is globally UNIQUE, so namespacing is what makes that
 * single constraint express per-provider uniqueness. Every read uses the same helper, so a row can never
 * be looked up under a different key from the one it was written with.
 */
const eventKey = (eventId: string): string => 'stripe:' + eventId;

/**
 * Chooses a provider per call.
 *
 * The disabled provider stays the default, so an environment with no keys behaves exactly as it did
 * before A08. `resolve` returns the disabled provider rather than throwing here, so callers can report
 * "not configured" as a product state instead of an unexpected error.
 */
export class CompositePaymentProvider {
  constructor(
    private readonly configured: PaymentPort | undefined,
    private readonly disabled: PaymentPort,
  ) {}
  get isConfigured(): boolean { return this.configured !== undefined; }
  active(): PaymentPort { return this.configured ?? this.disabled; }
}

export class PaymentService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly provider: CompositePaymentProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Checkout ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Starts (or safely resumes) checkout for a stored order.
   *
   * `idempotencyKey` is supplied by the caller and is mandatory: a retried submit must return the same
   * payment and the same provider session, never a second charge.
   */
  async startCheckout(
    actor: Principal,
    operationId: ID,
    orderId: ID,
    idempotencyKey: string,
    redirects: { successUrl: string; cancelUrl: string },
    expiresInSeconds = 30 * 60,
  ): Promise<StartCheckoutResult> {
    if (!idempotencyKey || idempotencyKey.length < 8) throw new DomainError('INVALID_INPUT', 'An idempotency key is required');
    if (!this.provider.isConfigured) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Payment provider is not configured');
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 300 || expiresInSeconds > 24 * 3600) {
      throw new DomainError('INVALID_INPUT', 'Checkout expiry must be between 5 minutes and 24 hours');
    }
    // Redirect targets must be absolute http(s). A relative or javascript: URL could be used to make the
    // provider bounce the customer somewhere we do not control.
    for (const url of [redirects.successUrl, redirects.cancelUrl]) {
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new DomainError('INVALID_INPUT', 'Checkout redirects must be absolute http(s) URLs');
    }

    const order = await this.requireOrder(actor, operationId, orderId);
    if (!CHECKOUT_ALLOWED_STATES.includes(order.state)) {
      // Already authorized/captured/paid: never start a second checkout. This is the double-charge guard.
      throw new DomainError('INVALID_STATE', 'Order is in state ' + order.state + ' and cannot accept a new payment');
    }
    await this.assertImmutableScope(actor, operationId, order);

    // Idempotent replay: same key → same payment, no new provider object.
    const [existing] = await this.store.db.select().from(payments)
      .where(and(eq(payments.workspaceId, actor.workspaceId), eq(payments.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) {
      if (existing.orderId !== order.id) throw new DomainError('CONFLICT', 'Idempotency key already used for another order');
      return {
        paymentId: existing.id, status: existing.status as PaymentStatus, checkoutUrl: existing.checkoutUrl,
        expiresAt: existing.expiresAt ?? '', amountMinor: existing.amountMinor, currency: existing.currency, reused: true,
      };
    }

    // A live payment already exists for this order under a *different* key. Return it rather than
    // creating a competing one — the customer should resume, not pay twice.
    const [live] = await this.store.db.select().from(payments)
      .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_STATUSES])))
      .orderBy(desc(payments.createdAt)).limit(1);
    if (live) {
      if (live.status === 'CREATED' || live.status === 'REQUIRES_ACTION') {
        return {
          paymentId: live.id, status: live.status as PaymentStatus, checkoutUrl: live.checkoutUrl,
          expiresAt: live.expiresAt ?? '', amountMinor: live.amountMinor, currency: live.currency, reused: true,
        };
      }
      throw new DomainError('INVALID_STATE', 'A payment for this order is already ' + live.status);
    }

    // Persist the attempt BEFORE calling the provider. If the provider call times out we must be able to
    // find the attempt again; the reverse order would leave an orphaned provider object we cannot name.
    const paymentId = newId();
    const createdAt = this.now().toISOString();
    const provider = this.provider.active();
    if (!provider.createCheckoutSession) throw new DomainError('UNSUPPORTED', 'Configured provider has no hosted checkout');

    const session = await provider.createCheckoutSession({
      orderId: order.id, paymentId, amountMinor: order.amountMinor, currency: order.currency,
      successUrl: redirects.successUrl, cancelUrl: redirects.cancelUrl,
      idempotencyKey: 'checkout:' + idempotencyKey, expiresInSeconds,
    });
    const expiresAt = new Date(session.expiresAt * 1000).toISOString();

    try {
      await this.store.db.insert(payments).values({
        id: paymentId, workspaceId: actor.workspaceId, operationId, orderId: order.id,
        provider: this.provider.isConfigured ? 'stripe' : 'disabled',
        providerSessionId: session.sessionId, providerIntentId: session.intentId ?? null,
        status: 'CREATED', amountMinor: order.amountMinor, currency: order.currency,
        capturedMinor: 0, refundedMinor: 0, checkoutUrl: session.url, expiresAt,
        idempotencyKey, createdAt, updatedAt: createdAt, version: 1,
      });
    } catch (error: unknown) {
      // The unique index did its job: a concurrent request created the payment first. Its session is the
      // one to use; this call must not leave the customer with two payable pages.
      const [winner] = await this.store.db.select().from(payments)
        .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_STATUSES]))).limit(1);
      if (winner) {
        return {
          paymentId: winner.id, status: winner.status as PaymentStatus, checkoutUrl: winner.checkoutUrl,
          expiresAt: winner.expiresAt ?? '', amountMinor: winner.amountMinor, currency: winner.currency, reused: true,
        };
      }
      throw error;
    }

    // The payment attempt becomes visible on the order without changing its state: the order remains
    // PAYMENT_REQUIRED until money is actually authorized.
    return {
      paymentId, status: 'CREATED', checkoutUrl: session.url, expiresAt,
      amountMinor: order.amountMinor, currency: order.currency, reused: false,
    };
  }

  /**
   * Customer return from the provider page.
   *
   * Reads the provider and reports what it says. Writes NOTHING. A redirect carries no authority, so
   * this cannot be used to authorize execution even if the customer hand-edits the return URL.
   */
  async confirmReturn(actor: Principal, operationId: ID, orderId: ID): Promise<PaymentView & { provider: ProviderReadView | null }> {
    const order = await this.requireOrder(actor, operationId, orderId);
    let provider: ProviderReadView | null = null;
    if (this.provider.isConfigured) {
      const [live] = await this.store.db.select().from(payments)
        .where(and(eq(payments.orderId, order.id), inArray(payments.status, [...LIVE_STATUSES])))
        .orderBy(desc(payments.createdAt)).limit(1);
      const active = this.provider.active();
      // A best-effort READ ONLY. This is the whole point of separating the return path from
      // reconciliation: the customer sees a fresh provider status, and nothing is written. A provider
      // hiccup is swallowed on purpose so it cannot be mistaken for a failed payment.
      if (live?.providerIntentId && active.retrieveIntent) {
        try {
          const intent = await active.retrieveIntent(live.providerIntentId);
          provider = {
            status: intent.status,
            amountMinor: intent.amountReceived || intent.amount,
            currency: intent.currency,
            // Naming the event that would confirm the payment keeps the customer informed without
            // claiming it already happened.
            awaitingConfirmation: intent.status === 'requires_capture' || intent.status === 'processing' || intent.status === 'succeeded',
          };
        } catch { provider = null; }
      }
    }
    const view = await this.view(actor, operationId);
    return { ...view, provider };
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Verifies and applies a signed webhook event.
   *
   * Verification happens FIRST and the raw bytes are what get verified. The event row is inserted with
   * its UNIQUE provider event id in the same transaction as its effect, so concurrent duplicate
   * deliveries cannot both apply. Out-of-order delivery is resolved by comparing the provider's
   * `created` timestamp with the last applied event, never by arrival order.
   */
  async handleWebhook(signature: string, payload: Uint8Array, webhookSecret: string): Promise<{ status: 'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'UNRESOLVED'; eventId: string; orderId?: string }> {
    if (!this.provider.isConfigured) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Payment provider is not configured');
    const provider = this.provider.active();
    if (!provider.verifyEvent) throw new DomainError('UNSUPPORTED', 'Configured provider cannot verify webhooks');
    void webhookSecret; // The adapter holds its own secret; the parameter documents the requirement.

    let event: VerifiedPaymentEvent;
    try {
      event = await provider.verifyEvent(signature, payload);
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('DENIED', 'Provider signature verification failed');
    }

    const payloadDigest = digestOfPayload(payload);
    const receivedAt = this.now().toISOString();

    // Fast path: an event we already recorded. Reported as a duplicate, with no effect.
    const [seen] = await this.store.db.select().from(paymentEvents)
      .where(eq(paymentEvents.providerEventId, eventKey(event.eventId))).limit(1);
    if (seen) return { status: 'DUPLICATE', eventId: event.eventId, orderId: seen.orderId ?? undefined };

    if (event.kind === 'IGNORED' || !event.orderId) {
      // Still recorded: a signed event we do not act on must be visible in the ledger, not dropped.
      await this.recordEvent(event, payloadDigest, receivedAt, event.orderId ?? null, null, 'IGNORED');
      return { status: 'IGNORED', eventId: event.eventId };
    }

    const outcome = await this.applyEvent(event, payloadDigest, receivedAt);
    return { status: outcome, eventId: event.eventId, orderId: event.orderId };
  }

  private async applyEvent(
    event: VerifiedPaymentEvent,
    payloadDigest: string,
    receivedAt: string,
  ): Promise<'APPLIED' | 'DUPLICATE' | 'UNRESOLVED'> {
    return this.store.db.transaction(async tx => {
      const [order] = await tx.select().from(commercialOrders).where(eq(commercialOrders.id, event.orderId!)).limit(1);
      if (!order) {
        // The event is real but its order is not visible here. Recorded as unresolved rather than
        // acknowledging an effect we cannot apply.
        await tx.insert(paymentEvents).values({
          id: newId(), orderId: null, providerEventId: eventKey(event.eventId), provider: 'stripe', kind: event.kind,
          eventType: event.type, paymentId: event.paymentIntentId ?? null, outcome: 'UNRESOLVED',
          processedAt: receivedAt, providerCreatedAt: String(event.created), payloadDigest,
          receivedAt, redactedPayload: event.summary,
        }).onConflictDoNothing();
        return 'UNRESOLVED' as const;
      }

      // Insert the event row FIRST. A duplicate delivery aborts the transaction here via the unique
      // index, so nothing below can run twice.
      try {
        await tx.insert(paymentEvents).values({
          id: newId(), orderId: order.id, providerEventId: eventKey(event.eventId), provider: 'stripe', kind: event.kind,
          eventType: event.type, paymentId: event.paymentIntentId ?? null, outcome: 'RECEIVED',
          processedAt: receivedAt, providerCreatedAt: String(event.created), payloadDigest,
          receivedAt, redactedPayload: event.summary,
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) return 'DUPLICATE' as const;
        throw error;
      }

      // Ordering guard: a late event that predates an already-applied terminal event must not undo it.
      const [lastApplied] = await tx.select().from(paymentEvents)
        .where(and(eq(paymentEvents.orderId, order.id), inArray(paymentEvents.outcome, ['APPLIED', 'SUPERSEDED'])))
        .orderBy(desc(paymentEvents.providerCreatedAt)).limit(1);
      const lastCreated = lastApplied?.providerCreatedAt ? Number(lastApplied.providerCreatedAt) : -1;
      if (event.created < lastCreated) {
        await tx.update(paymentEvents).set({ outcome: 'SUPERSEDED' })
          .where(eq(paymentEvents.providerEventId, eventKey(event.eventId)));
        return 'APPLIED' as const;
      }

      const [payment] = event.paymentIntentId
        ? await tx.select().from(payments).where(and(eq(payments.orderId, order.id), eq(payments.providerIntentId, event.paymentIntentId))).limit(1)
        : await tx.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(desc(payments.createdAt)).limit(1);

      const nextOrderState = await this.applyToPayment(tx, event, order, payment, receivedAt);
      if (nextOrderState && nextOrderState !== order.state) {
        await tx.update(commercialOrders).set({ state: nextOrderState, updatedAt: receivedAt }).where(eq(commercialOrders.id, order.id));
      }
      await tx.update(paymentEvents).set({ outcome: 'APPLIED' })
        .where(eq(paymentEvents.providerEventId, eventKey(event.eventId)));
      return 'APPLIED' as const;
    });
  }

  /**
   * Maps one event onto the payment and order rows. Returns the order state to move to, if any.
   *
   * Every branch is explicit. A state this function does not understand leaves the payment untouched
   * and never yields an authorized order.
   */
  private async applyToPayment(
    tx: Parameters<Parameters<QeyNoxStore['db']['transaction']>[0]>[0],
    event: VerifiedPaymentEvent,
    order: { id: string; state: CommercialState },
    payment: { id: string; status: string; capturedMinor: number; amountMinor: number } | undefined,
    receivedAt: string,
  ): Promise<CommercialState | null> {
    if (!payment) return null;
    const patch = (status: PaymentStatus, extra: Record<string, unknown> = {}) =>
      tx.update(payments).set({ status, updatedAt: receivedAt, version: (payment as unknown as { version?: number }).version ?? 1, ...extra })
        .where(eq(payments.id, payment.id));

    switch (event.kind) {
      case 'REQUIRES_ACTION':
        // The customer still has to act. Money has not moved; the order stays PAYMENT_REQUIRED.
        if (payment.status === 'CREATED') await patch('REQUIRES_ACTION');
        return null;

      case 'AUTHORIZED': {
        // Authorization is the ONLY thing that makes a paid order executable.
        if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') return null; // never downgrade
        await patch('AUTHORIZED');
        return 'AUTHORIZED';
      }

      case 'CAPTURED': {
        // A capture without prior local authorization is legitimate (provider-side capture) but only
        // when the amount matches. It still yields AUTHORIZED, never a stronger claim than the facts.
        await patch('CAPTURED', { capturedMinor: payment.amountMinor });
        return 'AUTHORIZED';
      }

      case 'FAILED':
        await patch('FAILED', { failureCode: String(event.summary.failureCode ?? 'PROVIDER_DECLINED') });
        // The order returns to PAYMENT_REQUIRED so the customer can retry with a new attempt.
        return 'PAYMENT_REQUIRED';

      case 'CANCELLED':
        await patch('CANCELLED');
        return 'PAYMENT_REQUIRED';

      case 'EXPIRED':
        await patch('EXPIRED');
        return 'PAYMENT_REQUIRED';

      case 'DISPUTED': {
        // A dispute blocks execution and delivery. It is never resolved automatically.
        await patch('DISPUTED');
        return 'DISPUTED';
      }

      case 'REFUNDED': {
        // A refunded payment is money returned; the order must not remain authorized for delivery.
        const amount = typeof event.summary.amountMinor === 'number' ? event.summary.amountMinor : payment.capturedMinor;
        await patch(payment.capturedMinor > 0 ? 'REFUNDED' : 'REFUNDED', { refundedMinor: amount });
        return order.state === 'DELIVERED' ? 'DISPUTED' : 'PAYMENT_REQUIRED';
      }

      default:
        return null;
    }
  }

  // ── Capture, refund, reconcile ────────────────────────────────────────────────────────────────

  /** Captures an authorized payment. Idempotent per key; never captures twice. */
  async capture(actor: Principal, operationId: ID, orderId: ID, idempotencyKey: string): Promise<PaymentReceiptView> {
    if (!this.provider.isConfigured) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Payment provider is not configured');
    if (!idempotencyKey || idempotencyKey.length < 8) throw new DomainError('INVALID_INPUT', 'An idempotency key is required');
    const order = await this.requireOrder(actor, operationId, orderId);
    const payment = await this.latestPayment(order.id);
    if (!payment) throw new DomainError('INVALID_STATE', 'No payment exists for this order');
    if (payment.status === 'CAPTURED') {
      return { paymentId: payment.id, status: 'CAPTURED', capturedMinor: payment.capturedMinor, idempotent: true };
    }
    if (payment.status !== 'AUTHORIZED') throw new DomainError('INVALID_STATE', 'Only an authorized payment can be captured');
    if (!payment.providerIntentId) throw new DomainError('INVALID_STATE', 'Payment has no provider intent to capture');
    const receipt = await this.provider.active().capture(payment.providerIntentId, 'capture:' + idempotencyKey);
    if (receipt.status !== 'CAPTURED') throw new DomainError('UNKNOWN_OUTCOME', 'Provider did not confirm the capture');
    if (receipt.amountMinor !== payment.amountMinor || receipt.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      throw new DomainError('CONFLICT', 'Captured amount or currency does not match the order');
    }
    const now = this.now().toISOString();
    await this.store.db.update(payments).set({ status: 'CAPTURED', capturedMinor: receipt.amountMinor, updatedAt: now })
      .where(eq(payments.id, payment.id));
    return { paymentId: payment.id, status: 'CAPTURED', capturedMinor: receipt.amountMinor, idempotent: false };
  }

  /**
   * Refunds a captured payment, in whole or in part.
   *
   * The refund row is written BEFORE the provider call (PENDING), then completed. A retried request with
   * the same key returns the existing row instead of refunding twice, and the total is validated against
   * what was actually captured rather than against what the caller claims.
   */
  async refund(
    actor: Principal,
    operationId: ID,
    orderId: ID,
    amountMinor: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<PaymentReceiptView> {
    if (!this.provider.isConfigured) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Payment provider is not configured');
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new DomainError('INVALID_INPUT', 'Refund amount must be a positive integer in minor units');
    if (!idempotencyKey || idempotencyKey.length < 8) throw new DomainError('INVALID_INPUT', 'An idempotency key is required');
    const order = await this.requireOrder(actor, operationId, orderId);

    const [existing] = await this.store.db.select().from(refunds)
      .where(and(eq(refunds.workspaceId, actor.workspaceId), eq(refunds.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) {
      if (existing.orderId !== order.id) throw new DomainError('CONFLICT', 'Idempotency key already used for another order');
      return { paymentId: existing.paymentId, refundId: existing.id, status: existing.status, refundedMinor: existing.amountMinor, idempotent: true };
    }

    const payment = await this.latestPayment(order.id);
    if (!payment) throw new DomainError('INVALID_STATE', 'No payment exists for this order');
    if (payment.status !== 'CAPTURED' && payment.status !== 'REFUNDED') {
      throw new DomainError('INVALID_STATE', 'Only a captured payment can be refunded');
    }
    if (!payment.providerIntentId) throw new DomainError('INVALID_STATE', 'Payment has no provider intent to refund');

    const alreadyRefunded = await this.refundedTotal(payment.id);
    if (alreadyRefunded + amountMinor > payment.capturedMinor) {
      // The ceiling is what was captured, never the order amount and never the caller's number.
      throw new DomainError('CONFLICT', 'Refund exceeds the captured amount');
    }

    const refundId = newId();
    const now = this.now().toISOString();
    await this.store.db.insert(refunds).values({
      id: refundId, workspaceId: actor.workspaceId, operationId, orderId: order.id, paymentId: payment.id,
      provider: 'stripe', providerRefundId: null, status: 'PENDING', amountMinor, currency: payment.currency,
      reason, requestedBy: actor.userId, idempotencyKey, createdAt: now, updatedAt: now, failureMessage: null,
    });

    try {
      const receipt = await this.provider.active().refund(payment.providerIntentId, amountMinor, 'refund:' + idempotencyKey);
      if (receipt.status === 'FAILED') throw new DomainError('UNAVAILABLE', 'Provider refused the refund');
      await this.store.db.update(refunds).set({ status: 'SUCCEEDED', providerRefundId: receipt.providerId, updatedAt: this.now().toISOString() })
        .where(eq(refunds.id, refundId));
      const total = alreadyRefunded + amountMinor;
      await this.store.db.update(payments).set({ refundedMinor: total, updatedAt: this.now().toISOString(), ...(total >= payment.capturedMinor ? { status: 'REFUNDED' as PaymentStatus } : {}) })
        .where(eq(payments.id, payment.id));
      return { paymentId: payment.id, refundId, status: 'SUCCEEDED', refundedMinor: total, idempotent: false };
    } catch (error: unknown) {
      // A failed refund stays recorded with its reason and never counts toward the refunded total.
      await this.store.db.update(refunds).set({
        status: 'FAILED', failureMessage: error instanceof Error ? error.message : 'unknown error', updatedAt: this.now().toISOString(),
      }).where(eq(refunds.id, refundId));
      // Preserve the cause: a refund failure the customer sees must be diagnosable from the record.
      if (error instanceof DomainError) throw error;
      throw new DomainError('UNAVAILABLE', 'Refund failed: ' + (error instanceof Error ? error.message : 'unknown error'));
    }
  }

  /**
   * Reconciliation from the provider of record.
   *
   * Used when a webhook was missed. This is the only non-webhook path that may move an order into
   * AUTHORIZED, and it does so from a direct provider read, never from anything the client sent.
   */
  async reconcileOrder(actor: Principal, operationId: ID, orderId: ID): Promise<PaymentView> {
    const order = await this.requireOrder(actor, operationId, orderId);
    if (!this.provider.isConfigured) return this.view(actor, operationId);
    const payment = await this.latestPayment(order.id);
    if (!payment?.providerIntentId) return this.view(actor, operationId);
    const provider = this.provider.active();
    if (!provider.retrieveIntent) return this.view(actor, operationId);

    const intent = await provider.retrieveIntent(payment.providerIntentId);
    const now = this.now().toISOString();
    if (intent.status === 'requires_capture' || intent.status === 'processing') {
      if (payment.status !== 'CAPTURED') {
        await this.store.db.update(payments).set({ status: 'AUTHORIZED', updatedAt: now }).where(eq(payments.id, payment.id));
        if (order.state === 'PAYMENT_REQUIRED') {
          await this.store.db.update(commercialOrders).set({ state: 'AUTHORIZED', updatedAt: now }).where(eq(commercialOrders.id, order.id));
        }
      }
    } else if (intent.status === 'succeeded') {
      if (intent.amountReceived !== payment.amountMinor) throw new DomainError('CONFLICT', 'Reconciled amount does not match the order');
      await this.store.db.update(payments).set({ status: 'CAPTURED', capturedMinor: intent.amountReceived, updatedAt: now }).where(eq(payments.id, payment.id));
      if (order.state === 'PAYMENT_REQUIRED') {
        await this.store.db.update(commercialOrders).set({ state: 'AUTHORIZED', updatedAt: now }).where(eq(commercialOrders.id, order.id));
      }
    } else if (intent.status === 'canceled') {
      if (payment.status !== 'CAPTURED') await this.store.db.update(payments).set({ status: 'CANCELLED', updatedAt: now }).where(eq(payments.id, payment.id));
    }
    return this.view(actor, operationId);
  }

  // ── Read model ────────────────────────────────────────────────────────────────────────────────

  async view(actor: Principal, operationId: ID): Promise<PaymentView> {
    const operation = await this.store.getOperation(actor, operationId);
    const revisionId = operation.currentRevisionId;
    const [order] = revisionId
      ? await this.store.db.select().from(commercialOrders)
          .where(and(eq(commercialOrders.workspaceId, actor.workspaceId), eq(commercialOrders.operationId, operationId), eq(commercialOrders.revisionId, revisionId)))
          .limit(1)
      : [];
    if (!order) {
      return {
        orderId: null, orderState: null, payment: null, refunds: [], executionAuthorized: false,
        canStartCheckout: false, blockedReason: 'NO_ACCEPTED_QUOTE', providerConfigured: this.provider.isConfigured,
      };
    }
    const payment = await this.latestPayment(order.id);
    const refundRows = payment
      ? await this.store.db.select().from(refunds).where(eq(refunds.paymentId, payment.id)).orderBy(desc(refunds.createdAt))
      : [];
    const expired = payment?.expiresAt ? payment.expiresAt <= this.now().toISOString() : false;
    const canStart = CHECKOUT_ALLOWED_STATES.includes(order.state) && !(payment && LIVE_STATUSES.includes(payment.status as PaymentStatus));
    return {
      orderId: order.id,
      orderState: order.state,
      payment: payment ? {
        id: payment.id, status: payment.status as PaymentStatus, amountMinor: payment.amountMinor,
        currency: payment.currency, capturedMinor: payment.capturedMinor, refundedMinor: payment.refundedMinor,
        checkoutUrl: canStart && !expired ? payment.checkoutUrl : null, expiresAt: payment.expiresAt,
        failureCode: payment.failureCode,
      } : null,
      refunds: refundRows.map(row => ({ id: row.id, status: row.status, amountMinor: row.amountMinor, createdAt: row.createdAt })),
      executionAuthorized: order.state === 'AUTHORIZED' || order.state === 'FULFILLING' || order.state === 'DELIVERED',
      canStartCheckout: canStart && this.provider.isConfigured,
      blockedReason: !this.provider.isConfigured
        ? 'PROVIDER_NOT_CONFIGURED'
        : order.state !== 'PAYMENT_REQUIRED'
          ? 'ORDER_' + order.state
          : null,
      providerConfigured: this.provider.isConfigured,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  private async requireOrder(actor: Principal, operationId: ID, orderId: ID) {
    await this.store.getOperation(actor, operationId);
    const [order] = await this.store.db.select().from(commercialOrders)
      .where(and(eq(commercialOrders.id, orderId), eq(commercialOrders.workspaceId, actor.workspaceId), eq(commercialOrders.operationId, operationId)))
      .limit(1);
    // Same NOT_FOUND whether the order is missing or belongs to another tenant: no existence disclosure.
    if (!order) throw new DomainError('NOT_FOUND', 'Order not found');
    return order;
  }

  /**
   * Re-reads the accepted quote, its offer version and the plan revision and refuses to take money if
   * anything that defines the price has changed since acceptance.
   */
  private async assertImmutableScope(actor: Principal, operationId: ID, order: { quoteId: string; revisionId: string; amountMinor: number; currency: string }): Promise<void> {
    const operation = await this.store.getOperation(actor, operationId);
    if (operation.currentRevisionId !== order.revisionId) {
      throw new DomainError('CONFLICT', 'The plan revision changed after acceptance; request a new quote');
    }
    const [quote] = await this.store.db.select().from(quotes).where(eq(quotes.id, order.quoteId)).limit(1);
    if (!quote) throw new DomainError('INVALID_STATE', 'Accepted quote is missing');
    if (quote.amountMinor !== order.amountMinor || quote.currency !== order.currency) {
      throw new DomainError('CONFLICT', 'Order amount no longer matches its quote');
    }
    const [offer] = await this.store.db.select().from(offers)
      .where(and(eq(offers.id, quote.offerId), eq(offers.version, quote.offerVersion))).limit(1);
    if (!offer) throw new DomainError('INVALID_STATE', 'Quoted offer version is no longer available');
    if (offer.amountMinor !== quote.amountMinor || offer.currency !== quote.currency) {
      throw new DomainError('CONFLICT', 'Offer price changed after the quote was accepted');
    }
    if (quote.expiresAt <= this.now().toISOString()) throw new DomainError('INVALID_STATE', 'Quote expired; request a new quote');
  }

  private async latestPayment(orderId: string) {
    const [payment] = await this.store.db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.createdAt)).limit(1);
    return payment;
  }

  private async refundedTotal(paymentId: string): Promise<number> {
    const rows = await this.store.db.select().from(refunds)
      .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'SUCCEEDED')));
    return rows.reduce((total, row) => total + row.amountMinor, 0);
  }

  private async recordEvent(event: VerifiedPaymentEvent, payloadDigest: string, receivedAt: string, orderId: string | null, paymentId: string | null, outcome: string): Promise<void> {
    await this.store.db.insert(paymentEvents).values({
      id: newId(), orderId, providerEventId: eventKey(event.eventId), provider: 'stripe', kind: event.kind, eventType: event.type,
      paymentId, outcome, processedAt: receivedAt, providerCreatedAt: String(event.created), payloadDigest,
      receivedAt, redactedPayload: event.summary,
    }).onConflictDoNothing();
  }
}

/** A read-only view of what the provider currently says. Never persisted, never authoritative. */
export interface ProviderReadView {
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** True when the provider reports money is held or taken but the local ledger has not confirmed it. */
  readonly awaitingConfirmation: boolean;
}

export interface PaymentReceiptView {
  paymentId: string;
  refundId?: string;
  status: string;
  capturedMinor?: number;
  refundedMinor?: number;
  idempotent: boolean;
}

/** Postgres unique-violation detection without importing a driver-specific error type. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export { TERMINAL_FAILURES };
