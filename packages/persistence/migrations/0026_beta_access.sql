-- MISSION A21.02 — Invite-only beta access (additive).
--
-- beta_grants:          one workspace-scoped grant per row. Created INVITED by an authorized platform
--                       operator (only the SHA-256 digest of the single-use invitation token is
--                       stored), activated by an OWNER/ADMIN of the workspace, ended by expiry or
--                       operator revocation. At most one live (INVITED/ACTIVE) grant per workspace.
--                       Usage counters are mutated only under a row lock on the grant; CHECK
--                       constraints are a database-level backstop for the mission quota and the
--                       provider-spend cap.
-- beta_grant_missions:  one row per (grant, operation) admission — a mission consumes quota once.
-- beta_grant_events:    append-only lifecycle and usage ledger (grant, activation, revocation,
--                       expiry, admissions, denials, provider-spend reservations/settlements).
--
-- No existing table, column or constraint is changed. Operator actions are additionally recorded
-- in platform_admin_audit (migration 0012) in the same transaction as the mutation.

CREATE TABLE IF NOT EXISTS beta_grants (
  id                        text PRIMARY KEY,
  workspace_id              text NOT NULL REFERENCES identity_workspaces(id),
  status                    text NOT NULL DEFAULT 'INVITED',
  expires_at                timestamp with time zone NOT NULL,
  mission_quota             integer NOT NULL,
  concurrent_limit          integer NOT NULL,
  max_provider_spend_minor  integer NOT NULL,
  currency                  text NOT NULL,
  missions_used             integer NOT NULL DEFAULT 0,
  reserved_minor            integer NOT NULL DEFAULT 0,
  spent_minor               integer NOT NULL DEFAULT 0,
  invitation_token_hash     text UNIQUE,
  invitation_expires_at     timestamp with time zone,
  granted_by                text NOT NULL REFERENCES identity_users(id),
  grant_reason              text NOT NULL,
  created_at                timestamp with time zone NOT NULL DEFAULT now(),
  activated_at              timestamp with time zone,
  activated_by              text REFERENCES identity_users(id),
  revoked_at                timestamp with time zone,
  revoked_by                text REFERENCES identity_users(id),
  revoke_reason             text,
  updated_at                timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT beta_grants_status_range CHECK (status IN ('INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED')),
  CONSTRAINT beta_grants_quota_range CHECK (mission_quota BETWEEN 1 AND 10000),
  CONSTRAINT beta_grants_concurrency_range CHECK (concurrent_limit BETWEEN 1 AND 100),
  CONSTRAINT beta_grants_spend_range CHECK (max_provider_spend_minor BETWEEN 0 AND 100000000),
  CONSTRAINT beta_grants_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT beta_grants_missions_within_quota CHECK (missions_used >= 0 AND missions_used <= mission_quota),
  CONSTRAINT beta_grants_spend_within_cap CHECK (reserved_minor >= 0 AND spent_minor >= 0 AND reserved_minor + spent_minor <= max_provider_spend_minor),
  CONSTRAINT beta_grants_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT beta_grants_revocation_consistent CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CONSTRAINT beta_grants_activation_consistent CHECK (status <> 'ACTIVE' OR activated_at IS NOT NULL),
  CONSTRAINT beta_grants_invitation_consistent CHECK (status <> 'INVITED' OR (invitation_token_hash IS NOT NULL AND invitation_expires_at IS NOT NULL)),
  CONSTRAINT beta_grants_reason_length CHECK (length(grant_reason) BETWEEN 10 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS beta_grants_live_workspace_unique
  ON beta_grants (workspace_id) WHERE status IN ('INVITED', 'ACTIVE');
CREATE INDEX IF NOT EXISTS beta_grants_workspace_created_idx
  ON beta_grants (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS beta_grants_status_expiry_idx
  ON beta_grants (status, expires_at);

CREATE TABLE IF NOT EXISTS beta_grant_missions (
  id            text PRIMARY KEY,
  grant_id      text NOT NULL REFERENCES beta_grants(id),
  workspace_id  text NOT NULL REFERENCES identity_workspaces(id),
  operation_id  text NOT NULL,
  admitted_by   text NOT NULL REFERENCES identity_users(id),
  admitted_at   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS beta_grant_missions_grant_operation_unique
  ON beta_grant_missions (grant_id, operation_id);
CREATE INDEX IF NOT EXISTS beta_grant_missions_operation_idx
  ON beta_grant_missions (operation_id, admitted_at DESC);

CREATE TABLE IF NOT EXISTS beta_grant_events (
  id              text PRIMARY KEY,
  grant_id        text REFERENCES beta_grants(id),
  workspace_id    text NOT NULL REFERENCES identity_workspaces(id),
  kind            text NOT NULL,
  actor_user_id   text,
  operation_id    text,
  reservation_id  text,
  amount_minor    integer,
  reason          text,
  detail          jsonb,
  occurred_at     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT beta_grant_events_kind_range CHECK (kind IN ('INVITED', 'ACTIVATED', 'ACTIVATION_DENIED', 'REVOKED', 'EXPIRED', 'MISSION_ADMITTED', 'MISSION_RESUMED', 'LAUNCH_DENIED', 'SPEND_RESERVED', 'SPEND_SETTLED', 'SPEND_DENIED')),
  CONSTRAINT beta_grant_events_amount_nonnegative CHECK (amount_minor IS NULL OR amount_minor >= 0)
);

CREATE INDEX IF NOT EXISTS beta_grant_events_grant_time_idx
  ON beta_grant_events (grant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS beta_grant_events_workspace_time_idx
  ON beta_grant_events (workspace_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS beta_grant_events_reservation_unique
  ON beta_grant_events (reservation_id, kind)
  WHERE reservation_id IS NOT NULL AND kind IN ('SPEND_RESERVED', 'SPEND_SETTLED');
