# Mission A20 — Global Atlas Library

## 1. Canonical Reuse & Zero-Duplication Guarantee

The Global Atlas Library (`/[lang]/results`) is built strictly on top of QeyNox's existing canonical result and artifact infrastructure:

- **Canonical Document Store**: `result_documents` (`packages/persistence/src/result-schema.ts`) assembled by `ResultAssembler` and promoted to `DELIVERABLE` by `ResultDeliveryService`. No second result document table or cached copy exists.
- **Evidence & Truthfulness Classification**: `classifyDocument` / `classifyFinding` (`packages/application/src/result-presentation.ts`) remain the single classifier across mission views, Global Atlas Library cards, version comparisons, shared views, and exports.
- **Deterministic Exports & Private S3 Artifacts**: `exportPdf`, `exportHtml`, `exportJson`, `ArtifactDelivery`, and `S3ArtifactStore` (`packages/application/src/result-export.ts`, `artifacts.ts`, `s3.ts`) produce byte-reproducible artifacts stored in private object storage and served via 180-second AWS SigV4 presigned URLs.

## 2. Persistence (`0025_atlas_library_shares.sql`)

Migration `0025_atlas_library_shares.sql` adds:

1. Read-path indexes on `result_documents(workspace_id, created_at DESC, id DESC)`, `result_documents(workspace_id, state, created_at DESC)`, `result_documents(operation_id, version DESC)`, and `artifact_objects(workspace_id, document_id, state)`.
2. `result_share_links` storing **governance metadata only** (`id`, `workspace_id`, `operation_id`, `document_id`, `token_hash` SHA-256 hex, `label`, `created_by`, `created_at`, `expires_at`, `revoked_at`, `revoked_by`, `access_count`, `last_accessed_at`). Raw share tokens are never stored in PostgreSQL or written to `operation_events`.

## 3. Verification Posture & Honest Empty / Failed / Degraded States

`deriveVerificationPosture(doc, classified)` (`packages/application/src/atlas-library.ts`) enforces conservative customer-facing labels:

- `VERIFIED_DELIVERABLE`: `doc.status === 'DELIVERABLE'`, at least one `VERIFIED` finding, and zero `UNRESOLVED` or `AWAITING_ASSESSMENT` items.
- `AWAITING_REVIEW`: `doc.status === 'READY_FOR_REVIEW'`, at least one `VERIFIED` finding, and zero `UNRESOLVED` or `AWAITING_ASSESSMENT` items.
- `PARTIALLY_VERIFIED`: `counts.VERIFIED > 0` alongside unresolved/unassessed findings or `DRAFT`/`PARTIAL` document status.
- `UNVERIFIED`: `counts.VERIFIED === 0` (never labeled `PARTIALLY_VERIFIED` when zero findings have verifiable citations).

Failed or interrupted workspace missions that never produced a `ResultDocument` are surfaced explicitly in `failedOperations` rather than fabricating synthetic result rows. Unconfigured S3 object storage (`artifactStoreConfigured === false`) disables new export triggers with an explicit disclosure and fails closed with `503 NOT_CONFIGURED` on direct API invocation.

## 4. Controlled Sharing & RBAC

- **Workspace Read Access**: Active `OWNER`, `ADMIN`, and `MEMBER` principals can search, filter, paginate, compare versions, and download internal workspace exports for their active workspace only. Cross-workspace queries return `404 NOT_FOUND` without leaking document existence.
- **Share Governance (`OWNER` / `ADMIN` only)**: Only reviewed `DELIVERABLE` documents can be shared (`409 INVALID_STATE` otherwise), bounded to `1..720` hours (`expiresInHours`), with immediate revocation (`POST /v1/results/:documentId/shares/:shareId/revoke`).
- **Sanitized External Reader**: `@PublicRoute() GET /v1/public/shared-results/:token` and `/[lang]/results/shared/[token]` (`robots: noindex, nofollow` + `/robots.txt` disallow) strip internal `workspaceId`, reviewer user IDs, and internal step attempt IDs, and redact any URL-embedded credentials.
