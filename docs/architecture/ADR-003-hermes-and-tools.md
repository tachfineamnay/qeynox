# ADR-003: Hermes + ToolBroker and connector boundaries (accepted)

Hermes Agent (Nous Research) initially provides agentic reasoning, via documented OpenAI-compatible API server. HermesAdapter is replaceable behind EnginePort. Model selection inside Hermes is different from replacing the engine.

ToolBroker is the only QeyNox-authorized external-tool gateway. Every tool definition has an explicit schema, namespace, version, permission class, tenant/capability scope, cost/timeout and provenance. Secrets remain server-side. Read-only research is distinct from external mutations.

CRITICAL: a Hermes API server can execute its own built-in tools. An application-level prompt cannot enforce tool security. **Do not enable Hermes for tenant data until its unmanaged tools and egress are actually isolated/disabled by deployment configuration**. Otherwise return NOT_CONFIGURED. Never infer that connecting an MCP server automatically enforces QeyNox policy.

Arbitrary tools are not plug-and-play. Each connector requires reviewed adapter contract, credentials, permissions and configured provider endpoint. Absent connectors are NOT_CONFIGURED.

OPEN: verified Hermes isolation recipe, actual deployment version/profile, MCP mediation transport, provider registry and budget policy.
