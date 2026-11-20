import { DomainError } from '@qeynox/domain';

/**
 * The provider boundary for one-time payments.
 *
 * MISSION A08 widened this port from "authorize/capture/refund" to the operations a real checkout
 * actually performs. The widening is additive: `DisabledPaymentProvider` still fails closed on every
 * method, so an environment without a configured provider behaves exactly as before.
 *
 * Two invariants belong to the port itself, not to any provider:
 * - `refund` takes a *payment intent / capture id*, never a client-supplied amount that has not been
 *   checked against what was actually captured;
 * - `verifyWebhook` receives the raw request bytes and the signature header. A redirect is never an
 *   input here, because a redirect is never proof of payment.
 */
export interface PaymentIntentRequest {
  orderId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export type PaymentReceiptStatus = 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'DISPUTED';

export interface PaymentReceipt {
  providerId: string;
  status: PaymentReceiptStatus;
  amountMinor: number;
  currency: string;
}

export interface CheckoutSessionRequest {
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  expiresInSeconds: number;
}

export interface CheckoutSession {
  sessionId: string;
  /** The hosted page to send the customer to. Never treated as evidence that money moved. */
  url: string | null;
  intentId: string | undefined;
  expiresAt: number;
}

/** What a verified webhook tells us. `created` is the provider timestamp, the only stable ordering key. */
export interface VerifiedPaymentEvent {
  eventId: string;
  type: string;
  created: number;
  kind: string;
  orderId: string | undefined;
  paymentIntentId: string | undefined;
  sessionId: string | undefined;
  summary: Record<string, string | number | boolean | null>;
}

export interface ProviderIntentState {
  id: string;
  status: string;
  amount: number;
  amountReceived: number;
  currency: string;
  orderId: string | undefined;
}

export interface PaymentPort {
  authorize(request: PaymentIntentRequest): Promise<PaymentReceipt>;
  capture(intentId: string, idempotencyKey: string): Promise<PaymentReceipt>;
  refund(captureId: string, amountMinor: number, idempotencyKey: string): Promise<PaymentReceipt>;
  verifyWebhook(signature: string, payload: Uint8Array): Promise<{ eventId: string; orderId: string; kind: string }>;
  reconcile(orderId: string): Promise<PaymentReceipt | undefined>;
  /** Creates a hosted checkout session. Optional: a provider without a hosted page simply has none. */
  createCheckoutSession?(request: CheckoutSessionRequest): Promise<CheckoutSession>;
  /** Full signature verification, including the provider's own event type and payload summary. */
  verifyEvent?(signature: string, payload: Uint8Array): Promise<VerifiedPaymentEvent>;
  /** Direct provider read of one intent, used for reconciliation only. */
  retrieveIntent?(intentId: string): Promise<ProviderIntentState>;
}

/**
 * The deliberately disabled provider.
 *
 * Every method throws PAYMENT_NOT_CONFIGURED. It is the default in every environment, which is what
 * makes "no provider configured" a state the product reports rather than a state it guesses around.
 */
export class DisabledPaymentProvider implements PaymentPort {
  private fail(): never { throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Payment provider is not configured'); }
  // The parameters are declared, not ignored: a caller must be able to write `authorize(request)` against
  // the port, and the refusal must come from the provider rather than from a type error.
  async authorize(_request: PaymentIntentRequest): Promise<never> { return this.fail(); }
  async capture(_intentId: string, _idempotencyKey: string): Promise<never> { return this.fail(); }
  async refund(_captureId: string, _amountMinor: number, _idempotencyKey: string): Promise<never> { return this.fail(); }
  async verifyWebhook(_signature: string, _payload: Uint8Array): Promise<never> { return this.fail(); }
  async reconcile(_orderId: string): Promise<never> { return this.fail(); }
  async createCheckoutSession(_request: CheckoutSessionRequest): Promise<never> { return this.fail(); }
  async verifyEvent(_signature: string, _payload: Uint8Array): Promise<never> { return this.fail(); }
  async retrieveIntent(_intentId: string): Promise<never> { return this.fail(); }
}
