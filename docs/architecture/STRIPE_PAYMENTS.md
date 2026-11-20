# Stripe payments — configuration and operating guide (MISSION A08)

One-time payments for versioned RaaS offers, behind the existing `PaymentPort`. No subscriptions.

> **Status.** The implementation is verified against a real PostgreSQL database and real Stripe HMAC
> signature verification, with a deterministic in-process provider double. **Stripe itself was never
> contacted.** Live test-mode Stripe, a real browser redirect and the provider dashboard remain
> NOT VERIFIED.

## 1. What is never true

These are enforced in code and covered by tests; treat them as invariants of the product, not of the
deployment.

| Claim that must never be made | Enforced by |
|---|---|
| "The customer came back from Stripe, so they paid" | There is no write path from a redirect. `confirmReturn` reads the provider and writes nothing. |
| "The order was accepted, so it is authorized" | `accept` puts a paid order in `PAYMENT_REQUIRED`; only a verified provider event or a direct provider read moves it. |
| "The webhook says paid, so it must be real" | Every event is signature-verified over the raw bytes; forged, tampered, wrong-secret and stale signatures are refused. |
| "Execution can start because money might be there" | `assertExecutionAllowed` requires order state `AUTHORIZED`/`FULFILLING`. `PAYMENT_REQUIRED`, `DISPUTED` and `CANCELLED` all refuse. |
| "Charging twice is unlikely" | A partial unique index makes a second *live* payment per order impossible, and idempotency keys are unique per workspace. |

## 2. Configuration

Three environment variables. Nothing else is required, and there is no separate feature flag: the
presence of both credentials is the configuration.

```sh
QEYNOX_STRIPE_SECRET_KEY=sk_test_...          # MUST be a test-mode key; live keys are refused
QEYNOX_STRIPE_WEBHOOK_SECRET=whsec_...        # from the webhook endpoint, not the API keys page
QEYNOX_PUBLIC_ORIGIN=https://app.example.com  # used to build provider return URLs
```

Behaviour by configuration:

| State | Result |
|---|---|
| Neither key set | `DisabledPaymentProvider`. Every payment route throws `PAYMENT_NOT_CONFIGURED` (HTTP 503). The UI says payments are not configured and offers no checkout button. |
| Only one key set | Treated as unconfigured. Fail closed; never half-configured. |
| A `sk_live_` or `rk_live_` key | **Refused at construction.** The API logs a rejection, keeps running, and payment routes report `PAYMENT_NOT_CONFIGURED`. The rest of the product is unaffected. |
| Both test keys | Stripe adapter active. |

`QEYNOX_PUBLIC_ORIGIN` is read from configuration rather than the `Host` header on purpose: an
attacker-supplied `Host` must not be able to redirect the provider's return URL to another site.

### Webhook endpoint

Point the Stripe dashboard (test mode) at:

```
POST https://<api-host>/v1/payments/webhook/stripe
```

Subscribe to at least:

```
payment_intent.amount_capturable_updated
payment_intent.processing
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
checkout.session.completed
checkout.session.expired
charge.refunded
charge.dispute.created
```

Unrecognized event types are recorded in the ledger and ignored — never guessed at.

The route is `@PublicRoute()` because Stripe has no QeyNox session. It is authenticated by the
signature, which is stronger than a shared header: the signature covers the exact bytes.

**Raw body is mandatory.** `main.ts` sets `rawBody: true`. If the raw body is unavailable the route
refuses the event rather than verifying a re-serialised payload. Do not add a global
`bodyParser`/`express.json()` that consumes the body first.

## 3. Lifecycle

```
accept quote → order PAYMENT_REQUIRED
   → startCheckout        (payment CREATED, one live attempt per order)
   → customer pays at Stripe
   → webhook AUTHORIZED   (order AUTHORIZED — now execution is allowed)
   → capture              (payment CAPTURED, amount re-checked)
   → refund               (refunds row PENDING → SUCCEEDED/FAILED, capped by captured)
```

Failure paths, all recoverable by starting a new checkout:

