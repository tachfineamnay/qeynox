# ADR-008: Ten roles; one business truth

Soul and QeyNox Pilot are transversal application services. They may consult a versioned agent profile via the replaceable EnginePort, but they are not durable schedulers. Hatchet handles the durable steps. The eight business slots are configurable and not live services until actively defined, permissioned and versioned.

Soul collects user-provided context with opt-in purpose/scopes. A business capability may receive only the subset explicitly authorized by consent and role policy; there is no global prompt dump of personal data. Context is editable or marked deleted, with deletion/retention semantics to complete in the identity-hardening phase.

Pilot reports real operation state and next actions from persistence, rather than fabricating progress. Its suggestions are advice; they cannot bypass ToolBroker policy or human approval. No UI created in this phase.
