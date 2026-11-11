# ADR-018 — Explicit ambiguity and operator-controlled recovery

The outbox states DISPATCHING/UNKNOWN may represent a run accepted by Hatchet whose result was lost locally. QeyNox never automatically requeues ambiguous events. RecoveryIncidents preserve identity, workspace, reason and operator actions. An operator may escalate or abandon the incident record; this does NOT falsely complete/cancel the external execution.

A Hatchet inspector port exists with a default UNSUPPORTED implementation. Until an actual documented run observation implementation is configured, successful cancellation and automatic replay cannot be asserted. Retrying uncertain external WRITE actions is forbidden even for operators.

Expired human approvals are marked EXPIRED with conditional updates. Late decisions on stale revisions remain rejected by the existing approval service. This layer exposes actual state, not fabricated run metrics or telemetry.
