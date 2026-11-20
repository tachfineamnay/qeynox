import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { DomainError } from '@qeynox/domain';
import type {
  CheckoutSession, CheckoutSessionRequest, PaymentIntentRequest, PaymentPort, PaymentReceipt,
  ProviderIntentState, VerifiedPaymentEvent,
} from './payments';

/**
 * MISSION A08 — Stripe adapter for the existing PaymentPort.
 *
 * Deliberately narrow. It owns exactly one responsibility: turning a provider call into a receipt that
 * states what the provider actually confirmed. It holds no commercial state, decides no order state and
 * never authorizes execution — that belongs to PaymentService, which records every decision in the
 * database and is the only thing execution trusts.
 *
 * Rules enforced here rather than trusted from callers:
 * - the amount is reconciled against the amount requested. A provider that authorizes a different
 *   amount is a hard failure, never a silent success, because charging the wrong amount is worse than
 *   charging nothing;
 * - a browser redirect is never proof of payment. Only a webhook-signed event or a direct provider read
 *   can produce AUTHORIZED or CAPTURED;
 * - live keys are refused. Test-mode keys are the only ones this adapter will construct with, so a
 *   misconfigured environment cannot process a real payment.
 */

/** Sandbox/test-mode key prefixes. Anything else is refused at construction time. */
const TEST_KEY_PREFIXES = ['sk_test_', 'rk_test_'] as const;
/** Marker required to accept `pk_test_`-style public keys only for redirect sessions. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeAdapterConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** Pinned API version so a provider-side default change cannot alter payload shapes under us. */
  readonly apiVersion?: string;
}

function assertTestModeKey(secretKey: string): void {
  if (!secretKey) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Stripe secret key is not configured');
  if (!TEST_KEY_PREFIXES.some(prefix => secretKey.startsWith(prefix))) {
    // Fail closed and say exactly why: a live key in a development environment is an incident.
    throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Stripe key is not a test-mode key; live payments are refused');
  }
}

function mapIntentStatus(status: string | undefined): PaymentReceipt['status'] | undefined {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return undefined; // Not money yet — never reported as authorized.
    case 'processing':
      return 'AUTHORIZED';
    case 'requires_capture':
      return 'AUTHORIZED';
    case 'succeeded':
      return 'CAPTURED';
    case 'canceled':
      return 'FAILED';
    default:
      return undefined;
  }
}

