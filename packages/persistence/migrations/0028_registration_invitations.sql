-- MISSION A21.05 — Invite-only registration (additive).
--
-- registration_invitations: one operator-issued, single-use invitation to CREATE an account and a
--                           new workspace. Unlike beta_grants (migration 0026), it is not bound to an
--                           existing workspace: it is bound to an e-mail address. Only the SHA-256
--                           digest of the invitation token is stored. It carries the beta terms that
--                           become an ACTIVE beta grant for the new workspace, created in the same
--                           transaction as the account, so an invited registrant is enrolled in the
--                           beta atomically and a redemption can never leave a half-created account.
--
-- Statuses: PENDING -> REDEEMED (signup) | EXPIRED (time, materialised lazily) | REVOKED (operator).
-- At most one PENDING invitation per e-mail address.
--
-- No existing table, column or constraint is changed. Operator actions are additionally recorded
-- in platform_admin_audit (migration 0012) in the same transaction as the mutation.

CREATE TABLE IF NOT EXISTS registration_invitations (
  id                        text PRIMARY KEY,
  email                     text NOT NULL,
  token_hash                text NOT NULL UNIQUE,
  status                    text NOT NULL DEFAULT 'PENDING',
  expires_at                timestamp with time zone NOT NULL,
  beta_expires_at           timestamp with time zone NOT NULL,
  mission_quota             integer NOT NULL,
  concurrent_limit          integer NOT NULL,
  max_provider_spend_minor  integer NOT NULL,
  currency                  text NOT NULL,
  created_by                text NOT NULL REFERENCES identity_users(id),
  reason                    text NOT NULL,
  created_at                timestamp with time zone NOT NULL DEFAULT now(),
  redeemed_at               timestamp with time zone,
  redeemed_user_id          text REFERENCES identity_users(id),
  redeemed_workspace_id     text REFERENCES identity_workspaces(id),
  beta_grant_id             text REFERENCES beta_grants(id),
  revoked_at                timestamp with time zone,
  revoked_by                text REFERENCES identity_users(id),
  revoke_reason             text,
  updated_at                timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT registration_invitations_status_range CHECK (status IN ('PENDING', 'REDEEMED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT registration_invitations_email_normalised CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  CONSTRAINT registration_invitations_quota_range CHECK (mission_quota BETWEEN 1 AND 10000),
  CONSTRAINT registration_invitations_concurrency_range CHECK (concurrent_limit BETWEEN 1 AND 100),
  CONSTRAINT registration_invitations_spend_range CHECK (max_provider_spend_minor BETWEEN 0 AND 100000000),
  CONSTRAINT registration_invitations_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT registration_invitations_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT registration_invitations_beta_outlives_invitation CHECK (beta_expires_at >= expires_at),
  CONSTRAINT registration_invitations_redemption_consistent CHECK ((status = 'REDEEMED') = (redeemed_at IS NOT NULL AND redeemed_user_id IS NOT NULL AND redeemed_workspace_id IS NOT NULL AND beta_grant_id IS NOT NULL)),
  CONSTRAINT registration_invitations_revocation_consistent CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CONSTRAINT registration_invitations_reason_length CHECK (length(reason) BETWEEN 10 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS registration_invitations_pending_email_unique
  ON registration_invitations (email) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS registration_invitations_status_expiry_idx
  ON registration_invitations (status, expires_at);
CREATE INDEX IF NOT EXISTS registration_invitations_created_idx
  ON registration_invitations (created_at DESC);
