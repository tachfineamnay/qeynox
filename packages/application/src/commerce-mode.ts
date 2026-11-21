import { DomainError, type ID, type Principal } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import {
  CompositePaymentProvider, PaymentService,
  type PaymentReceiptView, type PaymentView, type ProviderReadView, type StartCheckoutResult,
} from './payment-service';
import type { CheckoutSessionRequest, PaymentIntentRequest, PaymentPort } from './payments';

/**
 * MISSION A21.01 — HARD PAYMENT FREEZE.
 *
 * `QEYNOX_COMMERCE_MODE` is the single, server-authoritative switch for whether QeyNox may move money.
 * In this release it has exactly two values and BOTH of them freeze payments:
 *
 * - `PAYMENTS_DISABLED` (default, also used when the variable is unset or empty): no checkout, capture,
 *   refund, or entitlement-changing reconciliation. Historical payment records remain readable.
 * - `BETA_FREE`: QeyNox is offered as a free beta. Still no financial transaction of any kind. The mode
 *   is reported to clients so they can say "free beta, nothing is charged" instead of "payments are not
 *   configured". Since MISSION A21.03 it enables exactly ONE entitlement, and only for workspaces holding
 *   an ACTIVE beta grant (A21.02): an accepted PRICED scope is covered by a separate, non-financial free
 *   beta execution authorization (`BetaExecutionAuthorizer`, order state `BETA_AUTHORIZED`, amount due
 *   now 0). No payment, invoice or checkout is created and the order is never PAID/CAPTURED/AUTHORIZED.
 *   Without an active grant, paid orders stay PAYMENT_REQUIRED exactly as before.
 *
 * Under `PAYMENTS_DISABLED` no beta authorization is created, and existing ones stop authorizing
 * execution or delivery (fail closed) until the mode is BETA_FREE again.
 *
 * There is deliberately no paid mode. Any other value (`PAID`, `STRIPE`, `LIVE`, …) is refused at boot
 * rather than interpreted, because a typo or an optimistic deployment must never be read as permission
 * to charge customers.
 *
 * WHAT A CONFIGURED STRIPE KEY DOES UNDER THE FREEZE: nothing. The composition below never constructs
 * `StripePaymentProvider`, never reads the Stripe credentials, and binds `PaymentService` to a provider
 * slot that is permanently empty. The Stripe adapter, the paid lifecycle in `PaymentService`, published
 * offer prices and every stored payment, order, refund and webhook-ledger row are preserved untouched
 * for a future, separately reviewed reactivation.
 */
export const COMMERCE_MODES = ['PAYMENTS_DISABLED', 'BETA_FREE'] as const;
export type CommerceMode = (typeof COMMERCE_MODES)[number];
export const DEFAULT_COMMERCE_MODE: CommerceMode = 'PAYMENTS_DISABLED';
export const COMMERCE_MODE_ENV = 'QEYNOX_COMMERCE_MODE';

/** The payment mutations the freeze refuses. Named so refusals and audits say exactly what was blocked. */
export type FrozenPaymentAction = 'CHECKOUT' | 'CAPTURE' | 'REFUND' | 'RECONCILE' | 'WEBHOOK';

export interface CommercePolicy {
  readonly mode: CommerceMode;
  /** Always true in this release. Typed as a literal so no code path can construct an unfrozen policy. */
  readonly paymentsFrozen: true;
  /** Always false in this release: no checkout, capture, refund or provider reconciliation. */
  readonly financialTransactionsAllowed: false;
  /**
   * True only in BETA_FREE. Reported to clients; since A21.03 it is also the precondition (together with
   * an ACTIVE beta grant) for the non-financial free beta execution authorization. Never a payment.
   */
  readonly betaFree: boolean;
}

/** Client-facing description of the freeze, embedded in payment read models and its own route. */
export interface CommerceAvailability {
  readonly mode: CommerceMode;
  readonly paymentsAvailable: false;
  readonly checkoutAvailable: false;
  readonly refundsAvailable: false;
  readonly betaFree: boolean;
  /** Stable reason code for the UI. */
  readonly reason: 'PAYMENTS_FROZEN';
}