export class StripePaymentProvider implements PaymentPort {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: StripeAdapterConfig) {
    assertTestModeKey(config.secretKey);
    if (!config.webhookSecret) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Stripe webhook secret is not configured');
    this.webhookSecret = config.webhookSecret;
    this.stripe = new Stripe(config.secretKey, {
      // Pinned. A provider-side default change must never silently alter the payload shapes this
      // adapter parses, because those shapes decide whether a payment is recorded as verified.
      apiVersion: (config.apiVersion ?? '2026-11-18.endive') as Stripe.LatestApiVersion,
      // Retries are owned by our idempotency keys, not by the SDK, so the caller always learns the real
      // outcome instead of a transport-level guess that could conceal a double submit.
      maxNetworkRetries: 0,
      timeout: 20_000,
    });
  }

  async authorize(request: PaymentIntentRequest): Promise<PaymentReceipt> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: request.amountMinor,
        currency: request.currency.toLowerCase(),
        // Manual capture: authorization and capture are separate, auditable steps. Money is never
        // taken merely because a customer opened the checkout page.
        capture_method: 'manual',
        // The local order id travels with the intent so a webhook can be resolved without trusting
        // any client-supplied value.
        metadata: { orderId: request.orderId },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: request.idempotencyKey },
    );
    return this.receiptOf(intent, request);
  }

  async capture(intentId: string, idempotencyKey: string): Promise<PaymentReceipt> {
    const intent = await this.stripe.paymentIntents.capture(intentId, {}, { idempotencyKey });
    return this.receiptOf(intent, { amountMinor: intent.amount ?? 0, currency: intent.currency.toUpperCase() });
  }

  async refund(captureId: string, amountMinor: number, idempotencyKey: string): Promise<PaymentReceipt> {
    const refund = await this.stripe.refunds.create(
      { payment_intent: captureId, amount: amountMinor },
      { idempotencyKey },
    );
    return {
      providerId: refund.id,
      status: refund.status === 'succeeded' ? 'CAPTURED' : refund.status === 'failed' ? 'FAILED' : 'CAPTURED',
      amountMinor: refund.amount,
      currency: refund.currency.toUpperCase(),
    };
  }

  /**
   * Signature verification.
   *
   * The raw bytes are what was signed, so this takes the exact request body. Anything reconstructible
   * from parsed JSON would be a different byte string and must never be accepted. The timestamp
   * tolerance is applied by the SDK, which is what makes a replayed old delivery fail.
   */
  async verifyWebhook(signature: string, payload: Uint8Array): Promise<{ eventId: string; orderId: string; kind: string }> {
    const event = this.constructVerifiedEvent(signature, payload);
    return { eventId: event.eventId, orderId: event.orderId ?? '', kind: event.kind };
  }

  /** Full verification used by the payment surface; verifyWebhook keeps the original narrow shape. */
  async verifyEvent(signature: string, payload: Uint8Array): Promise<VerifiedPaymentEvent> {
    return this.constructVerifiedEvent(signature, payload);
  }

  constructVerifiedEvent(signature: string, payload: Uint8Array): VerifiedPaymentEvent {
    if (!signature) throw new DomainError('DENIED', 'Missing provider signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        Buffer.from(payload),
        signature,
        this.webhookSecret,
        SIGNATURE_TOLERANCE_SECONDS,
      ) as Stripe.Event;
    } catch (error: unknown) {
      // Never echo the provider's message: it can contain fragments of the payload or the secret check.
      throw new DomainError('DENIED', 'Provider signature verification failed' + (error instanceof Error ? '' : ''));
    }
    const object = event.data.object as unknown as Record<string, unknown>;
    const kind = this.kindOf(event.type);
    const orderId = this.orderIdOf(event.type, object);
    const paymentIntentId = typeof object.id === 'string' && event.type.startsWith('payment_intent.') ? object.id : undefined;
    const sessionId = typeof object.id === 'string' && event.type.startsWith('checkout.session.') ? object.id : undefined;
    return {
      eventId: event.id,
      type: event.type,
      created: event.created,
      kind,
      orderId,
      paymentIntentId,
      sessionId: sessionId ?? (typeof object.payment_intent === 'string' ? object.payment_intent : undefined),
      summary: this.summaryOf(event.type, object),
    };
  }

  /** Direct provider read. Used only to reconcile, never to shortcut a missing webhook. */
  async reconcile(orderId: string): Promise<PaymentReceipt | undefined> {
    const search = await this.stripe.paymentIntents.search({
      query: `metadata['orderId']:'${orderId.replace(/'/g, '')}'`,
      limit: 10,
    });
    const intents = [...search.data].sort((a, b) => b.created - a.created);
    const intent = intents[0];
    if (!intent) return undefined;
    const status = mapIntentStatus(intent.status);
    if (!status) return undefined;
    return {
      providerId: intent.id,
      status,
      amountMinor: intent.amount_received || intent.amount,
      currency: intent.currency.toUpperCase(),
    };
  }

  async retrieveIntent(intentId: string): Promise<ProviderIntentState> {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    return {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      amountReceived: intent.amount_received,
      currency: intent.currency.toUpperCase(),
      orderId: intent.metadata?.orderId,
    };
  }

  /** Creates the hosted checkout page. A returned URL is where the customer goes, never a payment proof. */
  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        // Card data never touches QeyNox: the customer is redirected to the provider's hosted page.
        line_items: [{
          quantity: 1,
          price_data: {
            currency: request.currency.toLowerCase(),
            unit_amount: request.amountMinor,
            product_data: { name: 'QeyNox scoped RaaS deliverable' },
          },
        }],
        // Manual capture keeps authorization and capture as two auditable steps.
        payment_intent_data: { capture_method: 'manual', metadata: { orderId: request.orderId } },
        metadata: { orderId: request.orderId, paymentId: request.paymentId },
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        // Checkout refuses to complete after this, which is the provider-side half of expiry handling.
        expires_at: Math.floor(Date.now() / 1000) + request.expiresInSeconds,
        client_reference_id: request.paymentId,
      },
      { idempotencyKey: request.idempotencyKey },
    );
    const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    return { sessionId: session.id, url: session.url, intentId: intent, expiresAt: session.expires_at };
  }

  private receiptOf(intent: Stripe.PaymentIntent, expected: { amountMinor: number; currency: string }): PaymentReceipt {
    const status = mapIntentStatus(intent.status);
    if (!status) {
      // A not-yet-authorizable intent is never dressed up as success.
      throw new DomainError('UNKNOWN_OUTCOME', 'Provider intent is not in an authorized or captured state: ' + intent.status);
    }
    if (intent.amount !== expected.amountMinor) {
      throw new DomainError('CONFLICT', 'Provider amount does not match the quoted amount');
    }
    if (intent.currency.toUpperCase() !== expected.currency.toUpperCase()) {
      throw new DomainError('CONFLICT', 'Provider currency does not match the quoted currency');
    }
    return { providerId: intent.id, status, amountMinor: intent.amount, currency: intent.currency.toUpperCase() };
  }

  private kindOf(type: string): string {
    switch (type) {
      case 'payment_intent.requires_action':
      case 'checkout.session.completed':
        return 'REQUIRES_ACTION';
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.processing':
        return 'AUTHORIZED';
      case 'payment_intent.succeeded':
      case 'charge.succeeded':
        return 'CAPTURED';
      case 'payment_intent.payment_failed':
        return 'FAILED';
      case 'payment_intent.canceled':
        return 'CANCELLED';
      case 'checkout.session.expired':
        return 'EXPIRED';
      case 'charge.refunded':
      case 'refund.updated':
        return 'REFUNDED';
      case 'charge.dispute.created':
        return 'DISPUTED';
      default:
        // Unrecognized events are still recorded (they are signed and real) but carry no state change.
        return 'IGNORED';
    }
  }

  private orderIdOf(type: string, object: Record<string, unknown>): string | undefined {
    const metadata = object.metadata as Record<string, string> | undefined;
    if (metadata?.orderId) return metadata.orderId;
    // A dispute arrives on a charge, whose metadata lives on the payment intent.
    const intent = object.payment_intent;
    if (intent && typeof intent === 'object') {
      const intentMetadata = (intent as Record<string, unknown>).metadata as Record<string, string> | undefined;
      if (intentMetadata?.orderId) return intentMetadata.orderId;
    }
    const charge = object.charge;
    if (charge && typeof charge === 'object') {
      const chargeMetadata = (charge as Record<string, unknown>).metadata as Record<string, string> | undefined;
      if (chargeMetadata?.orderId) return chargeMetadata.orderId;
    }
    return undefined;
  }

  /** A bounded, redacted summary. No names, no addresses, no card data, no raw payload. */
  private summaryOf(type: string, object: Record<string, unknown>): Record<string, string | number | boolean | null> {
    const amount = typeof object.amount === 'number' ? object.amount : typeof object.amount_received === 'number' ? object.amount_received : null;
    const currency = typeof object.currency === 'string' ? object.currency : null;
    const status = typeof object.status === 'string' ? object.status : null;
    const failureCode = (object.last_payment_error as Record<string, unknown> | undefined)?.code;
    return {
      type,
      amountMinor: amount,
      currency,
      status,
      // Whether a dispute is still open is the only dispute detail needed to gate execution.
      disputeStatus: type.startsWith('charge.dispute') ? status : null,
      failureCode: typeof failureCode === 'string' ? failureCode : null,
    };
  }
}

/**
 * Constant-time comparison helper.
 *
 * Provided for callers that verify a signature themselves; it exists so no part of the codebase has to
 * hand-roll `===` on a MAC. Length mismatch returns false without leaking timing about the prefix.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Unused by the adapter itself; exported so QA can prove a forged signature is rejected. */
export function signPayload(secret: string, payload: string, timestamp: number): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}
