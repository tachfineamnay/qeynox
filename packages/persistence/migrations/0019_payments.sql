-- MISSION A08 — Stripe-backed one-time payments for versioned RaaS offers.
--
-- Money is recorded as integer minor units only. Provider identifiers are stored so that every local
-- state can be traced back to the provider object that proves it; nothing here is ever inferred from a
-- browser redirect.
--
-- The existing raas_payment_events table already carried a UNIQUE provider_event_id, which is the
-- durability primitive for exactly-once webhook processing. This migration makes it able to record an
-- event that arrives before its order can be resolved (order_id becomes nullable) and adds the columns
-- the ledger needs to prove what happened, in what order, and with which outcome.

ALTER TABLE raas_payment_events ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'stripe';
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS payment_id text;
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS processed_at text;
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS provider_created_at text;
ALTER TABLE raas_payment_events ADD COLUMN IF NOT EXISTS payload_digest text;
-- Provider event ids are stored namespaced ("stripe:evt_...") so the pre-existing global UNIQUE on
-- provider_event_id is simultaneously the per-provider uniqueness guarantee. No second index is needed.
COMMENT ON COLUMN raas_payment_events.provider_event_id IS 'Namespaced as <provider>:<event_id>; globally UNIQUE';
CREATE INDEX IF NOT EXISTS raas_payment_event_order_index ON raas_payment_events(order_id);

-- One row per payment attempt against an order. Several attempts may exist over time (a failed or
-- expired attempt is followed by a new one), but the partial unique index below makes a second *live*
-- attempt on the same order impossible, which is what prevents a double charge.
CREATE TABLE IF NOT EXISTS raas_payments(
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  operation_id text NOT NULL,
  order_id text NOT NULL,
  provider text NOT NULL DEFAULT 'stripe',
  provider_session_id text,
  provider_intent_id text,
  status text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  captured_minor integer NOT NULL DEFAULT 0,
  refunded_minor integer NOT NULL DEFAULT 0,
  checkout_url text,
  expires_at text,
  idempotency_key text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  failure_code text,
  failure_message text,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT raas_payment_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT raas_payment_captured_within_amount CHECK (captured_minor >= 0 AND captured_minor <= amount_minor),
  CONSTRAINT raas_payment_refunded_within_captured CHECK (refunded_minor >= 0 AND refunded_minor <= captured_minor)
);
CREATE UNIQUE INDEX IF NOT EXISTS raas_payment_idempotency_unique ON raas_payments(workspace_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS raas_payment_intent_unique ON raas_payments(provider, provider_intent_id) WHERE provider_intent_id IS NOT NULL;
-- At most one attempt per order may be in a state that could still take money.
CREATE UNIQUE INDEX IF NOT EXISTS raas_payment_one_live_per_order ON raas_payments(order_id)
  WHERE status IN ('CREATED','REQUIRES_ACTION','PROCESSING','AUTHORIZED','CAPTURED','DISPUTED');
CREATE INDEX IF NOT EXISTS raas_payment_order_index ON raas_payments(order_id);

-- Refunds are their own auditable records: a refund is attempted, then succeeds or fails, and the
-- amount refunded is derived from the succeeded rows rather than stored as a mutable running total.
CREATE TABLE IF NOT EXISTS raas_refunds(
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  operation_id text NOT NULL,
  order_id text NOT NULL,
  payment_id text NOT NULL,
  provider text NOT NULL DEFAULT 'stripe',
  provider_refund_id text,
  status text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  reason text,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  failure_message text,
  CONSTRAINT raas_refund_amount_positive CHECK (amount_minor > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS raas_refund_idempotency_unique ON raas_refunds(workspace_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS raas_refund_provider_unique ON raas_refunds(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS raas_refund_payment_index ON raas_refunds(payment_id);
