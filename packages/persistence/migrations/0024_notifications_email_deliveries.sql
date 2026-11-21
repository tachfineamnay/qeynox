-- MISSION A19 — real e-mail delivery and notifications.
--
-- notifications:          per-user inbox. One row per event (deduplication_key is unique), so a
--                         retried code path never produces a duplicate row. read_at NULL = unread.
-- email_deliveries:       durable outbox + outcome ledger. Every send attempt (transient codes,
--                         provider message id, next retry) is recorded. deduplication_key is
--                         unique, so re-entering the same send path is safe: it re-reads or
--                         re-attempts the same row, never re-sends blindly.
-- notification_preferences: per-user EMAIL opt-out per customer-facing category. Transactional
--                         e-mails (verification, recovery, invitation) are not opt-out-able.
-- Additive only; no existing table is modified.

CREATE TABLE IF NOT EXISTS notifications (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  workspace_id       text,
  kind               text NOT NULL
                     CONSTRAINT notifications_kind_check CHECK (kind IN ('APPROVALS', 'EXECUTION_FAILURES', 'RESULTS')),
  title              text NOT NULL,
  body               text NOT NULL,
  operation_id       text,
  link_path          text,
  deduplication_key  text NOT NULL UNIQUE,
  read_at            timestamp with time zone,
  created_at         timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id, created_at DESC, id DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS email_deliveries (
  id                 text PRIMARY KEY,
  user_id            text REFERENCES identity_users(id) ON DELETE SET NULL,
  workspace_id       text,
  category           text NOT NULL,
  recipient          text NOT NULL,
  subject            text NOT NULL,
  provider           text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING'
                     CONSTRAINT email_deliveries_status_check CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempt_count      integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 3,
  next_retry_at      timestamp with time zone NOT NULL DEFAULT now(),
  last_error_code    text,
  provider_message_id text,
  template_id        text,
  template_vars      jsonb,
  locale             text,
  retryable          boolean NOT NULL DEFAULT true,
  deduplication_key  text NOT NULL UNIQUE,
  notification_id    text REFERENCES notifications(id) ON DELETE SET NULL,
  created_at         timestamp with time zone NOT NULL DEFAULT now(),
  updated_at         timestamp with time zone NOT NULL DEFAULT now(),
  sent_at            timestamp with time zone
);
CREATE INDEX IF NOT EXISTS email_deliveries_due_idx ON email_deliveries (status, next_retry_at);
CREATE INDEX IF NOT EXISTS email_deliveries_user_idx ON email_deliveries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id            text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  category           text NOT NULL
                     CONSTRAINT notification_preferences_category_check CHECK (category IN ('APPROVALS', 'EXECUTION_FAILURES', 'RESULTS')),
  email_enabled      boolean NOT NULL DEFAULT true,
  updated_at         timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
