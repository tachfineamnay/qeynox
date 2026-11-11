# ADR-010 — Version-sealed business plans and step progression

A stable Operation references a revisioned plan, while each step execution uses a separate StepAttempt. When execution is first requested, PlanSealer validates a dependency DAG and active capability versions and seals its canonical hash in `plan_seals`. Running revisions cannot be mutated; users revise by creating new versions. Outputs from completed predecessor steps are scoped to their revision and consumed as explicit handoff context.

Each step is a Hatchet task. The worker records a completed attempt and schedules the next eligible step by inserting an outbox intent in the same PostgreSQL transaction. **Hatchet is still the only workflow execution engine**; the outbox is a reliable message delivery boundary rather than a scheduling runtime. This source code implements sequential eligible-step dispatch, not parallel DAG execution.

Finishing all steps yields a PENDING human result review and WAITING_APPROVAL, never an automatically verified, paid deliverable. Technical retries are separate from user-authorized redos. Hatchet run-ID mapping still needs runtime verification; NEVER infer that a task started successfully solely because an API call returned.

UNTESTED / NOT BUILT. No Hatchet or database was executed.
