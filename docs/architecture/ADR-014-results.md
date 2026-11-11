# ADR-014 — Results are stable versioned objects

Each ResultDocument carries objective, findings with claim IDs, attempt provenance, citations, unresolved items and a quality state independent of chat history. DRAFT and PARTIAL are never automatically DELIVERABLE; READY_FOR_REVIEW still requires explicit acceptance. Revisions append documents, never mutate earlier versions.

CITATIONS: each finding carries citations resolved from its linked sources (provider, http(s) URI, retrieval time, publication date when known and captured response digest). A SUPPORTED claim without a verifiable citation is treated as unresolved for deliverable purposes; the assembler never marks such a document READY_FOR_REVIEW.

REVIEW/DELIVERY: delivery requires an operation in WAITING_APPROVAL, a READY_FOR_REVIEW document for the current revision, a specific APPROVED RESULT_REVIEW approval, all referenced claims currently SUPPORTED, an authorized/explicitly-free commercial order and a verifiable citation for every finding. Delivery appends a new immutable DELIVERABLE document version (prior version retained as READY_FOR_REVIEW), records reviewer identity/time, sets the order DELIVERED, transitions the operation to COMPLETED and emits RESULT_DELIVERED.

EXPORTS: JSON is deterministic and HTML escapes all untrusted content and renders citations as links only for http(s) URIs. S3-compatible storage remains private and uses unique workspace/operation/result IDs, SHA-256 digests and short-lived signed read grants. Artifact metadata is inserted as PENDING_UPLOAD before upload; only a digest-verified upload becomes AVAILABLE. A storage failure leaves PENDING_UPLOAD metadata for reconciliation and must never be presented as AVAILABLE.

No PDF/audio renderer is configured. Production object storage is not configured or certified; isolated QA exercised the storage contract with a local contract implementation and verified the fail-closed unconfigured path.
