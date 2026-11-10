# QeyNox engineering rules

## Product
QeyNox is a daily-use, internationally accessible RaaS business-intelligence utility. It is not a task manager, CRM, personal-productivity operating system or chat wrapper. RaaS produces tangible, current, source-linked and reusable deliverables; not financial or commercial guarantees.

## Canonical boundaries
1. QeyNox/PostgreSQL owns identities, consent, context, operations, plans, steps, attempts, authorizations, evidence, results and audit.
2. Hatchet is the **only** durable workflow engine. QeyNox does not implement a second Temporal, scheduler or task queue.
3. Hermes Agent is the first replaceable AI agent runtime. Swapping an LLM within Hermes is not swapping Hermes.
4. ToolBroker mediates *all QeyNox-controlled* external tool calls; unmediated Hermes tools must be disabled, isolated or fail closed.
5. Soul manages progressive consent-aware context, and QeyNox Pilot handles business-level handoffs, approvals and next actions. Neither schedules jobs.
6. Exactly eight versioned configurable business-capability slots; unspecified names remain unconfigured, and do not become public services.
7. User data is tenant-scoped and never forwarded en masse to engines or connectors.
8. Keep vendor SDKs outside domain and contracts. Prefer one package manager (pnpm) and one database layer.
9. Quiet Authority / MyDash UI intentionally deferred.

## This implementation wave (00–09)
- Write actual typed code, migrations and configuration only.
- Do NOT run or create tests, compilation, typechecking, lint, builds, benchmark, CI, scans, live external calls or deployments.
- Use a dedicated branch; one final commit after 09, no intermediate commits.
- No fake data, fake success, guessed API, embedded secret, permissive default or silently implemented unsupported feature.
- Use explicit NOT_CONFIGURED, UNSUPPORTED, DENIED and failure states.
- Record blockers without pretending they are complete.
- No push/merge to main; no real destructive actions.
- Re-read changed code and ADRs before changing contracts.
- Label all implemented functions as UNTESTED / NOT BUILT until verified in a separate phase.

## Reference precedence
Latest QeyNox product decisions > historical PRD/CDC architecture suggestions. Hatchet decision supersedes a custom workflow runner/queue. Product obligations remain unchanged.
