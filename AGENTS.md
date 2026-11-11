# QeyNox engineering contract

PRODUCT: QeyNox expands each person's business intelligence and capabilities through daily-use, internationally accessible Results as a Service. The customer defines the business objective and gets evidence-backed, actionable deliverables. It is not a CRM, productivity OS or chatbot wrapper. No promises of financial or business success.

BOUNDARIES:
- PostgreSQL/QeyNox Core is canonical business truth.
- Hatchet is the single durable workflow executor; never recreate Temporal/Hatchet within QeyNox.
- Hermes Agent is the initial replaceable intelligence runtime; tools require ToolBroker mediation.
- Soul manages consented context; Pilot supports business decisions, plans and approvals without becoming a scheduler.
- Eight configurable business capability slots; unconfigured skills remain inactive.
- Users retain control of privacy context, operation history and revisions.
- MyDash/Quiet Authority interface is a later wave, not coded here.

IMPLEMENTATION 10–20:
- Work on feat/qeynox-2027-foundations; protect main.
- Each numbered task has exactly one commit.
- Source-only stage: no test, compilation, typecheck, lint, build, runtime, external provider calls, migrations, deployment, CI or production data.
- Each module must fail closed when permissions, pricing, credentials, evidence, isolation or SDK support are absent.
- No hardcoded credentials, dummy providers, invented contacts, citations, prices or false success statuses.
- Never claim code is proven functional based on source review alone.

SOURCE TRUTH: Latest product decisions and ADRs supersede historical custom runner suggestions. docs/architecture/IMPLEMENTATION_MAP.md lists exact blockers. Production readiness requires a separate independent certification phase.
