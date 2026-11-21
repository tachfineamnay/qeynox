-- MISSION A20 — Global Atlas library indexes and controlled result share links.
--
-- Canonical result storage remains result_documents and artifact_objects (migration 0005).
-- No second result document store is created: result_share_links references result_documents(id)
-- and stores only a SHA-256 token digest, expiry, revocation and access metadata.

CREATE INDEX IF NOT EXISTS result_documents_workspace_created_idx
  ON result_documents (workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS result_documents_workspace_state_created_idx
  ON result_documents (workspace_id, state, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS result_documents_workspace_op_version_idx
  ON result_documents (workspace_id, operation_id, version DESC);

CREATE INDEX IF NOT EXISTS artifact_objects_workspace_doc_state_idx
  ON artifact_objects (workspace_id, document_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS result_share_links (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  operation_id     text NOT NULL,
  document_id      text NOT NULL REFERENCES result_documents(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  label            text,
  created_by       text NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  expires_at       timestamp with time zone NOT NULL,
  revoked_at       timestamp with time zone,
  revoked_by       text REFERENCES identity_users(id) ON DELETE SET NULL,
  last_accessed_at timestamp with time zone,
  access_count     integer NOT NULL DEFAULT 0
                   CONSTRAINT result_share_links_access_count_check CHECK (access_count >= 0)
);

CREATE INDEX IF NOT EXISTS result_share_links_workspace_doc_idx
  ON result_share_links (workspace_id, document_id, created_at DESC);