export function isCommerceMode(value: string): value is CommerceMode {
  return (COMMERCE_MODES as readonly string[]).includes(value);
}

/**
 * Resolves the commerce policy from a raw configuration value.
 *
 * Unset/blank resolves to the default. Unknown values throw NOT_CONFIGURED — loudly, at boot — instead
 * of silently falling back, so an operator who believes they enabled something learns immediately that
 * they did not.
 */
export function resolveCommercePolicy(raw: string | undefined): CommercePolicy {
  const value = (raw ?? '').trim();
  const mode: CommerceMode = value === '' ? DEFAULT_COMMERCE_MODE : isCommerceMode(value) ? value : unsupported(value);
  return Object.freeze({ mode, paymentsFrozen: true, financialTransactionsAllowed: false, betaFree: mode === 'BETA_FREE' });
}

export function commercePolicyFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): CommercePolicy {
  return resolveCommercePolicy(env[COMMERCE_MODE_ENV]);
}

export function commerceAvailability(policy: CommercePolicy): CommerceAvailability {
  return {
    mode: policy.mode, paymentsAvailable: false, checkoutAvailable: false, refundsAvailable: false,
    betaFree: policy.betaFree, reason: 'PAYMENTS_FROZEN',
  };
}

function unsupported(value: string): never {
  // The raw value is echoed in a bounded, printable form only: it is configuration, not a secret, but it
  // must not be able to inject arbitrary text into logs.
  const shown = value.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40);
  throw new DomainError('NOT_CONFIGURED', COMMERCE_MODE_ENV + '=' + shown + ' is not supported. Allowed: ' + COMMERCE_MODES.join(', ') + '. Paid modes are not available in this release.');
}

export function paymentsFrozenError(policy: CommercePolicy, action: FrozenPaymentAction): DomainError {
  return new DomainError(
    'PAYMENTS_FROZEN',
    'Payments are frozen (' + COMMERCE_MODE_ENV + '=' + policy.mode + '); ' + action.toLowerCase() + ' is refused and no provider was contacted',
    { mode: policy.mode, action },
  );
}

/**
 * The provider bound under the freeze. Every method refuses with PAYMENTS_FROZEN and performs no I/O.
 *
 * It is placed in the *fallback* slot of `CompositePaymentProvider`; the configured slot stays empty, so
 * `PaymentService` reports `isConfigured === false` and never takes a provider path at all. This class is
 * the second wall: even a future code path that called `active()` directly would be refused here.
 */
export class FrozenPaymentProvider implements PaymentPort {
  constructor(private readonly policy: CommercePolicy) {}
  private fail(action: FrozenPaymentAction): never { throw paymentsFrozenError(this.policy, action); }
  async authorize(_request: PaymentIntentRequest): Promise<never> { return this.fail('CHECKOUT'); }
  async capture(_intentId: string, _idempotencyKey: string): Promise<never> { return this.fail('CAPTURE'); }
  async refund(_captureId: string, _amountMinor: number, _idempotencyKey: string): Promise<never> { return this.fail('REFUND'); }
  async verifyWebhook(_signature: string, _payload: Uint8Array): Promise<never> { return this.fail('WEBHOOK'); }
  async reconcile(_orderId: string): Promise<never> { return this.fail('RECONCILE'); }
  async createCheckoutSession(_request: CheckoutSessionRequest): Promise<never> { return this.fail('CHECKOUT'); }
  async verifyEvent(_signature: string, _payload: Uint8Array): Promise<never> { return this.fail('WEBHOOK'); }
  async retrieveIntent(_intentId: string): Promise<never> { return this.fail('RECONCILE'); }
}

/** Payment read model under the freeze: the A08 view plus an explicit availability block. */
export interface FrozenPaymentView extends PaymentView {
  readonly canStartCheckout: false;
  readonly providerConfigured: false;
  readonly commerce: CommerceAvailability;
}

