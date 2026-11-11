# ADR-016 — Bounded agency and transparent cost attribution

An operation must have a versioned, explicitly configured budget policy before it may consume agent or tool resources. The policy sets per-provider maximum reserved cost, total budget, agent/tool call counts, concurrency and wall time. There is no default unbounded runtime.

Reservations are persisted atomically with a locked budget row and idempotency key. Actual provider-reported charges, configured estimates and UNKNOWN cost are distinct; unknown results retain reserved budget rather than releasing it optimistically. No token usage alone constitutes an actual invoice.

Loop fingerprints detect repeated no-progress conditions; no autonomous infinite retries. Provider rate cards and pricing are OPEN decisions. No actual usage or money was recorded during this source-only implementation.
