-- QeyNox global platform administration.
--
-- Deliberately separate from workspace identity: platform roles (PLATFORM_ADMIN / SUPPORT /
-- OPERATIONS / AUDITOR) are stored here and never in identity_memberships, whose OWNER / ADMIN /
-- MEMBER roles remain strictly workspace-scoped. A workspace session cannot authenticate these
-- tables and a platform session never selects a workspace. No credential is duplicated: platform
-- administrators reuse identity_users / identity_credentials and get their own session namespace.

CREATE TABLE IF NOT EXISTS platform_admin_assignments (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id),
  role text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  granted_by text NOT NULL,
  grant_reason text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoke_reason text,
  revoked_at timestamptz,
  CONSTRAINT platform_admin_role_range CHECK (role IN ('PLATFORM_ADMIN', 'SUPPORT', 'OPERATIONS', 'AUDITOR')),
  CONSTRAINT platform_admin_status_range CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT platform_admin_revocation_consistent CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

-- One active assignment per user and role; revoked history is retained.
CREATE UNIQUE INDEX IF NOT EXISTS platform_admin_active_user_role_unique
  ON platform_admin_assignments (user_id, role) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS platform_admin_assignment_user_idx
  ON platform_admin_assignments (user_id, status);

-- Separate session namespace: workspace bearer tokens (identity_sessions) can never authenticate
-- a platform route, and platform tokens are rejected by the workspace authentication guard.
CREATE TABLE IF NOT EXISTS platform_admin_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS platform_admin_session_expiry_idx ON platform_admin_sessions (expires_at);
CREATE INDEX IF NOT EXISTS platform_admin_session_user_idx ON platform_admin_sessions (user_id);

-- Audit trail: actor, target, action, permission, date and result for every platform outcome.
CREATE TABLE IF NOT EXISTS platform_admin_audit (
  id text PRIMARY KEY,
  actor_user_id text,
  actor_session_id text,
  target_type text NOT NULL,
  target_id text,
  action text NOT NULL,
  permission text,
  outcome text NOT NULL,
  reason text,
  detail jsonb,
  happened_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_audit_outcome_range CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR')),
  CONSTRAINT platform_audit_action_present CHECK (length(action) > 0)
);
CREATE INDEX IF NOT EXISTS platform_audit_time_idx ON platform_admin_audit (happened_at);
CREATE INDEX IF NOT EXISTS platform_audit_actor_idx ON platform_admin_audit (actor_user_id, happened_at);
CREATE INDEX IF NOT EXISTS platform_audit_action_idx ON platform_admin_audit (action, happened_at);

-- Append-only enforcement: no UPDATE/DELETE path, including through a compromised application
-- credential. A migration or superuser can still maintain the table deliberately.
CREATE OR REPLACE FUNCTION platform_admin_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_admin_audit is append-only (action %, outcome %)', OLD.action, OLD.outcome
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_admin_audit_no_update ON platform_admin_audit;
CREATE TRIGGER platform_admin_audit_no_update
  BEFORE UPDATE OR DELETE ON platform_admin_audit
  FOR EACH ROW EXECUTE FUNCTION platform_admin_audit_append_only();
