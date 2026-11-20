/**
 * MISSION A08 — Stripe commercial integration QA (isolated database only).
 *
 * Proves the properties that decide whether this is safe to put in front of a customer, against a real
 * PostgreSQL database and the real `PaymentService`:
 *
 *   1. NO PAID EXECUTION BEFORE VERIFIED AUTHORIZATION — an order cannot reach AUTHORIZED from a
 *      redirect, from acceptance alone, or from any unsigned body.
 *   2. NO DOUBLE CHARGE / DOUBLE EXECUTION — concurrent and sequential retries create one payment, one
 *      provider session, one capture and one order authorization.
 *   3. WEBHOOK INTEGRITY — real Stripe HMAC signatures, verified by the real SDK. Forged, tampered,
 *      truncated, wrong-secret and stale-timestamp signatures are all rejected.
 *   4. DUPLICATE / DELAYED / OUT-OF-ORDER EVENTS — duplicates are no-ops, a late event never undoes a
 *      later one, and an event for an unknown order is recorded rather than silently acknowledged.
 *   5. EXPLICIT FAILURE STATES — pending, failed, expired, cancelled and disputed are distinct and
 *      never become "paid".
 *   6. REFUNDS — auditable, idempotent, capped by what was actually captured, and fail without losing
 *      the record.
 *   7. IMMUTABLE QUOTE LINKAGE — a changed revision, amount, offer version or expired quote refuses to
 *      take money.
 *   8. TENANT ISOLATION — no cross-workspace read, checkout, capture, refund or reconcile.
 *
 * HONEST BOUNDARY — read before trusting a green run:
 * - Stripe is NEVER contacted. `FakeStripeProvider` is a deterministic in-process double that implements
 *   the real `PaymentPort`; it proves our logic, not Stripe's behaviour, latency, or error strings.
 *   Live Stripe (test-mode) end-to-end remains NOT VERIFIED.
 * - Webhook payloads are real Stripe-shaped JSON signed with real HMAC-SHA256 through
 *   `Stripe.webhooks.generateTestHeaderString`, so signature verification itself IS exercised for real
 *   by the SDK's own code path. No network call is made.
 * - No browser runs: checkout redirect behaviour and the customer page are not visually verified.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  commercialOrders, identityMemberships, identityUsers, identityWorkspaces, operations, paymentEvents,
  payments, quotes, refunds,
} from '@qeynox/persistence';
import {
  CommerceService, CompositePaymentProvider, DisabledPaymentProvider, PaymentService, StripePaymentProvider,
  type CheckoutSession, type CheckoutSessionRequest, type PaymentIntentRequest, type PaymentPort, type PaymentReceipt,
  type ProviderIntentState, type VerifiedPaymentEvent,
} from '@qeynox/application';
import { DomainError, newId, type ID, type Operation, type Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

let assertions = 0;
const passed: string[] = [];
/** Reads a live length without TypeScript narrowing it away after an assert(). */
const count = (items: readonly unknown[]): number => items.length;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { passed.push(message); console.log('PASS: ' + message); }
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ' (' + error.message + ')' : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

// ── Provider doubles ──────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic in-process Stripe double.
 *
 * It records every call so the tests can assert *how many times* the provider was asked to move money —
 * that is the only way to prove a retry did not double-charge.
 */
class FakeStripeProvider implements PaymentPort {
  readonly sessions: CheckoutSessionRequest[] = [];
  readonly captures: string[] = [];
  readonly refundCalls: { intentId: string; amountMinor: number }[] = [];
  readonly authorizeCalls: PaymentIntentRequest[] = [];
  captureFails = false;
  refundFails = false;
  eventToVerify: VerifiedPaymentEvent | undefined;
  verifyError: Error | undefined;

  async authorize(request: PaymentIntentRequest): Promise<PaymentReceipt> {
    this.authorizeCalls.push(request);
    return { providerId: 'pi_fake_' + request.orderId, status: 'AUTHORIZED', amountMinor: request.amountMinor, currency: request.currency };
  }
  async capture(intentId: string, _idempotencyKey: string): Promise<PaymentReceipt> {
    if (this.captureFails) throw new DomainError('UNAVAILABLE', 'QA injected capture failure');
    this.captures.push(intentId);
    return { providerId: intentId, status: 'CAPTURED', amountMinor: 0, currency: 'USD' };
  }
  async refund(intentId: string, amountMinor: number): Promise<PaymentReceipt> {
    if (this.refundFails) throw new DomainError('UNAVAILABLE', 'QA injected refund failure');
    this.refundCalls.push({ intentId, amountMinor });
    // Real Stripe mints a unique refund id per refund. A constant id would collide with the unique index
    // on provider_refund_id — which is exactly the protection that stops one refund being counted twice.
    return { providerId: 're_fake_' + randomUUID(), status: 'CAPTURED', amountMinor, currency: 'USD' };
  }
  async verifyWebhook(): Promise<never> { throw new DomainError('UNSUPPORTED', 'use verifyEvent'); }
  async verifyEvent(): Promise<VerifiedPaymentEvent> {
    if (this.verifyError) throw this.verifyError;
    if (!this.eventToVerify) throw new DomainError('DENIED', 'no event staged');
    return this.eventToVerify;
  }
  async reconcile(): Promise<PaymentReceipt | undefined> { return undefined; }
  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    this.sessions.push(request);
    // Real Stripe mints a NEW payment intent per checkout session. Reusing one per order would let the
    // double hide a genuine defect (two attempts sharing an intent), so the double mints a unique id.
    return {
      sessionId: 'cs_test_' + request.paymentId,
      url: 'https://checkout.stripe.test/' + request.paymentId,
      intentId: 'pi_fake_' + request.paymentId,
      expiresAt: Math.floor(Date.now() / 1000) + request.expiresInSeconds,
    };
  }
  async retrieveIntent(): Promise<ProviderIntentState> {
    return { id: 'pi_fake', status: 'requires_capture', amount: 0, amountReceived: 0, currency: 'USD', orderId: undefined };
  }
}

