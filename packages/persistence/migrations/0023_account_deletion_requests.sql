-- MISSION A18 — customer self-service account deletion requests.
--
-- A deletion request is a *request*, not a deletion: the row records the customer's stated intent,
-- its status and when it was made or cancelled. Nothing in this table erases data. Actual erasure is
-- an operator procedure bound to the identity-hardening gates and is deliberately not automated here.
-- Additive only; no existing table is modified.

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  reason      text,
  status      text NOT NULL DEFAULT 'REQUESTED'
              CONSTRAINT account_deletion_status_check CHECK (status IN ('REQUESTED', 'CANCELLED')),
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  updated_at  timestamp with time zone NOT NULL DEFAULT now()
);

-- At most one live (REQUESTED) request per account.
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_live_user_unique
  ON account_deletion_requests (user_id) WHERE status = 'REQUESTED';
CREATE INDEX IF NOT EXISTS account_deletion_user_idx
  ON account_deletion_requests (user_id, created_at);
