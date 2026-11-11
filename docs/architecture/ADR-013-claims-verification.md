# ADR-013 — Claim verification is an assessed state

QeyNox separates data acquisition from factual support. A provider response creates an UNVERIFIED Source/Evidence record. Each claim is attributed to its generating step/profile and linked to concrete source IDs. A versioned capability policy controls permitted providers, source age, minimum number of distinct sources and whether a human reviewer must inspect it. SUPPORTED requires eligible evidence, and contradictory evidence blocks automatic promotion.

Policy assessment is not an objective measure of truth. Missing publishedAt remains unknown, and retrieval time alone is not proof of publication freshness. Humans can mark DISPROVEN or CONFLICTING with recorded rationale; human SUPPORTED still requires eligible linked sources.

The claim and assessment histories are stored separately. Tenant-scoped reads do not expose other workspaces. Current claim status is a projection; historical assessments remain immutable. All runtime assertions remain UNTESTED.