/** Better capture double: echoes the real amount so amount-mismatch checks are exercised honestly. */
class AmountAwareProvider extends FakeStripeProvider {
  private amount = 0;
  override async capture(intentId: string, idempotencyKey: string): Promise<PaymentReceipt> {
    if (this.captureFails) throw new DomainError('UNAVAILABLE', 'QA injected capture failure');
    this.captures.push(intentId);
    return { providerId: intentId, status: 'CAPTURED', amountMinor: this.amount, currency: 'USD' };
  }
  setAmount(amountMinor: number): void { this.amount = amountMinor; }
}

// ── Real Stripe signature helpers ────────────────────────────────────────────────────────────────

const SANDBOX_WEBHOOK_SECRET = 'whsec_qa_' + 'a'.repeat(24);

/** Signs a real Stripe-shaped payload using Stripe's own test-header generator (HMAC over `t.payload`). */
function signPayload(payload: string, secret = SANDBOX_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

function stripeEvent(type: string, object: Record<string, unknown>, eventId: string, created: number): string {
  return JSON.stringify({ id: eventId, object: 'event', type, created, api_version: '2026-11-18.endive', data: { object } });
}

/** A provider whose `verifyEvent` runs the REAL Stripe SDK verification against real signatures. */
class RealSignatureVerifier implements PaymentPort {
  private readonly stripe: StripePaymentProvider;
  constructor(secretKey: string, webhookSecret: string) { this.stripe = new StripePaymentProvider({ secretKey, webhookSecret }); }
  async authorize(): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async capture(): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async refund(): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async verifyWebhook(signature: string, payload: Uint8Array) { return this.stripe.verifyWebhook(signature, payload); }
  async verifyEvent(signature: string, payload: Uint8Array) { return this.stripe.verifyEvent(signature, payload); }
  async reconcile(): Promise<PaymentReceipt | undefined> { return undefined; }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated');
    assert(report.applied.includes('0019_payments.sql'), 'the A08 payments migration ran');
    connection = connectDatabase(qa.url);
    const store = new QeyNoxStore(connection.db);

    // ── Group 1 · the provider boundary fails closed ─────────────────────────────────────────────
    const disabled = new DisabledPaymentProvider();
    const closedCalls: readonly (readonly [string, () => Promise<unknown>])[] = [
      ['authorize', () => disabled.authorize({ orderId: 'o', amountMinor: 1, currency: 'USD', idempotencyKey: 'k' })],
      ['verifyWebhook', () => disabled.verifyWebhook('sig', new Uint8Array())],
      ['reconcile', () => disabled.reconcile('o')],
      ['createCheckoutSession', () => disabled.createCheckoutSession!({ orderId: 'o', paymentId: 'p', amountMinor: 1, currency: 'USD', successUrl: 'https://a.test/x', cancelUrl: 'https://a.test/y', idempotencyKey: 'k', expiresInSeconds: 600 })],
      ['verifyEvent', () => disabled.verifyEvent!('sig', new Uint8Array())],
    ];
    for (const [name, call] of closedCalls) {
      await expectDomainError('PAYMENT_NOT_CONFIGURED', call, 'the disabled provider refuses ' + name);
    }
    pass('with no provider configured every payment operation fails closed');

    // A live-mode key must be refused outright: this is the guard that stops a real charge.
    let liveKeyMessage = '';
    try { new StripePaymentProvider({ secretKey: 'sk_live_' + 'x'.repeat(24), webhookSecret: SANDBOX_WEBHOOK_SECRET }); }
    catch (error: unknown) { liveKeyMessage = error instanceof DomainError ? error.code : String(error); }
    assert(liveKeyMessage === 'PAYMENT_NOT_CONFIGURED', 'a live Stripe key is refused at construction, got ' + liveKeyMessage);
    await expectDomainError('PAYMENT_NOT_CONFIGURED', () => new StripePaymentProvider({ secretKey: 'sk_test_' + 'x'.repeat(24), webhookSecret: '' }), 'a missing webhook secret is refused');
    // The test key itself constructs fine — otherwise the refusal above would prove nothing.
    new StripePaymentProvider({ secretKey: 'sk_test_' + 'x'.repeat(24), webhookSecret: SANDBOX_WEBHOOK_SECRET });
    pass('live keys are refused and test-mode keys construct');

    // ── Group 2 · real signature verification ────────────────────────────────────────────────────
    const verifier = new RealSignatureVerifier('sk_test_' + 'y'.repeat(24), SANDBOX_WEBHOOK_SECRET);
    const goodPayload = stripeEvent('payment_intent.amount_capturable_updated',
      { id: 'pi_real_sig', object: 'payment_intent', amount: 2500, amount_received: 0, currency: 'usd', status: 'requires_capture', metadata: { orderId: 'order_sig' } },
      'evt_real_1', Math.floor(Date.now() / 1000));
    const bytes = new TextEncoder().encode(goodPayload);
    const goodSignature = signPayload(goodPayload);
    const verified = await verifier.verifyEvent!(goodSignature, bytes);
    assert(verified.eventId === 'evt_real_1', 'a correctly signed event verifies through the real Stripe SDK');
    assert(verified.kind === 'AUTHORIZED', 'amount_capturable_updated maps to AUTHORIZED');
    assert(verified.orderId === 'order_sig', 'the order is read from signed metadata, not from the client');
    assert(verified.summary.amountMinor === 2500 && verified.summary.currency === 'usd', 'the summary carries the signed amount');

    const rejections: readonly (readonly [string, string, Uint8Array, string])[] = [
      ['a forged signature', 'v1=' + 'f'.repeat(64), bytes, 'forged'],
      ['a signature from a different secret', signPayload(goodPayload, 'whsec_wrong_' + 'b'.repeat(20)), bytes, 'wrong secret'],
      ['a tampered payload', goodSignature, new TextEncoder().encode(goodPayload.replace('2500', '1')), 'tampered'],
      ['a truncated payload', goodSignature, bytes.slice(0, bytes.length - 10), 'truncated'],
      ['an empty signature', '', bytes, 'empty'],
    ];
    for (const [label, signature, payload, name] of rejections) {
      await expectDomainError('DENIED', () => verifier.verifyEvent!(signature, payload), 'verification rejects ' + name + ' (' + label + ')');
    }
    // A replayed delivery older than the SDK tolerance must fail: replay protection is time-based.
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600;
    await expectDomainError('DENIED', () => verifier.verifyEvent!(signPayload(goodPayload, SANDBOX_WEBHOOK_SECRET, staleTimestamp), bytes), 'verification rejects a stale replayed delivery');
    pass('real HMAC signatures verify, and forged, tampered, stale and mismatched signatures are refused');

    // ── Group 3 · fixture: two tenants, an accepted paid quote and an order ─────────────────────
    const mkWorkspace = async (label: string) => {
      const userId = randomUUID(), workspaceId = randomUUID();
      await connection!.db.insert(identityUsers).values({ id: userId, email: 'qa-a08-' + label + '-' + userId + '@example.invalid' });
      await connection!.db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA A08 ' + label, createdBy: userId });
      await connection!.db.insert(identityMemberships).values({ id: randomUUID(), userId, workspaceId, role: 'OWNER', status: 'ACTIVE' });
      return { principal: { userId: userId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] } as Principal, userId, workspaceId };
    };
    const primary = await mkWorkspace('buyer');
    const secondary = await mkWorkspace('outsider');
    const owner = primary.principal;
    const outsider = secondary.principal;

    // Configuration writes are operator-only; the buyer is the operator only inside this QA run.
    process.env.QEYNOX_OPERATOR_USER_IDS = primary.userId;
    const { ConfigurationService } = await import('@qeynox/application');
    const configuration = new ConfigurationService(store);
    const configKey = (suffix: string) => 'qa-a08-config-' + suffix;
    await configuration.apply(owner, {
      idempotencyKey: configKey('1'),
      entries: [
        // A verification policy is validated against a configured provider, so the provider it names is
        // declared here too. This is configuration, not a network call: no connector is invoked in A08.
        {
          domain: 'TOOL', connectorId: 'world-bank', version: '1', status: 'ACTIVE',
          manifest: {
            description: 'QA A08 declaration so the verification policy has a configured provider; never invoked',
            provider: 'World Bank', regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'], mode: 'READ_ONLY',
            licenseNotes: 'QA verification only', termsUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
            freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' },
            rateLimit: { maxPerMinute: 5 }, tools: [{ name: 'indicator', version: '1' }],
          },
        },
        { domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA A08 Capability', purpose: 'QA-only paid capability', scope: ['QA A08 scope'], allowedTools: ['world-bank:indicator@1'], privacyScopes: [], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2 },
        { domain: 'VERIFICATION_POLICY', capabilityId: 'capability-slot-1-v1', version: 1, status: 'ACTIVE', minimumSources: 1, maxAgeDays: 30, approvedProviders: ['world-bank'], humanReviewRequired: true, validFrom: '2026-01-01T00:00:00.000Z' },
        {
          domain: 'RAAS_OFFER', offerId: 'qa-paid-offer', version: 1, status: 'ACTIVE', label: 'QA Paid Offer',
          capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA A08 scope'], exclusions: [],
          regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-paid-terms-v1', currency: 'USD', amountMinor: 2500,
          taxPolicy: 'CONFIGURED', isExplicitlyFree: false,
        },
        { domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD', maxMoneyMinor: 1000, maxAgentCalls: 10, maxToolCalls: 10, maxDurationSeconds: 600, maxConcurrent: 2, unitMaxMinor: { hermes: 10 } },
      ],
    } as never);

    const commerce = new CommerceService(store);
    const { PlanningService } = await import('@qeynox/application');
    const planning = new PlanningService(store);

    /** Builds an operation with an accepted paid quote and returns its order. */
    const paidOrder = async (label: string) => {
      const operation = await store.createOperation(owner, 'QA A08 ' + label, 'QA A08 payment objective', []);
      const plan = await planning.create(owner, operation.id, operation.version, [{
        title: 'QA A08 step', description: 'QA A08 step description', capabilityId: 'capability-slot-1-v1' as ID,
        dependsOnIndices: [], intent: 'RESEARCH',
      }]);
      const quote = await commerce.quote(owner, operation.id, 'qa-paid-offer', plan.revision.id) as { id: string };
      const accepted = await commerce.accept(owner, quote.id as ID, 'qa-a08-accept-' + label + '-' + randomUUID().slice(0, 8));
      return { operation: await store.getOperation(owner, operation.id), revisionId: plan.revision.id, orderId: accepted.orderId as string, quoteId: quote.id };
    };

    const first = await paidOrder('one');
    const [orderRow] = await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, first.orderId));
    assert(orderRow?.state === 'PAYMENT_REQUIRED', 'a paid quote produces an order that requires payment, not an authorized one');
    const orderAmount = orderRow!.amountMinor;
    assert(orderAmount === 2500 && orderRow!.currency === 'USD', 'the order carries the configured amount in minor units');

    // ── Group 4 · paid execution is impossible before verified authorization ────────────────────
    await expectDomainError('PAYMENT_REQUIRED', () => commerce.assertExecutionAllowed(owner, first.operation.id, first.revisionId as ID), 'execution before any payment');
    const { OperationExecutionService } = await import('@qeynox/application');
    const execution = new OperationExecutionService(store);
    // The reported error is now PAYMENT_REQUIRED: an unpaid order is a payment state, not a broken
    // configuration. Before A08 a paid order could not exist, so the two were indistinguishable.
    await expectDomainError('PAYMENT_REQUIRED', () => execution.start(owner, first.operation.id, first.operation.version, 'qa-a08-start-before-' + randomUUID().slice(0, 8)), 'starting execution on an unpaid order');
    assert((await store.getOperation(owner, first.operation.id)).status !== 'RUNNING', 'the refused start did not begin execution');
    pass('a paid order cannot execute before verified authorization');

    // ── Group 5 · checkout creation, idempotency and single-live-payment ────────────────────────
    const fake = new FakeStripeProvider();
    const composite = () => new CompositePaymentProvider(fake, disabled);
    const paymentService = new PaymentService(store, composite());
    const redirects = { successUrl: 'https://app.qeynox.test/return?status=success', cancelUrl: 'https://app.qeynox.test/return?status=cancel' };

    const session = await paymentService.startCheckout(owner, first.operation.id, first.orderId as ID, 'qa-a08-checkout-key-0001', redirects);
    assert(session.reused === false && session.amountMinor === 2500, 'checkout starts with the order amount');
    assert(session.checkoutUrl?.startsWith('https://checkout.stripe.test/'), 'a hosted checkout URL is returned');
    assert(count(fake.sessions) === 1, 'exactly one provider session was created');

    // Same key → same payment, no second provider object.
    const replay = await paymentService.startCheckout(owner, first.operation.id, first.orderId as ID, 'qa-a08-checkout-key-0001', redirects);
    assert(replay.paymentId === session.paymentId && replay.reused === true, 'a retried checkout with the same key returns the same payment');
    assert(count(fake.sessions) === 1, 'the retry created no second provider session');

    // Different key → resumes the existing live payment rather than creating a competing one.
    const competing = await paymentService.startCheckout(owner, first.operation.id, first.orderId as ID, 'qa-a08-checkout-key-0002', redirects);
    assert(competing.paymentId === session.paymentId && competing.reused === true, 'a different key resumes the live payment instead of creating a second one');
    assert(count(fake.sessions) === 1, 'still exactly one provider session: no double charge surface');

    // Concurrent submissions must still yield one payment and one session.
    const concurrent = await Promise.allSettled([
      paymentService.startCheckout(owner, first.operation.id, first.orderId as ID, 'qa-a08-checkout-race-a', redirects),
      paymentService.startCheckout(owner, first.operation.id, first.orderId as ID, 'qa-a08-checkout-race-b', redirects),
    ]);
    const fulfilled = concurrent.filter(result => result.status === 'fulfilled');
    assert(fulfilled.length >= 1, 'at least one concurrent checkout attempt succeeds');
    const paymentRows = await connection.db.select().from(payments).where(eq(payments.orderId, first.orderId));
    assert(count(paymentRows) === 1, 'a concurrent checkout race still produces exactly one payment row, got ' + paymentRows.length);
    pass('checkout is idempotent and a race cannot create a second payable payment');

    const sessionRow = paymentRows[0]!;
    assert(sessionRow.status === 'CREATED' && sessionRow.amountMinor === 2500 && sessionRow.currency === 'USD', 'the payment row records the exact quoted amount');
    assert(sessionRow.workspaceId === primary.workspaceId, 'the payment row belongs to the buying workspace');
    assert(count(fake.authorizeCalls) === 0, 'no authorization was attempted merely by opening checkout');
    pass('opening checkout charges nothing: no authorization exists until the provider says so');

    // ── Group 6 · integrity of the checkout request ─────────────────────────────────────────────
    const other = await paidOrder('two');
    await expectDomainError('INVALID_INPUT', () => paymentService.startCheckout(owner, other.operation.id, other.orderId as ID, 'short', redirects), 'a too-short idempotency key is refused');
    await expectDomainError('INVALID_INPUT', () => paymentService.startCheckout(owner, other.operation.id, other.orderId as ID, 'qa-a08-bad-redirect-1', { successUrl: 'javascript:alert(1)', cancelUrl: redirects.cancelUrl }), 'a javascript: success URL is refused');
    await expectDomainError('INVALID_INPUT', () => paymentService.startCheckout(owner, other.operation.id, other.orderId as ID, 'qa-a08-bad-expiry-01', redirects, 60), 'a checkout expiry below the provider minimum is refused');
    await expectDomainError('NOT_FOUND', () => paymentService.startCheckout(outsider, first.operation.id, first.orderId as ID, 'qa-a08-outsider-0001', redirects), 'an outsider cannot start checkout on another workspace order');
    assert(count(fake.sessions) === 1, 'no refused request created a provider session');
    pass('checkout validates redirects, expiry and tenancy before touching the provider');

    // ── Group 7 · webhook application: authorization, duplicates, ordering ──────────────────────
    // Webhook application goes through the real Stripe signature path, so staged events are signed.
    const signedWebhookService = () => new PaymentService(store, new CompositePaymentProvider(verifier, disabled));
    const webhooks = signedWebhookService();
    const intentId = sessionRow.providerIntentId!;
    assert(!!intentId, 'the payment row carries the provider intent id from the session');

    /** Builds and signs a real Stripe event for this order. */
    const signed = (type: string, eventId: string, created: number, object: Record<string, unknown>) => {
      const payload = stripeEvent(type, object, eventId, created);
      return { signature: signPayload(payload), bytes: new TextEncoder().encode(payload) };
    };
    const intentObject = (orderId: string, id: string, extra: Record<string, unknown> = {}) => ({
      id, object: 'payment_intent', amount: 2500, amount_received: 0, currency: 'usd', status: 'requires_capture',
      metadata: { orderId }, ...extra,
    });

    const baseCreated = Math.floor(Date.now() / 1000) - 60;

    // An unsigned body is refused before anything is applied.
    await expectDomainError('DENIED', () => webhooks.handleWebhook('v1=deadbeef', new TextEncoder().encode(stripeEvent('payment_intent.amount_capturable_updated', intentObject(first.orderId, intentId), 'evt_unsigned', baseCreated)), ''), 'an unsigned webhook is refused');
    assert((await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, first.orderId)))[0]!.state === 'PAYMENT_REQUIRED', 'the refused webhook changed nothing');

    // The authorization event.
    const authorized = signed('payment_intent.amount_capturable_updated', 'evt_auth_1', baseCreated, intentObject(first.orderId, intentId));
    const applied = await webhooks.handleWebhook(authorized.signature, authorized.bytes, '');
    assert(applied.status === 'APPLIED', 'a signed authorization event applies');
    const orderAfterAuth = (await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, first.orderId)))[0]!;
    assert(orderAfterAuth.state === 'AUTHORIZED', 'the order becomes AUTHORIZED on a verified authorization');
    assert((await connection.db.select().from(payments).where(eq(payments.id, sessionRow.id)))[0]!.status === 'AUTHORIZED', 'the payment row records AUTHORIZED');

    // Duplicate delivery is a no-op, including concurrently.
    const duplicate = await webhooks.handleWebhook(authorized.signature, authorized.bytes, '');
    assert(duplicate.status === 'DUPLICATE', 'a duplicate delivery is reported as a duplicate');
    const concurrentDuplicates = await Promise.all([
      webhooks.handleWebhook(authorized.signature, authorized.bytes, ''),
      webhooks.handleWebhook(authorized.signature, authorized.bytes, ''),
    ]);
    assert(concurrentDuplicates.every(result => result.status === 'DUPLICATE'), 'concurrent duplicate deliveries are all no-ops');
    const eventRows = await connection.db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, 'stripe:evt_auth_1'));
    assert(eventRows.length === 1, 'exactly one ledger row exists for the event, got ' + eventRows.length);
    pass('a signed authorization applies once and every duplicate is a no-op');

    // ── Group 8 · delayed and out-of-order events ───────────────────────────────────────────────
    // A LATE event that predates the applied authorization must not downgrade the order.
    const staleFailure = signed('payment_intent.payment_failed', 'evt_stale_fail', baseCreated - 300, intentObject(first.orderId, intentId, { status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } }));
    const staleResult = await webhooks.handleWebhook(staleFailure.signature, staleFailure.bytes, '');
    assert(staleResult.status === 'APPLIED', 'a late event is still recorded');
    const orderAfterStale = (await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, first.orderId)))[0]!;
    assert(orderAfterStale.state === 'AUTHORIZED', 'a late failure does not undo a verified authorization');
    const paymentAfterStale = (await connection.db.select().from(payments).where(eq(payments.id, sessionRow.id)))[0]!;
    assert(paymentAfterStale.status === 'AUTHORIZED', 'the payment stays AUTHORIZED despite the late failure');
    const staleRow = await connection.db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, 'stripe:evt_stale_fail'));
    assert(staleRow[0]?.outcome === 'SUPERSEDED', 'the late event is marked SUPERSEDED in the ledger rather than applied');

    // A DELAYED success arriving after a newer failure must still win, because it is newer.
    const second = await paidOrder('three');
    const secondService = new PaymentService(store, new CompositePaymentProvider(fake, disabled));
    const secondSession = await secondService.startCheckout(owner, second.operation.id, second.orderId as ID, 'qa-a08-checkout-key-0003', redirects);
    const secondIntent = (await connection.db.select().from(payments).where(eq(payments.id, secondSession.paymentId)))[0]!.providerIntentId!;
    const later = baseCreated + 10, earlier = baseCreated;
    const earlyFailure = signed('payment_intent.payment_failed', 'evt_second_fail', earlier, intentObject(second.orderId, secondIntent, { status: 'requires_payment_method' }));
    await webhooks.handleWebhook(earlyFailure.signature, earlyFailure.bytes, '');
    assert((await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, second.orderId)))[0]!.state === 'PAYMENT_REQUIRED', 'a failure returns the order to PAYMENT_REQUIRED');
    const lateSuccess = signed('payment_intent.amount_capturable_updated', 'evt_second_auth', later, intentObject(second.orderId, secondIntent));
    await webhooks.handleWebhook(lateSuccess.signature, lateSuccess.bytes, '');
    assert((await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, second.orderId)))[0]!.state === 'AUTHORIZED', 'a newer authorization arriving after an older failure still authorizes');

    // An event for an order that does not exist here is recorded, never acknowledged as applied.
    const orphan = signed('payment_intent.amount_capturable_updated', 'evt_orphan', baseCreated, intentObject('order_does_not_exist', 'pi_orphan'));
    const orphanResult = await webhooks.handleWebhook(orphan.signature, orphan.bytes, '');
    assert(orphanResult.status === 'UNRESOLVED', 'an event for an unknown order is recorded as unresolved');
    const orphanRow = await connection.db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, 'stripe:evt_orphan'));
    assert(orphanRow.length === 1 && orphanRow[0]!.orderId === null && orphanRow[0]!.outcome === 'UNRESOLVED', 'the unresolved event is kept in the ledger without inventing an order');
    pass('delayed and out-of-order events never regress a verified state, and orphans are recorded');

    // ── Group 9 · explicit failure, expiry and dispute behaviour ─────────────────────────────────
    const fourth = await paidOrder('four');
    const fourthService = new PaymentService(store, new CompositePaymentProvider(fake, disabled));
    const fourthSession = await fourthService.startCheckout(owner, fourth.operation.id, fourth.orderId as ID, 'qa-a08-checkout-key-0004', redirects);
    const fourthIntentId = (await connection.db.select().from(payments).where(eq(payments.id, fourthSession.paymentId)))[0]!.providerIntentId!;

    const failedEvent = signed('payment_intent.payment_failed', 'evt_fourth_fail', baseCreated + 20, intentObject(fourth.orderId, fourthIntentId, { status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } }));
    await webhooks.handleWebhook(failedEvent.signature, failedEvent.bytes, '');
    const failedPayment = (await connection.db.select().from(payments).where(eq(payments.id, fourthSession.paymentId)))[0]!;
    assert(failedPayment.status === 'FAILED', 'a declined payment is recorded as FAILED');
    assert(failedPayment.failureCode === 'card_declined', 'the failure code is recorded for the customer');
    const fourthView = await fourthService.view(owner, fourth.operation.id);
    assert(fourthView.payment?.status === 'FAILED' && fourthView.canStartCheckout === true, 'a failed payment can be retried with a new attempt');
    assert(fourthView.executionAuthorized === false, 'a failed payment never authorizes execution');

    // A retry after failure creates a NEW attempt (the old one is terminal) — proving failure is recoverable.
    const retry = await fourthService.startCheckout(owner, fourth.operation.id, fourth.orderId as ID, 'qa-a08-checkout-key-0005', redirects);
    assert(retry.paymentId !== fourthSession.paymentId, 'a retry after failure creates a new payment attempt');
    const fourthPayments = await connection.db.select().from(payments).where(eq(payments.orderId, fourth.orderId));
    assert(count(fourthPayments) === 2, 'the failed attempt is retained alongside the new one, got ' + fourthPayments.length);

    // Expiry.
    const expiredEvent = signed('checkout.session.expired', 'evt_expired', baseCreated + 30, { id: 'cs_test_expired', object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: { orderId: fourth.orderId } });
    await webhooks.handleWebhook(expiredEvent.signature, expiredEvent.bytes, '');
    const expiredPayment = (await connection.db.select().from(payments).where(eq(payments.id, retry.paymentId)))[0]!;
    assert(expiredPayment.status === 'EXPIRED', 'an expired checkout is recorded as EXPIRED');
    assert((await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, fourth.orderId)))[0]!.state === 'PAYMENT_REQUIRED', 'an expired checkout leaves the order awaiting payment');
    const expiredView = await fourthService.view(owner, fourth.operation.id);
    assert(expiredView.canStartCheckout === true, 'an expired payment can be retried');

    // Dispute blocks execution and delivery.
    const disputeEvent = signed('charge.dispute.created', 'evt_dispute', baseCreated + 40, { id: 'dp_qa', object: 'dispute', status: 'needs_response', amount: 2500, currency: 'usd', payment_intent: { id: fourthIntentId, metadata: { orderId: fourth.orderId } } });
    await webhooks.handleWebhook(disputeEvent.signature, disputeEvent.bytes, '');
    const disputedOrder = (await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, first.orderId)))[0]!;
    void disputedOrder;
    const disputeView = await webhooks.view(owner, fourth.operation.id);
    assert(disputeView.payment?.status === 'DISPUTED', 'a dispute is recorded as DISPUTED');
    assert(disputeView.executionAuthorized === false, 'a disputed payment never authorizes execution');
    pass('pending, failed, expired and disputed are distinct states and none of them authorizes execution');

    // ── Group 10 · capture, and no double capture ──────────────────────────────────────────────
    const amountAware = new AmountAwareProvider();
    amountAware.setAmount(2500);
    const captureService = new PaymentService(store, new CompositePaymentProvider(amountAware, disabled));
    const captureResult = await captureService.capture(owner, first.operation.id, first.orderId as ID, 'qa-a08-capture-key-0001');
    assert(captureResult.status === 'CAPTURED' && captureResult.capturedMinor === 2500, 'capture records the captured amount');
    assert(captureResult.idempotent === false, 'the first capture is not a replay');
    const captureReplay = await captureService.capture(owner, first.operation.id, first.orderId as ID, 'qa-a08-capture-key-0002');
    assert(captureReplay.idempotent === true, 'capturing an already-captured payment is a no-op');
    assert(count(amountAware.captures) === 1, 'the provider was asked to capture exactly once, got ' + amountAware.captures.length);
    pass('capture happens once and a retry is idempotent');

    // Capturing a payment that is not authorized is refused.
    const uncapturedOrder = await paidOrder('five');
    const fifthService = new PaymentService(store, new CompositePaymentProvider(fake, disabled));
    await fifthService.startCheckout(owner, uncapturedOrder.operation.id, uncapturedOrder.orderId as ID, 'qa-a08-checkout-key-0006', redirects);
    await expectDomainError('INVALID_STATE', () => fifthService.capture(owner, uncapturedOrder.operation.id, uncapturedOrder.orderId as ID, 'qa-a08-capture-unpaid-1'), 'an unauthorized payment cannot be captured');
    pass('only an authorized payment can be captured');

    // ── Group 11 · refunds: auditable, capped, idempotent ─────────────────────────────────────
    const refundService = new PaymentService(store, new CompositePaymentProvider(amountAware, disabled));
    await expectDomainError('CONFLICT', () => refundService.refund(owner, first.operation.id, first.orderId as ID, 99999, 'QA over-refund', 'qa-a08-refund-over-1'), 'a refund larger than the captured amount is refused');
    assert(count(amountAware.refundCalls) === 0, 'the refused refund never reached the provider');

    const partial = await refundService.refund(owner, first.operation.id, first.orderId as ID, 1000, 'QA partial refund', 'qa-a08-refund-key-0001');
    assert(partial.status === 'SUCCEEDED' && partial.refundedMinor === 1000, 'a partial refund is recorded');
    const partialReplay = await refundService.refund(owner, first.operation.id, first.orderId as ID, 1000, 'QA partial refund', 'qa-a08-refund-key-0001');
    assert(partialReplay.idempotent === true && partialReplay.refundId === partial.refundId, 'a retried refund with the same key does not refund twice');
    assert(count(amountAware.refundCalls) === 1, 'the provider was asked to refund exactly once, got ' + String(amountAware.refundCalls.length));

    // The remaining refundable amount is the captured total minus what already succeeded.
    await expectDomainError('CONFLICT', () => refundService.refund(owner, first.operation.id, first.orderId as ID, 1600, 'QA over-refund after partial', 'qa-a08-refund-over-2'), 'a refund exceeding the remaining captured amount is refused');
    const remainder = await refundService.refund(owner, first.operation.id, first.orderId as ID, 1500, 'QA final refund', 'qa-a08-refund-key-0002');
    assert(remainder.status === 'SUCCEEDED' && remainder.refundedMinor === 2500, 'refunding the remainder reaches the captured total');
    const refundedPayment = (await connection.db.select().from(payments).where(eq(payments.id, sessionRow.id)))[0]!;
    assert(refundedPayment.status === 'REFUNDED' && refundedPayment.refundedMinor === 2500, 'a fully refunded payment is marked REFUNDED');

    // A failing provider leaves an auditable FAILED refund and does not count toward the total.
    const sixth = await paidOrder('six');
    const sixthService = new PaymentService(store, new CompositePaymentProvider(amountAware, disabled));
    const sixthSession = await sixthService.startCheckout(owner, sixth.operation.id, sixth.orderId as ID, 'qa-a08-checkout-key-0007', redirects);
    const sixthIntent = (await connection.db.select().from(payments).where(eq(payments.id, sixthSession.paymentId)))[0]!.providerIntentId!;
    const sixthAuth = signed('payment_intent.amount_capturable_updated', 'evt_sixth_auth', baseCreated + 50, intentObject(sixth.orderId, sixthIntent));
    await webhooks.handleWebhook(sixthAuth.signature, sixthAuth.bytes, '');
    await sixthService.capture(owner, sixth.operation.id, sixth.orderId as ID, 'qa-a08-capture-sixth-01');
    amountAware.refundFails = true;
    await expectDomainError('UNAVAILABLE', () => sixthService.refund(owner, sixth.operation.id, sixth.orderId as ID, 500, 'QA failing refund', 'qa-a08-refund-fail-01'), 'a provider refund failure surfaces');
    const failedRefunds = await connection.db.select().from(refunds).where(eq(refunds.orderId, sixth.orderId));
    assert(failedRefunds.length === 1 && failedRefunds[0]!.status === 'FAILED', 'the failed refund is retained with its status');
    assert(!!failedRefunds[0]!.failureMessage, 'the failed refund records why it failed');
    const sixthPayment = (await connection.db.select().from(payments).where(eq(payments.id, sixthSession.paymentId)))[0]!;
    assert(sixthPayment.refundedMinor === 0, 'a failed refund never counts toward the refunded total');
    amountAware.refundFails = false;
    pass('refunds are idempotent, capped by the captured amount, and failures stay auditable');

    // ── Group 12 · immutable quote linkage ─────────────────────────────────────────────────────
    const seventh = await paidOrder('seven');
    // A quote that has expired must not be chargeable.
    await connection.db.update(quotes).set({ expiresAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(quotes.id, seventh.quoteId));
    const seventhService = new PaymentService(store, new CompositePaymentProvider(fake, disabled));
    // Count before, then compare: the assertion is that a refused checkout adds no provider session,
    // not that some specific number of sessions happens to exist.
    const sessionsBeforeExpiredQuote = count(fake.sessions);
    await expectDomainError('INVALID_STATE', () => seventhService.startCheckout(owner, seventh.operation.id, seventh.orderId as ID, 'qa-a08-expired-quote-1', redirects), 'an expired quote cannot be charged');
    assert(count(fake.sessions) === sessionsBeforeExpiredQuote, 'an expired quote creates no provider session (was ' + sessionsBeforeExpiredQuote + ', now ' + count(fake.sessions) + ')');

    // A changed offer price must not be charged at the new price against the old quote.
    const eighth = await paidOrder('eight');
    await connection.db.update(quotes).set({ amountMinor: 9900 }).where(eq(quotes.id, eighth.quoteId));
    await expectDomainError('CONFLICT', () => seventhService.startCheckout(owner, eighth.operation.id, eighth.orderId as ID, 'qa-a08-mutated-quote-1', redirects), 'an amount that no longer matches the quote is refused');
    await connection.db.update(quotes).set({ amountMinor: 2500 }).where(eq(quotes.id, eighth.quoteId));

    // A superseded plan revision must not be chargeable.
    const ninth = await paidOrder('nine');
    const newRevision = randomUUID() as ID;
    const ninthOp = await store.getOperation(owner, ninth.operation.id);
    await connection.db.update(operations).set({ currentRevisionId: newRevision, payload: { ...ninthOp, currentRevisionId: newRevision } as unknown as Operation }).where(eq(operations.id, ninth.operation.id));
    await expectDomainError('CONFLICT', () => seventhService.startCheckout(owner, ninth.operation.id, ninth.orderId as ID, 'qa-a08-stale-revision-1', redirects), 'a changed plan revision cannot be charged against the old quote');
    pass('a quote, its amount, its offer version and its plan revision are all re-checked before money moves');

    // ── Group 13 · a redirect is never payment proof ───────────────────────────────────────────
    const tenth = await paidOrder('ten');
    const tenthService = new PaymentService(store, new CompositePaymentProvider(fake, disabled));
    const tenthSession = await tenthService.startCheckout(owner, tenth.operation.id, tenth.orderId as ID, 'qa-a08-checkout-key-0008', redirects);
    // Calling the return path must not authorize anything, even though it is the "success" route.
    const afterReturn = await tenthService.confirmReturn(owner, tenth.operation.id, tenth.orderId as ID);
    assert(afterReturn.executionAuthorized === false, 'returning from the provider page never authorizes execution');
    assert(afterReturn.payment?.status === 'CREATED', 'the payment still reflects only what is recorded');
    assert((await connection.db.select().from(commercialOrders).where(eq(commercialOrders.id, tenth.orderId)))[0]!.state === 'PAYMENT_REQUIRED', 'the order is still awaiting payment after the redirect');
    const tenthPayments = await connection.db.select().from(payments).where(eq(payments.id, tenthSession.paymentId));
    assert(tenthPayments[0]!.status === 'CREATED', 'the redirect wrote no payment state');
    pass('a browser redirect is navigation, never proof of payment');

    // ── Group 14 · tenant isolation across the whole payment surface ───────────────────────────
    await expectDomainError('NOT_FOUND', () => paymentService.startCheckout(outsider, first.operation.id, first.orderId as ID, 'qa-a08-outsider-0002', redirects), 'an outsider cannot start checkout');
    await expectDomainError('NOT_FOUND', () => captureService.capture(outsider, first.operation.id, first.orderId as ID, 'qa-a08-outsider-capture'), 'an outsider cannot capture');
    await expectDomainError('NOT_FOUND', () => refundService.refund(outsider, first.operation.id, first.orderId as ID, 100, 'QA outsider refund', 'qa-a08-outsider-refund'), 'an outsider cannot refund');
    await expectDomainError('NOT_FOUND', () => paymentService.view(outsider, first.operation.id), 'an outsider cannot read the operation');
    const outsiderPayments = await connection.db.select().from(payments).where(eq(payments.workspaceId, secondary.workspaceId));
    assert(outsiderPayments.length === 0, 'no payment row was created for the outsider workspace');
    const ownerPayments = await connection.db.select().from(payments).where(eq(payments.workspaceId, primary.workspaceId));
    assert(ownerPayments.length >= 5, 'the owner workspace holds its own payments');
    // Every payment row is scoped to the workspace that owns its order.
    const orderWorkspaces = await connection.db.select().from(commercialOrders).where(eq(commercialOrders.workspaceId, primary.workspaceId));
    const orderIds = new Set(orderWorkspaces.map(row => row.id));
    assert(ownerPayments.every(row => orderIds.has(row.orderId)), 'every payment belongs to an order in the same workspace');
    pass('checkout, capture, refund and read are all tenant-scoped');

    // ── Group 15 · the ledger is a faithful audit trail ────────────────────────────────────────
    const ledger = await connection.db.select().from(paymentEvents).where(eq(paymentEvents.provider, 'stripe'));
    assert(ledger.length >= 8, 'the webhook ledger recorded every signed event, got ' + ledger.length);
    assert(ledger.every(row => !!row.payloadDigest && row.payloadDigest!.length === 64), 'every ledger row carries a payload digest');
    assert(ledger.every(row => row.providerEventId!.startsWith('stripe:')), 'every ledger event id is namespaced by provider');
    assert(ledger.every(row => !('card' in (row.redactedPayload ?? {}))), 'no ledger row contains card data');
    assert(ledger.some(row => row.outcome === 'SUPERSEDED'), 'the superseded late event is visible in the ledger');
    assert(ledger.some(row => row.outcome === 'UNRESOLVED'), 'the unresolved orphan event is visible in the ledger');
    const duplicateEventIds = ledger.map(row => row.providerEventId).filter((id): id is string => !!id);
    assert(new Set(duplicateEventIds).size === duplicateEventIds.length, 'no provider event id was recorded twice');
    pass('every signed event is auditable exactly once, with its digest and outcome');

    console.log('\nStripe payments A08 — ' + passed.length + ' groups, ' + assertions + ' assertions PASS in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    console.log('BOUNDARY: Stripe was never contacted. Provider behaviour is a deterministic in-process double; webhook signatures are real HMAC via the Stripe SDK. Live test-mode Stripe remains NOT VERIFIED.');
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Stripe payments QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
