# QeyNox 2027

QeyNox expands a person's business intelligence and capabilities through governed AI-assisted services. A user states an intention, selects a capability, receives a documented result and can return to or revise the operation at any time. **Results as a Service** (RaaS) means a verifiable deliverable, not a promise of a successful business outcome.

## Architecture

- QeyNox Core: canonical business state, consent, plans, attempts, evidence, results and policies (PostgreSQL).
- Hatchet: durable execution only, behind OrchestratorPort.
- Hermes Agent (Nous Research): initial agent runtime, behind EnginePort, replaceable.
- ToolBroker: explicit, scoped and auditable connector invocation; never free-form access.
- Soul: consent-aware, conversational context and preferences.
- QeyNox Pilot: business-level routing, approvals and continuation; not a workflow engine.
- Eight configurable business capability slots, not eight hard-coded invented businesses.
- MyDash / Quiet Authority: approved interface direction, intentionally out of scope in this branch.

Source: docs/architecture/ and the QeyNox product requirements. The historical iasser repository is **read-only reference material**, not a source of product rules.

## Status

Foundation code only. **UNTESTED / NOT BUILT / NOT DEPLOYED.** No third-party integrations should be considered configured until their credentials, restrictions and runtime behaviors are independently confirmed.
