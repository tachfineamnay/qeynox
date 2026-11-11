# ADR-012 — Provider manifests and research connectors

QeyNox permits extensible reviewed connector bundles, not universal unrestricted network access. A versioned provider manifest declares supported operations, geographic scope, tool versions, license, cache freshness, rate ceiling and permission class.

World Bank Indicators API v2 is the first concretely documented READ-only source adapter: `GET https://api.worldbank.org/v2/country/{code}/indicator/{id}?format=json`. Documentation: https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures. This adapter is **not enabled by default**; outbound network allowlisting must be configured in infrastructure. No provider call occurred during source authoring. Data publication may lag retrieval.

Generic JSON HTTP remains disabled until a pinned-network transport safely protects against SSRF, DNS rebinding, metadata endpoints and redirects; checking a URL string is insufficient. MCP support remains UNSUPPORTED unless a reviewed gateway is added.

No source is automatically a verified factual claim. Normalized observations carry provider, query and response digests, retrieval time, source URL and unresolved limitations.
