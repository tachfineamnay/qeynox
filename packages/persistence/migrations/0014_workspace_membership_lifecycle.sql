-- Workspace/organisation membership lifecycle (additive only).
--
-- identity_workspaces and identity_memberships remain the single organisation entity: no second
-- organisation table is introduced. These columns make invitations, role changes and revocations
-- traceable and let member listings show when a membership started.
ALTER TABLE identity_memberships ADD COLUMN IF NOT EXISTS invited_by text;
ALTER TABLE identity_memberships ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE identity_memberships ADD COLUMN IF NOT EXISTS joined_at timestamptz;
ALTER TABLE identity_memberships ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Member listing by workspace/status and invitation lookup by user/status.
CREATE INDEX IF NOT EXISTS identity_membership_workspace_status_idx ON identity_memberships (workspace_id, status);
CREATE INDEX IF NOT EXISTS identity_membership_user_status_idx ON identity_memberships (user_id, status);
