-- MISSION P14 — exclusive ownership of e-mail delivery attempts (additive).
--
-- Defect: claimDue() incremented attempt_count under FOR UPDATE SKIP LOCKED, but the row stayed a
-- due PENDING row once the claiming transaction committed — before the provider call — so another
-- worker could claim and send the same job concurrently.
--
-- lease_owner / lease_token / lease_expires_at — a claimed row keeps status PENDING but is not
--   claimable while its lease is live. lease_token is a per-claim fencing token: every transition
--   (renew, SENT, retry, FAILED) is conditioned on it. A row whose lease expired was abandoned by a
--   crashed or stalled worker and is recovered by the next claim (a new attempt) or failed terminally.
-- first_attempt_at — when the first provider call was claimed. Resend honours an idempotency key for
--   24 hours, so a delivery whose earlier attempt has an UNCERTAIN outcome is only re-sent inside that
--   window; afterwards it is FAILED instead of risking a duplicate e-mail.
-- outcome_uncertain — an attempt may have reached the provider without a definitive answer (timeout,
--   network error, 5xx, or a worker that died mid-send).
--
-- The status vocabulary (PENDING/SENT/FAILED/SKIPPED), templates, preferences and history are unchanged.

ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS first_attempt_at timestamptz;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS outcome_uncertain boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS email_deliveries_lease_idx
  ON email_deliveries (lease_expires_at)
  WHERE status = 'PENDING' AND lease_token IS NOT NULL;
