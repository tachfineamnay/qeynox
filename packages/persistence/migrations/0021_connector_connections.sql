-- MISSION A14 — workspace-scoped connector account connections.
-- Credential material never lands in this table or anywhere plaintext-readable: connection_credentials
-- holds AES-256-GCM ciphertext written by the server-side vault and is never selected into any API or
-- prompt payload. oauth_authorization_states holds single-use hashes of OAuth state values only.
CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_version text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING_AUTHORIZATION',
  external_account_id text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  credential_ref text,
  last_error_code text,
  last_health_check_at timestamptz,
  connected_by text NOT NULL,
  connected_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_workspace_provider_unique ON connections (workspace_id, provider);
CREATE INDEX IF NOT EXISTS connections_state_idx ON connections (state, updated_at);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connections_state_check') THEN
    ALTER TABLE connections ADD CONSTRAINT connections_state_check CHECK (state IN ('PENDING_AUTHORIZATION', 'ACTIVE', 'EXPIRED', 'ERROR', 'REVOKED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS connection_credentials (
  credential_ref text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_credentials_workspace_idx ON connection_credentials (workspace_id, provider);

CREATE TABLE IF NOT EXISTS oauth_authorization_states (
  id text PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_authorization_states (expires_at);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_states_state_check') THEN
    ALTER TABLE oauth_authorization_states ADD CONSTRAINT oauth_states_state_check CHECK (state IN ('PENDING', 'CONSUMED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS connection_audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  connection_id text,
  user_id text,
  action text NOT NULL,
  outcome text NOT NULL,
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_audit_workspace_time_idx ON connection_audit_events (workspace_id, created_at);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_audit_outcome_check') THEN
    ALTER TABLE connection_audit_events ADD CONSTRAINT connection_audit_outcome_check CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILED'));
  END IF;
END $$;
