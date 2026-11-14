-- Additive indexes for global platform user administration.
--
-- No identity data is altered and no table is created: this migration only supports the paginated
-- user list (registration order), session management per user, and the per-user activity timeline
-- queried by the platform users-management API. Migration 0001-0012 are untouched.

CREATE INDEX IF NOT EXISTS identity_user_created_idx ON identity_users (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS identity_session_user_idx ON identity_sessions (user_id);
CREATE INDEX IF NOT EXISTS identity_audit_user_idx ON identity_audit (user_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_target_idx ON platform_admin_audit (target_type, target_id, happened_at DESC);
