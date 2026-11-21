-- MISSION P13 — durable, incremental notification-event processing (additive).
--
-- Defect: NotificationService.materialize() re-scanned only the newest N notification-relevant
-- operation_events on each drain, with no record of progress. A burst of more than N events (or a
-- worker outage spanning one) silently skipped the older ones forever.
--
-- notification_event_receipts — one row per processed event: the durable checkpoint. It is inserted
--   in the SAME transaction as that event's inbox rows and e-mail delivery jobs, so an event is
--   either fully materialized (receipt + notifications + deliveries) or not at all, and concurrent
--   workers serialize on the primary key (the loser sees the conflict and skips).
-- notification_checkpoints     — a conservative scan watermark (occurred_at, ISO-8601 text like
--   operation_events.occurred_at). It only bounds how far back the anti-join looks; it never moves
--   past an unprocessed event or closer than a safety lag to "now", so a late-committing event is
--   still found. Correctness comes from the receipts, not from the watermark.
--
-- Existing notifications / email_deliveries rows and their deduplication keys are unchanged.

CREATE TABLE IF NOT EXISTS notification_event_receipts (
  event_id      text PRIMARY KEY,
  workspace_id  text NOT NULL,
  kind          text NOT NULL,
  outcome       text NOT NULL,
  reason        text,
  notifications integer NOT NULL DEFAULT 0,
  deliveries    integer NOT NULL DEFAULT 0,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_event_receipts_outcome_check CHECK (outcome IN ('MATERIALIZED', 'SKIPPED'))
);
CREATE INDEX IF NOT EXISTS notification_event_receipts_workspace_idx
  ON notification_event_receipts (workspace_id, processed_at);

CREATE TABLE IF NOT EXISTS notification_checkpoints (
  name        text PRIMARY KEY,
  watermark   text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Oldest-first scan of the notification-relevant kinds only.
CREATE INDEX IF NOT EXISTS operation_events_notification_scan_idx
  ON operation_events (occurred_at, id)
  WHERE kind IN ('STEPS_COMPLETED_REVIEW_REQUIRED', 'STEP_FAILED', 'STEP_OUTCOME_UNKNOWN', 'RESULT_DELIVERED');
