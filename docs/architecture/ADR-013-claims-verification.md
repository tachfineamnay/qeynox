# ADR-013 — Claim verification is an assessed state

QeyNox separates data acquisition from factual support. A provider response creates an UNVERIFIED Source/Evidence record. Each claim is attributed to its generating step attempt/profile and must be linked to concrete source IDs.

EVIDENCE-BACKED LINKAGE: source count alone is never proof. A SUPPORTS/CONTRADICTS link must name a persisted Evidence observation, that observation must belong to the linked Source, and the link must carry the exact captured provider response digest (source fingerprint). The Evidence must not be DISPUTED or STALE for support. A versioned capability policy controls permitted providers, sources age, minimum distinct evidence-backed sources and whether a human reviewer must inspect it.

FRESHNESS: a source is eligible only if its retrieval time is valid and within the policy age, and — when the provider supplies a publication date — that publication age is also within policy. A missing publication date is recorded in the assessment rationale as `publication freshness unknown`; it is never silently treated as fresh. Links whose sources are stale are recorded as stale, not promoted.

CONTRADICTIONS: any qualifying contradicting evidence blocks promotion and yields CONFLICTING, regardless of supporting count. Human reviewers may mark DISPROVEN or CONFLICTING with recorded rationale; human SUPPORTED still requires enough evidence-backed sources and no unresolved contradiction. A reviewer without an elevated workspace role is denied.

CAPABILITY BINDING: assessment also verifies that the claim's own step attempt belongs to the same operation and that the requested capability matches the capability that produced the step; a mismatched policy/capability is denied.

Policy assessment is not an objective measure of truth. Claim status is a projection; historical assessments remain immutable, and human review remains required where policy demands it. Only SUPPORTED findings can contribute to a DELIVERABLE result, and every deliverable finding must carry a verifiable http(s) citation. All runtime assertions remain UNTESTED beyond the isolated QA scenarios.
