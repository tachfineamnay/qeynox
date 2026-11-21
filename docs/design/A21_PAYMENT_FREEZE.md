# MISSION A21.01 — Hard payment freeze

Branch `arena/21a16ce5-qeynox` (off `main` @ `d872738`). One scoped commit, one draft PR, not merged.
Nothing is deployed, and no migration was written or applied (none is needed: no schema change).

## Decision

`QEYNOX_COMMERCE_MODE` is the single, server-authoritative commercial switch. It has two values and
**both freeze payments**:

| Mode | When | Meaning |
|---|---|---|
| `PAYMENTS_DISABLED` | default; also unset/blank | No financial transaction. Payment history stays readable. |
| `BETA_FREE` | explicit | Free-beta posture reported to clients ("nothing is charged"). Still no financial transaction. **Grants no new entitlement.** |

There is no paid mode. Any other value (`PAID`, `STRIPE`, `LIVE`, lower-case variants, …) throws
`NOT_CONFIGURED` when the commerce module is created, so the API refuses to boot instead of guessing.

### What `BETA_FREE` does and does not do (scope decision)

`BETA_FREE` changes the reported posture and copy only. It does **not** turn paid offers into free ones,
create beta grants, or move any order to `AUTHORIZED`. Offers already configured as explicitly free keep
authorizing without payment in both modes (unchanged A07/A08 behaviour); priced orders stay
`PAYMENT_REQUIRED` and execution stays blocked. A real beta entitlement model is out of scope for A21.01.

## Before → after

| Before (A08) | After (A21.01) |
|---|---|
| Both `QEYNOX_STRIPE_SECRET_KEY` and `QEYNOX_STRIPE_WEBHOOK_SECRET` set ⇒ `StripePaymentProvider` built ⇒ checkout/capture/refund/reconcile/webhooks live | `commerce.module.ts` composes `createFrozenPaymentGateway(store, env)`, which reads **only** `QEYNOX_COMMERCE_MODE`. Stripe credentials aren't read; `StripePaymentProvider` is never built |

## Enforcement (defence in depth)

1. **Controller, first statement.** Every mutating route calls `assertMutationAllowed(action)` before it
   looks at the session, body, raw bytes or signature. The answer is `503 PAYMENTS_FROZEN` with
   `{mode, action}` context.
2. **`FrozenPaymentGateway`.** This is the only payment surface the API injects. Its mutation methods
   throw before any database or provider access, so a refused call has no side effects.
3. **`FrozenPaymentProvider`.** This provider sits in the fallback slot of `CompositePaymentProvider`, and
   the configured slot stays empty. So `PaymentService.isConfigured === false`, and anything that calls
   `active()` gets `PAYMENTS_FROZEN` too.
4. **Type level.** `CommercePolicy.paymentsFrozen` is the literal `true` and `financialTransactionsAllowed`
   is the literal `false`. No code can build an unfrozen policy.

New domain code `PAYMENTS_FROZEN` (HTTP 503) is kept separate from `PAYMENT_NOT_CONFIGURED`. A configured
credential can never clear it.

## Provider webhooks and previously received events

Under the freeze, `POST v1/payments/webhook/stripe` returns 503 before it reads or verifies the payload.
It doesn't write to the ledger and doesn't change any order. Here's why:

- An event delivered during the freeze can't authorize an order or mark a payment successful, because it
  is never processed.
- A redelivery of an event that was already applied gets the same refusal. Its single ledger row is
  unchanged (it isn't re-applied and isn't marked as a duplicate).
- A 503 is not an acknowledgement, so Stripe keeps the event and retries for its retry window. Nothing is
  silently thrown away. **Operator action (not done by the agent):** disable the webhook endpoint in the
  Stripe dashboard for the duration of the freeze.
- Earlier ledger rows, including `UNRESOLVED` orphans, are kept as they are. No reconciliation applies them.

**Known operational consequence.** An authorization that existed before the freeze (`AUTHORIZED`, not
captured) stays `AUTHORIZED` locally. Stripe may cancel it after its hold expires, but the cancellation
webhook is refused, so the local record isn't downgraded. This is deliberate: the freeze changes no
entitlement in either direction. An operator must reconcile these orders before any future reactivation.

## API contract changes

- `GET v1/operations/:id/payment` and `GET …/payments/return` now include:
  `commerce: { mode, paymentsAvailable:false, checkoutAvailable:false, refundsAvailable:false, betaFree, reason:'PAYMENTS_FROZEN' }`.
  They also always return `canStartCheckout:false` and `providerConfigured:false`, and
  `blockedReason:'PAYMENTS_FROZEN'` whenever an order exists. `payment.checkoutUrl` is always `null`,
  so a stale hosted checkout link can't be used. The return page's `provider` is always `null` because
  the provider is not consulted.
