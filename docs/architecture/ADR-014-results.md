# ADR-014 — Results are stable versioned objects

Each ResultDocument carries objective, findings with claim IDs, source IDs, attempt provenance, unresolved items and a quality state independent of chat history. DRAFT and PARTIAL are never automatically DELIVERABLE; READY_FOR_REVIEW still requires explicit acceptance. Revisions append documents, never mutate earlier versions.

JSON and semantic HTML exports are deterministic and escape untrusted content. S3-compatible storage is private and uses unique workspace/operation/result IDs, SHA-256 digests and a short-lived signed read grant. A storage failure leaves a PENDING_UPLOAD metadata record for reconciliation; it must not be presented as AVAILABLE. The selected S3 SDK provides a documented PutObjectCommand/GetObjectCommand and presigning. Compatibility with the user's object store and its encryption/versioning semantics still requires verification.

No PDF/audio renderer is configured. Nothing has been compiled, uploaded, exported or deployed.
