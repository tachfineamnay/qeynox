# QeyNox 2027 — Foundation architecture

Future MyDash -> NestJS API (fail-closed until trusted workspace identity) -> application services -> Drizzle/PostgreSQL canonical business state -> transactional outbox -> Hatchet worker -> Hermes EnginePort -> governed ToolBroker/connectors -> Source/Evidence/ResultVersion.

## Ownership
- QeyNox Core: users, consent, goals, plan revisions, attempts, policy decisions, evidence, results, audit.
- Hatchet: task dispatch, durable execution and retry primitives, not the user-facing operation truth.
- Hermes: initial configurable agent intelligence runtime, not the workflow engine or business ledger.
- Soul: consent-aware context and conversational intake.
- Pilot: next action, business routing and approvals.
- Eight versioned configurable business capabilities: no fictitious agents enabled.
- ToolBroker: sole QeyNox-governed connector invocation gateway. No native Hermes tool bypass.

## Source-code inventory
- apps/api: NestJS controllers, application composition; all business requests require authenticated Principal. Identity is intentionally NOT CONFIGURED until the next phase.
- apps/worker: Hatchet task, PostgreSQL/outbox delivery and guarded Hermes text work.
- packages/domain/contracts/application/persistence: model, validation, plans, revisions, attempts, results, storage.
- packages/tools/engine/orchestration/roles: adapters, policies, agent profiles, Soul and Pilot.
- infra: Dockerfiles and application/DB Compose template; not a fully deployable Hatchet/Hermes installation.

## Remaining critical integration work
- Verified Hatchet run-reference mapping, cancellation status, stale/unknown run reconciliation.
- Hermes native tool and outbound egress isolation; only then enable real customer execution.
- Controlled Hermes tool proposals -> Broker -> approved connector -> provenance -> step continuation.
- Real evidence validation, staged artifacts and successful multi-step result assembly.
- Authentication and tenant isolation; external actions, commercial policy, costs and result delivery.
- Current verified supplier/registry/search providers, no fabricated data.
- Confirmed self-host Hatchet and Hermes infrastructure; secret management and backups.

**This tree is code only. UNTESTED / NOT BUILT / NOT DEPLOYED.**
