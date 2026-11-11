-- Identity, workspace membership and opaque bearer sessions.
CREATE TABLE IF NOT EXISTS identity_users(id text PRIMARY KEY,email text NOT NULL UNIQUE,locale text NOT NULL DEFAULT 'en',created_at timestamptz NOT NULL DEFAULT now(),disabled_at timestamptz);
CREATE TABLE IF NOT EXISTS identity_credentials(user_id text PRIMARY KEY REFERENCES identity_users(id),salt text NOT NULL,password_hash text NOT NULL,failed_attempts integer NOT NULL DEFAULT 0,locked_until timestamptz,changed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS identity_workspaces(id text PRIMARY KEY,name text NOT NULL,created_by text NOT NULL REFERENCES identity_users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS identity_memberships(id text PRIMARY KEY,user_id text NOT NULL REFERENCES identity_users(id),workspace_id text NOT NULL REFERENCES identity_workspaces(id),role text NOT NULL,status text NOT NULL DEFAULT 'ACTIVE',CONSTRAINT identity_member_unique UNIQUE(user_id,workspace_id));
CREATE INDEX IF NOT EXISTS identity_workspace_member_idx ON identity_memberships(workspace_id);
CREATE TABLE IF NOT EXISTS identity_sessions(id text PRIMARY KEY,user_id text NOT NULL REFERENCES identity_users(id),token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz);
CREATE INDEX IF NOT EXISTS identity_session_expiry_idx ON identity_sessions(expires_at);
CREATE TABLE IF NOT EXISTS identity_audit(id text PRIMARY KEY,user_id text,workspace_id text,action text NOT NULL,outcome text NOT NULL,happened_at timestamptz NOT NULL DEFAULT now());