| Provider outcome | Payment | Order | Customer can retry |
|---|---|---|---|
| declined | `FAILED` + `failureCode` | `PAYMENT_REQUIRED` | yes, new attempt |
| checkout expired | `EXPIRED` | `PAYMENT_REQUIRED` | yes, new attempt |
| intent canceled | `CANCELLED` | `PAYMENT_REQUIRED` | yes, new attempt |
| dispute opened | `DISPUTED` | `DISPUTED` | no — blocked until resolved |
| refunded | `REFUNDED` | `PAYMENT_REQUIRED` (or `DISPUTED` if already delivered) | yes |

## 4. Event handling semantics

- **Duplicate delivery** — the event row is inserted with its `UNIQUE` provider event id in the same
  transaction that applies the effect. A duplicate violates the constraint and rolls the transaction
  back, so the effect cannot run twice. Reported to Stripe as `200 DUPLICATE` so it stops retrying.
- **Delayed delivery** — a late event is recorded and compared against the newest applied event by the
  provider's own `created` timestamp. If it predates it, it is marked `SUPERSEDED` and changes nothing.
- **Out-of-order delivery** — ordering uses the provider timestamp, never arrival order, so a delayed
  success that is genuinely newer than a failure still wins.
- **Unknown order** — recorded with `order_id` NULL and outcome `UNRESOLVED`. Never acknowledged as
  applied, never silently dropped.
- **Replayed delivery** — the SDK's timestamp tolerance rejects a signature older than five minutes.

Every row stores a SHA-256 of the payload and a redacted summary (amount, currency, status, failure
code, dispute status). No card data, no names, no addresses, no raw payload.

## 5. Operating the payments

- **Reconcile** (`POST /v1/operations/:id/payments/reconcile`) re-reads the intent from Stripe. It is the
  only non-webhook path that may authorize an order, and it authorizes from a direct provider read.
  Use it when a webhook was missed; it is safe to call repeatedly.
- **Capture** is idempotent: capturing an already-captured payment is a no-op, not an error.
- **Refund** requires a positive amount, an idempotency key and a captured payment. The ceiling is
  `captured_minor`, not the order amount. A provider failure leaves a `FAILED` refund row with its
  message and does not count toward the refunded total.

## 6. What the database enforces regardless of code

Migration `0019_payments.sql`:

- `raas_payment_one_live_per_order` — partial unique index: at most one payment per order in a state
  that could still take money. This is the last line of defence against a double charge.
- `raas_payment_idempotency_unique`, `raas_refund_idempotency_unique` — per-workspace key uniqueness.
- `raas_payment_intent_unique`, `raas_refund_provider_unique` — a provider object maps to one row.
- `raas_payment_amount_positive`, `raas_payment_captured_within_amount`,
  `raas_payment_refunded_within_captured`, `raas_refund_amount_positive` — money invariants as CHECK
  constraints, so an impossible amount state cannot be stored.

## 7. Verifying

```sh
export QEYNOX_QA_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/qeynox_qa_admin
pnpm qa:stripe-payments     # 17 groups, 108 assertions, ~1s
```

Covers: fail-closed provider, live-key refusal, real signature accept/reject, checkout idempotency and
races, unsigned webhook refusal, duplicate/concurrent-duplicate delivery, late and out-of-order events,
orphan events, failed/expired/cancelled/disputed states, capture idempotency, refund capping/idempotency/
failure, expired-quote and mutated-amount refusal, redirect-is-not-proof, tenant isolation, ledger
integrity.

## 8. Not done, and deliberately so

- **No subscriptions.** No verified product decision requires them.
- **No live Stripe call** in any test in this repository.
- **No customer self-service refund portal.** Refunds are an operator action through the API.
- **No invoice, tax or receipt documents.** `taxPolicy` is configuration and out of scope here.
- **Not verified:** live test-mode Stripe, real webhook delivery, dashboard configuration, browser
  redirect UX, and card-collection rendering. All of those need a real provider account and a browser.
