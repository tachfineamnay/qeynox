-- Invitation acceptance tokens for account holders with no active workspace membership.
-- Additive only: no new organisation entity, no deletion.
ALTER TABLE identity_memberships ADD COLUMN IF NOT EXISTS invitation_token_hash text;
ALTER TABLE identity_memberships ADD COLUMN IF NOT EXISTS invitation_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS identity_membership_invitation_token_unique
  ON identity_memberships (invitation_token_hash) WHERE invitation_token_hash IS NOT NULL;