export type WebhookResult = { status: 'APPLIED' | 'DUPLICATE' | 'IGNORED' | 'UNRESOLVED'; eventId: string; orderId?: string };

/**
 * The only payment surface the API is allowed to expose.
 *
 * Mutations refuse FIRST — before any argument is inspected, any row is read or written, or any provider
 * object is touched — so a frozen call is provably side-effect free. Reads go through the A08
 * `PaymentService` bound to the frozen provider, which reads the database only.
 */
export class FrozenPaymentGateway {
  private readonly ledger: PaymentService;

  constructor(store: QeyNoxStore, readonly policy: CommercePolicy, now: () => Date = () => new Date()) {
    this.ledger = new PaymentService(store, new CompositePaymentProvider(undefined, new FrozenPaymentProvider(policy)), now);
  }

  /** Always "FROZEN" in this release; exposed so composition tests can assert what the API bound. */
  get providerBinding(): 'FROZEN' { return 'FROZEN'; }

  availability(): CommerceAvailability { return commerceAvailability(this.policy); }

  /**
   * Refuses a payment mutation. Controllers call this before parsing the request so the frozen answer
   * does not depend on the body (and so a webhook is refused before its payload or signature is read).
   */
  assertMutationAllowed(action: FrozenPaymentAction): void {
    throw paymentsFrozenError(this.policy, action);
  }

  async view(actor: Principal, operationId: ID): Promise<FrozenPaymentView> {
    return this.freezeView(await this.ledger.view(actor, operationId));
  }

  /**
   * Return-from-provider page. Tenant-checked, database read only: the provider is NOT consulted under
   * the freeze, so `provider` is always null and nothing is written.
   */
  async confirmReturn(actor: Principal, operationId: ID, orderId: ID): Promise<FrozenPaymentView & { provider: ProviderReadView | null }> {
    const view = await this.ledger.confirmReturn(actor, operationId, orderId);
    return { ...this.freezeView(view), provider: null };
  }

  async startCheckout(..._args: unknown[]): Promise<StartCheckoutResult> { throw paymentsFrozenError(this.policy, 'CHECKOUT'); }
  async capture(..._args: unknown[]): Promise<PaymentReceiptView> { throw paymentsFrozenError(this.policy, 'CAPTURE'); }
  async refund(..._args: unknown[]): Promise<PaymentReceiptView> { throw paymentsFrozenError(this.policy, 'REFUND'); }
  async reconcileOrder(..._args: unknown[]): Promise<PaymentView> { throw paymentsFrozenError(this.policy, 'RECONCILE'); }
  /**
   * Provider webhooks are refused without verification, ledger write or order change. A refusal (HTTP
   * 503) rather than an acknowledgement is deliberate: the provider keeps the event and retries, so
   * nothing is silently lost, and nothing received during the freeze can authorize an order or record a
   * payment as successful.
   */
  async handleWebhook(..._args: unknown[]): Promise<WebhookResult> { throw paymentsFrozenError(this.policy, 'WEBHOOK'); }

  private freezeView<T extends PaymentView>(view: T): T & FrozenPaymentView {
    return {
      ...view,
      // Historical facts (status, amounts, refunds, order state) are reported as stored. A stale hosted
      // checkout link is withheld: it must not be possible to pay through an old session during a freeze.
      payment: view.payment ? { ...view.payment, checkoutUrl: null } : null,
      canStartCheckout: false,
      providerConfigured: false,
      blockedReason: view.orderId === null ? view.blockedReason : 'PAYMENTS_FROZEN',
      commerce: this.availability(),
    };
  }
}

/**
 * The API's payment composition. Reads ONLY `QEYNOX_COMMERCE_MODE`; the Stripe credentials are not read,
 * so their presence or absence cannot change the result.
 */
export function createFrozenPaymentGateway(
  store: QeyNoxStore,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now?: () => Date,
): FrozenPaymentGateway {
  return new FrozenPaymentGateway(store, commercePolicyFromEnvironment(env), now);
}