- New: `GET v1/commerce/availability` (session required) returns the same `commerce` block.
- `POST …/payments/{checkout,capture,refund,reconcile}` and `POST v1/payments/webhook/stripe` return
  `503 { error: { code: 'PAYMENTS_FROZEN' } }`.
- The readiness blocker for an unpaid priced order is now `PAYMENTS_FROZEN`. It was
  `PAYMENT_NOT_CONFIGURED`, which would be false when keys are set.

## UI

- `PaymentPanel`: when the server sends a `commerce` block, the panel shows a frozen state for the mode
  ("payments disabled" or "free beta, nothing is charged"). Historical facts (status, amount, captured,
  refunded) are read-only, and there's no checkout, resume or retry action. `PAYMENTS_FROZEN` from the
  server action has its own message.
- The web `paymentViewSchema` requires the `commerce` block, with literal `false` flags. A response
  without it is rejected, and the page shows "payment status unavailable" instead of guessing.
- Mission copy: EN/FR `paymentRequired` and a new `PAYMENTS_FROZEN` blocker label.

## Preserved, unchanged

`StripePaymentProvider`, `PaymentService` (the full A08 paid lifecycle), `CompositePaymentProvider`,
`DisabledPaymentProvider`, every persistence table and migration, published offer prices, and all stored
orders, payments, refunds and webhook-ledger rows. `qa:stripe-payments` (17 groups / 108 assertions) still
passes against the unchanged engine, which keeps the dormant code verified for a future reviewed
reactivation.

## Verification (disposable PGlite, real PostgreSQL 18.7 wire protocol, applied nowhere else)

- `qa:payment-freeze` (new): **21 groups, 369 assertions PASS**. It covers:
  - Mode resolution, including refused paid values.
  - A positive control showing that the outbound-network interceptor catches a real Stripe SDK call before
    it connects.
  - Pre-freeze history written by the preserved A08 engine with real HMAC-signed events: an open checkout,
    an authorized payment, a captured payment with a partial refund, an orphan event, and an unpaid order.
  - For each of the 4 combinations {PAYMENTS_DISABLED, BETA_FREE} × {Stripe test keys present, absent}:
    - In-process: checkout, capture, refund, reconcile, and webhooks (a redelivered applied event, a new
      signed authorization, a new signed success) all return `PAYMENTS_FROZEN`.
    - Over the real NestJS `AppModule` HTTP API: every mutation route returns 503 `PAYMENTS_FROZEN`, also
      for empty bodies and unsigned webhooks; anonymous calls are refused.
    - Reads report history truthfully, withhold stale checkout links and stay tenant-isolated, and the
      readiness blocker names the freeze.
  - After every combination, all seven commerce tables are deep-equal to the baseline.
  - A paid mode refuses to boot the API, with or without keys.
  - Zero non-loopback network attempts after the control, and no ledger writes during the freeze.
- `qa:stripe-payments` 108 PASS · `qa:business-packs` 370 PASS (priced packs still go to `PAYMENT_REQUIRED`)
  · `qa:backend` 28 PASS · `qa:agent-runtime` 65 PASS · `qa:mission-lifecycle` 88 PASS · `pnpm typecheck`
  4/4 · `pnpm build` 4/4 · `pnpm install --frozen-lockfile` OK.
- Web `test:smoke`: **199 HTTP assertions PASS**. The payment fixtures were updated to the frozen contract.
  They cover failed-payment history shown read-only with no retry or link, PAYMENTS_DISABLED and BETA_FREE
  states (EN and FR) with no checkout, and a legacy response without `commerce` being rejected rather than
  rendered as payable. Web `test:flow2`: 35 PASS.
- **Pre-existing / environmental, unchanged by this mission:**
  - `qa:task02` fails with `migration created declared index email_deliveries_dedup_unique`. It fails the
    same way on the untouched base commit.
  - `qa:connectors`, `qa:raas` and `qa:a03-service` part 2 are BLOCKED because the live World Bank
    provider can't be reached from this sandbox (TLS egress refused). No fixture was substituted.

## NOT verified

- Any live or test-mode Stripe call (by design: there must be none).
- A real browser rendering of the frozen panel. It is typechecked and built, not visually checked.
- Production configuration: `QEYNOX_COMMERCE_MODE` isn't set in any deployment by the agent. Because the
  default is `PAYMENTS_DISABLED`, a deployment that doesn't set it is frozen.
- Disabling the Stripe webhook endpoint in the dashboard (operator action).
