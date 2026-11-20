# ADR-015 — Commercial authorization is independent from agent execution

QeyNox sells a scoped, versioned deliverable, not a promised economic result. The actual offer price and taxes are configuration, never model-generated. Quotes lock operation + plan revision + offer version + amount + terms into a scope hash; acceptance is traceable to an authenticated user.

An accepted FREE service is authorized only when the configured offer explicitly has `isExplicitlyFree=true`. Paid quotes stay PAYMENT_REQUIRED; the deliberately disabled PaymentPort cannot authorize payments. The operation execution entry point rejects every unaccepted scope and every paid order without a verified payment state.

Successful agent output does not imply delivery, payment or customer approval. Financial amounts use integer minor units.

Known follow-up: rate cards, money-provider selection, actual webhook verification, refund legal rules, scope-change reacceptance and privileged offer configuration UI. UNTESTED / NOT BUILT.

## A08 amendment — Stripe one-time payments, and what authorizes execution

The "deliberately disabled PaymentPort" is replaced by a **configured** one. `DisabledPaymentProvider`
remains the default and still fails closed on every method, but an environment with a test-mode key and a
webhook secret now installs `StripePaymentProvider`. This section records the decisions that follow.

WHAT AUTHORIZES EXECUTION. Nothing changed in principle and everything changed in practice: an order is
authorized only by a state recorded from a **verified** provider event, or by a direct provider read
performed by `PaymentService`. Three things are emphatically *not* authorization:

- an accepted quote (it produces `PAYMENT_REQUIRED`, never `AUTHORIZED`);
- the customer returning from the hosted checkout page (`confirmReturn` performs a read and writes
  nothing at all, so a hand-edited return URL cannot authorize anything);
- the existence of a payment row (the order state, not the payment row, is what execution checks).

`assertExecutionAllowed` now distinguishes four refusals that were previously conflated into one:
`PAYMENT_REQUIRED`, `DISPUTED`, `CANCELLED` and "not authorized". Before A08 a paid order could not
exist, so an unpaid order was reported as `PAYMENT_NOT_CONFIGURED` — a configuration error. That was
always wrong and became actively misleading once a provider could be configured, so it was fixed.

WHAT PREVENTS A DOUBLE CHARGE. Three independent mechanisms, because application discipline alone is
not a guarantee:

1. `raas_payment_one_live_per_order` — a partial unique index allowing at most one payment per order in
   a state that could still take money. A second concurrent attempt is refused by PostgreSQL.
2. Per-workspace unique idempotency keys on payments and refunds, so a retried submit returns the
   existing row and the existing provider session rather than creating another.
3. Webhook effects are applied in the same transaction that inserts the `UNIQUE` provider event id, so a
   duplicate delivery rolls the whole transaction back instead of applying twice.

WEBHOOK SEMANTICS. Signatures are verified over the **raw bytes** (NestJS `rawBody: true`); a
re-serialised object would be a different byte string and is never accepted. Ordering uses the provider's
`created` timestamp, not arrival order, so a delayed event cannot undo a newer one: it is recorded and
marked `SUPERSEDED`. An event whose order is not resolvable is stored with a NULL order and outcome
`UNRESOLVED` rather than being acknowledged and lost. Event ids are stored namespaced
(`stripe:<event_id>`) so the pre-existing globally-unique column expresses per-provider uniqueness.

MONEY. Integer minor units throughout, and the invariants are CHECK constraints as well as service logic:
a payment amount must be positive, captured cannot exceed amount, refunded cannot exceed captured. A
refund's ceiling is what was *captured*, never the order amount and never a client-supplied number.
Provider-confirmed amounts are compared against the quoted amount before any state is recorded; a
mismatch is a `CONFLICT`, never a silent success.

LIVE CREDENTIALS ARE REFUSED. `StripePaymentProvider` accepts only `sk_test_`/`rk_test_` keys and throws at
construction otherwise. The module catches that and installs the disabled provider, so a live key in a
non-production environment disables payments instead of charging a real customer.

KNOWN FOLLOW-UP: no subscriptions (no verified product decision requires them), no tax/receipt documents,
no customer-facing refund portal, and no live Stripe verification. Live test-mode Stripe, real webhook
delivery and the browser redirect are NOT VERIFIED.
