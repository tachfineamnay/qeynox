-- MISSION P12 — durable storage-deletion intents for the document vault (additive).
--
-- Defect: deleting a document (or purging an expired one) ignored object-storage errors and still
-- deleted the PostgreSQL row, so a failed S3 delete left an orphaned private object with no record.
--
-- Now access is revoked first, in ONE transaction that removes the document row (cascading chunks,
-- mission attachments and ingest jobs) and inserts the intent below. The object is then deleted and
-- verified absent by a retried, lease-protected sweep. Success is recorded only after verification.
--
-- No foreign keys on purpose: the intent must outlive the document row and even the workspace, or a
-- workspace deletion could cascade away the only record of an object still in storage. It keeps only
-- what safe cleanup and recovery need (storage key, SHA-256, size, content type, state at deletion,
-- reason, requester); the document name and content are not retained.
--
-- States: PENDING (to delete / retry) -> DELETED (object verified absent) | FAILED (attempts exhausted;
-- the object may still exist and needs operator attention). No existing table is changed.

CREATE TABLE IF NOT EXISTS document_storage_deletions (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL,
  document_id      text NOT NULL UNIQUE,
  storage_key      text NOT NULL,
  sha256           text NOT NULL,
  size_bytes       integer NOT NULL,
  content_type     text NOT NULL,
  document_state   text NOT NULL,
  reason           text NOT NULL,
  requested_by     text,
  state            text NOT NULL DEFAULT 'PENDING',
  attempts         integer NOT NULL DEFAULT 0,
  last_error_code  text,
  not_before       timestamptz NOT NULL DEFAULT now(),
  lease_token      text,
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT document_storage_deletions_state_check CHECK (state IN ('PENDING', 'DELETED', 'FAILED')),
  CONSTRAINT document_storage_deletions_reason_check CHECK (reason IN ('USER_DELETE', 'RETENTION_EXPIRED'))
);

CREATE INDEX IF NOT EXISTS document_storage_deletions_due_idx
  ON document_storage_deletions (not_before)
  WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS document_storage_deletions_workspace_idx
  ON document_storage_deletions (workspace_id, created_at);
