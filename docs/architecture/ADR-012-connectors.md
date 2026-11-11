# ADR-012 — Provider manifests, reviewed connectors and egress policy

QeyNox permits extensible reviewed connector bundles, not universal unrestricted network access. A versioned provider manifest declares supported operations, geographic scope, tool versions, license, cache freshness, rate ceiling and permission class. Only providers with a reviewed adapter in this repository may be registered.

ACTIVATION: no provider is registered by default. `createConfiguredToolRegistry` reads ACTIVE `tool_configurations` and registers only reviewed adapters. A configured provider whose deployment switch (`QEYNOX_WORLD_BANK_ENABLED`) is off, whose egress attestation/host allowlist is absent, or whose connector has no reviewed adapter fails closed with NOT_CONFIGURED. Operator input may only tighten the reviewed declaration: connector identity, mode and tool versions must match; regions/operations must be a subset; the rate limit must be between 1 and the reviewed ceiling. Licence notes, freshness and capability descriptions always come from reviewed code, never from configuration.

World Bank Indicators API v2 is the first concretely documented READ-only source adapter: `GET https://api.worldbank.org/v2/country/{code}/indicator/{id}?format=json`, documented at https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures. It was activated in isolated QA and performed a real read-only HTTPS call for `USA/NY.GDP.MKTP.CD`; the retrieved value and documented citation URI were preserved as unverified source/evidence/snapshot records. No provider data was fabricated. A second research provider was deliberately NOT added: no documented endpoint, licence/attribution terms and provisioning were available, so adding one would invent a provider.

EGRESS/SSRF: provider requests must be HTTPS, use a host on the operator-declared `QEYNOX_EGRESS_ALLOWED_HOSTS` allowlist, contain no embedded credentials and use no non-standard port; redirects are refused and response size/time caps apply. Request schemas are fixed Zod contracts so agents cannot inject URLs. A host allowlist is NOT a complete SSRF/DNS-rebinding defence; pinned network egress and DNS/IP controls remain deployment requirements behind the `QEYNOX_NETWORK_POLICY_ATTESTED` operator attestation.

LIMITS: `ToolBroker` enforces permissions, profile/capability allowlists, consent scopes, tool-call/cost budgets, WRITE-intent approvals and a per-connector sliding-window provider rate limit before reserving the durable ledger. The limiter is in-process; multi-worker deployments need a shared limiter or rely on provider quotas.

CREDENTIALS: secrets never live in configuration payloads; strict schemas reject unknown manifest fields and only allow a named `credentialRef`. Provider credentials stay server-side in deployment environment/secret storage. World Bank requires no credential.

PROVENANCE: every broker call records a durable intent and ledger outcome, and mediated provider observations persist a Source plus immutable `source_snapshots` metadata (provider, retrieval time, SHA-256 response digest, citation URI). These remain UNVERIFIED evidence; no source is automatically a supported fact.

MCP: no MCP gateway, server or transport is configured by QeyNox. The MCP boundary contract exists only to state that MCP tools must be registered as reviewed connectors and routed through ToolBroker; unconfigured MCP calls fail closed with UNSUPPORTED.

Generic JSON HTTP remains disabled until a pinned-network transport safely protects against SSRF, DNS rebinding, metadata endpoints and redirects; checking a URL string is insufficient. No unrestricted browsing or MCP tools are available.

