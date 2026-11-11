# ADR-015 — Commercial authorization is independent from agent execution

QeyNox sells a scoped, versioned deliverable, not a promised economic result. The actual offer price and taxes are configuration, never model-generated. Quotes lock operation + plan revision + offer version + amount + terms into a scope hash; acceptance is traceable to an authenticated user.

An accepted FREE service is authorized only when the configured offer explicitly has `isExplicitlyFree=true`. Paid quotes stay PAYMENT_REQUIRED; the deliberately disabled PaymentPort cannot authorize payments. The operation execution entry point rejects every unaccepted scope and every paid order without a verified payment state.

Successful agent output does not imply delivery, payment or customer approval. Financial amounts use integer minor units.

Known follow-up: rate cards, money-provider selection, actual webhook verification, refund legal rules, scope-change reacceptance and privileged offer configuration UI. UNTESTED / NOT BUILT.
