# ADR-007: User control differs from engine retries

QeyNox must retain a stable business operation across sessions and allow interrupt, approve, revise or redo with traceable versions. Hatchet task retries are technical recovery, not a user-approved redo or plan revision.

Interrupt first records INTERRUPT_REQUESTED. Cancellation is confirmed only from actual observed runtime state. Outbox UNKNOWN means scheduling may have happened and cannot be retried blindly. Reconciliation exposes unresolved delivery for controlled investigation.

An explicit redo creates a new attempt and preserves previous evidence. A plan revision creates a new plan revision and changes the canonical current revision. All old results remain available but must be marked stale/invalidated where required by dependencies.

The current design supports domain-side semantics and records open transport work; it has never been executed.
