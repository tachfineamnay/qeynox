# MISSION A17 — Documents, files and tenant-safe knowledge

Branch `arena/ea3cf859-qeynox` (off `99169ae`, the A15 merge). One draft PR; not merged; never deployed.

## What exists

- **Migration `0022_document_vault.sql`** (never applied to production; applied only inside disposable QA databases): `documents`, `document_chunks` (generated `search_vector tsvector` from `text`, GIN, `embedding_json jsonb`), `operation_documents` (mission link), `document_ingest_jobs`, `document_audit_events`.
- **`DocumentVaultService`** (`packages/application/src/documents.ts`): declare → presigned single-PUT → complete (size + SHA-256 verified against the stored bytes — the declared hash is discarded on mismatch, `sha256_mismatch` audit) → extraction → chunking → ingest → retrieval with citations → attach/detach → revoke/delete (object + rows + attachments; audit kept) → retention expiry + purge. Business verification and ingestion/retrieval are strictly separate modules.
- **Extraction** (never fabricated): PDF via pdf-parse v2.4.5 (destroyed after `getText()`), DOCX via mammoth over `fflate`-unzipped `word/document.xml` text, `text/plain`, `text/markdown`, `text/csv`. Magic-byte sniffing at complete; unsupported/corrupt input fails with `extractionCode`, never with invented content.
- **Retrieval**: tenant-scoped PostgreSQL full-text search (`websearch_to_tsquery('simple', …)` + `ts_rank` + `ts_headline` snippets) — the guaranteed path. Optional embeddings are operator-configured only (`QEYNOX_EMBEDDINGS_ENABLED=true` + HTTPS endpoint + key + model + ALLOWED_HOSTS + egress attestation); vectors stored as JSONB; HYBRID ranking `0.65·min(1, rank) + 0.35·(cosine+1)/2` degrades to FTS when the provider is absent, fails or returns nothing. No embedding provider is configured on this deployment and none is claimed.
- **Citations**: `{ citationId, documentId, chunkId, name, sha256, page, ordinal, snippet, score, mode }` — every citation ties to a real uploaded document + chunk and carries the document SHA-256.
- **Tenant safety**: every query is workspace-scoped; attach/detach goes through the workspace-asserted operations lookup; cross-tenant reads/exports are not reachable. Retention (1–3650 days) is enforced by `expiresAt` + a purge sweep; deletion cascades chunks, attachments and job rows (FK cascade), writes an audit row and attempts best-effort object removal.
- **Worker**: `startDocumentIngestPoller()` (env `QEYNOX_DOCUMENT_INGEST_INTERVAL_MS`, default 5000, 0 disables) drains `document_ingest_jobs` and `purgeExpired`; idle without `QEYNOX_ARTIFACT_ACCESS_KEY/SECRET_KEY/BUCKET`.
- **API**: `POST /v1/documents/begin`, `POST /v1/documents/:id/complete` (plus best-effort immediate drain), `GET /v1/documents`, `GET /v1/documents/:id`, `GET /v1/documents/:id/download`, `POST /v1/documents/search`, `DELETE /v1/documents/:id`, `POST/DELETE /v1/operations/:operationId/documents/:documentId/attach|detach`, `GET /v1/operations/:operationId/vault-documents`. The vault route deliberately does **not** reuse `/v1/operations/:operationId/documents` — that path is the result-documents controller; shadowing it was avoided by design.
- **Web**: `/[lang]/documents` (Professional Blue, EN/FR): upload (client-side SHA-256, direct-to-storage PUT, complete handshake), processing refresher, full-text search with citation cards, delete (explicit confirm) + signed download grant on demand. Mission detail page gains an attach/detach card for vault files (separate from result documents).
- **`.env.example`**: `QEYNOX_DOCUMENT_INGEST_INTERVAL_MS`, embeddings contract with an FTS-only honesty note.

## Verified (2026-11-19, disposable PostgreSQL only — never production)

- `qa:documents` **77 assertions PASS** (PART 1: chunker bounds/ordinals/page preservation, cosine, embedding gates, policy constants — 18; PART 2: gates, PDF/DOCX/text happy paths, idempotent replay, FTS citation checks, tenant-B isolation, attach/detach, garbage → FAILED, SHA-256 mismatch → discarded + `sha256_mismatch`, magic-byte sniffing, HYBRID vs degrade-to-FTS, retention expiry + purge, revoke cascade, audit-action coverage — 59). Uses an in-memory fake object store — **test infrastructure, not a product fallback**.
- `qa:task02` **3847 assertions PASS** (schema parity vs migration 0022 included). The checker was extended, not weakened: `custom`→`bytea` mapping for the A14 customType, undeclared columns allowed only as server-`GENERATED ALWAYS` with a text-derivation expression assert, and undeclared indexes allowed only when every key column is generated-always and the index is non-unique; drizzle now declares `documents_expiry_idx` (partial), `documents_size_check`, `documents_retention_check`.
- `qa:agent-runtime` **65 assertions PASS**. `pnpm typecheck` 4/4 clean. `pnpm build` 4/4 clean (route `/[lang]/documents` present).

## BLOCKED / not claimed

- **Real object storage (S3)**: no MinIO/docker in this sandbox; the documents QA storage leg ran against the in-memory fake only. Production bucket remains unconfigured. NOT verified against real S3.
- **Embeddings**: none configured; HYBRID path exercised only through the deterministic QA token-hash double; degrade-to-FTS verified; no provider call made, no claim of one.
- **`qa:connectors`, `qa:raas`**: live-provider legs fail with "Client network socket disconnected before secure TLS connection was established" (sandbox TLS blocked). Pre-existing; not chased; no fixture substituted.
- **pgvector**: not used and not verified (JSONB vectors + FTS only).
- **Migration 0022**: not applied to any production database; production untouched.
- **Mission attach UI**: renders and refreshes from the API; a full browser pass was not performed (no installable Chromium in this sandbox).
- `qa:backend` remains pre-existing-failing and untouched.
