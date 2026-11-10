# ADR-002: Hatchet is the initial durable orchestrator (accepted)

Supersedes older suggestions to create a custom queue, workflow runner, Temporal clone or homegrown durable execution engine.

Hatchet executes bounded, versioned tasks, scheduling, retries and native wait/recovery semantics. QeyNox owns business-level start, interrupt, revise, redo and history. A technical retry is NOT a user redo. A plan revision starts a fresh execution lineage; do not claim arbitrary instruction-pointer rewinds.

The business write and an outbox event share one PostgreSQL transaction; a dispatcher communicates committed intent to Hatchet. Execution links record external run identifiers. Non-idempotent side effects must be approved and guarded; a lack of confirmation leaves an indeterminate state rather than declaring success/cancelled.

OrchestratorPort isolates Hatchet and exposes only methods that the selected SDK actually supports.

OPEN: validated self-hosted Hatchet image/configuration, cancellation/approval event transport implementation specifics, runtime reconciliation behavior. No environment launched.
