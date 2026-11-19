-- MISSION A04 — customer identity completion (additive only).
--
-- No second identity system: these tables extend identity_users, they do not replace credentials,
-- sessions or memberships. A token row stores ONLY a SHA-256 digest — the bearer value is never
-- persisted, so a database read cannot replay a verification or recovery link.

-- E-mail verification state on the existing user row.
-- verified_at IS NULL means "not yet verified". Registration still creates the account and a
-- session (the existing contract), but the account carries an explicit unverified state that the
-- API reports and the UI surfaces, rather than being silently treated as verified.
ALTER TABLE identity_users ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Single-use tokens. One row per issued token; `used_at` marks consumption and `revoked_at`
-- supersedes a token when a newer one is issued for the same purpose (only the newest is valid).
CREATE TABLE IF NOT EXISTS identity_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id),
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  request_fingerprint text,
  CONSTRAINT identity_token_purpose_range CHECK (purpose IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')),
  CONSTRAINT identity_token_lifecycle_consistent CHECK (used_at IS NULL OR revoked_at IS NULL)
);
-- token_hash is declared UNIQUE on the column above: a digest identifies exactly one issued token,
-- so replay cannot be redirected to another user or purpose.
CREATE INDEX IF NOT EXISTS identity_token_user_purpose_idx ON identity_tokens (user_id, purpose);
-- At most one live token per user and purpose: issuing a new one supersedes the previous.
CREATE UNIQUE INDEX IF NOT EXISTS identity_token_live_unique
  ON identity_tokens (user_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Attempt ledger backing the rate limiter.
--
-- It lives in PostgreSQL rather than process memory because the API runs as more than one replica:
-- an in-memory window would let a caller multiply its allowance by the number of instances. The row
-- records a salted hash of the bucket key, never a raw e-mail address or IP.
CREATE TABLE IF NOT EXISTS identity_attempts (
  id text PRIMARY KEY,
  bucket text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_attempt_bucket_idx ON identity_attempts (bucket, attempted_at);
