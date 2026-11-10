# ADR-001: RaaS domain boundaries (accepted)

QeyNox provides daily-use business capabilities. Operation is a durable business identity; plans and step attempts have separately versioned identities. An operation result is a traceable artifact with sources, evidence, timestamps and explicitly recorded uncertainty. Business outcome is never guaranteed.

QeyNox/PostgreSQL is the canonical store of user/workspace/context/consent, approval, operation, plan, step, execution link, evidence, artifact and result.

Hatchet has execution state, not business truth. Hermes has model/agent sessions, not business truth. Capability definitions govern business perimeter and ToolBroker governs access to connectors.

User-controlled context requires recorded consent. Missing workspace authentication is a deny condition, not a default admin identity. A changing technical attempt must not erase earlier business evidence.

The consumer application is MyDash (Quiet Authority), excluded from this wave.

OPEN: commercial offer pricing, final eight capability names, launch language set, formal retention policy, identity provider.
