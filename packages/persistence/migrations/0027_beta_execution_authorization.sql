-- MISSION A21.03 — Free beta execution authorization (additive).
--
-- raas_beta_authorizations: one row per accepted, PRICED scope that an eligible beta workspace may
--                           execute without paying during the free beta. It is a non-financial
--                           entitlement, deliberately separate from raas_payments: no payment,
--                           invoice, checkout session or provider object is ever created for it.
--
-- A row is bound to exactly one workspace, operation, plan revision, quote, terms acceptance, order
-- and accepted scope hash, and to the beta grant that was ACTIVE when it was created. The published
-- list price and currency are recorded unchanged; the amount due now is pinned to 0 by a CHECK. The
-- linked grant is re-verified (status and expiry) at execution start, retry, redo and result
-- delivery, so revoking or expiring the grant stops the work even after authorization.
--
-- The order itself carries the explicit, non-financial state BETA_AUTHORIZED (then BETA_DELIVERED);
-- raas_orders.state is free text (migration 0006), so no existing table, column or constraint is
-- changed here.

CREATE TABLE IF NOT EXISTS raas_beta_authorizations (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES identity_workspaces(id),
  operation_id          text NOT NULL,
  revision_id           text NOT NULL,
  quote_id              text NOT NULL UNIQUE REFERENCES raas_quotes(id),
  acceptance_id         text NOT NULL UNIQUE REFERENCES raas_acceptances(id),
  order_id              text NOT NULL UNIQUE REFERENCES raas_orders(id),
  beta_grant_id         text NOT NULL REFERENCES beta_grants(id),
  scope_hash            text NOT NULL,
  offer_id              text NOT NULL,
  offer_version         integer NOT NULL,
  terms_version         text NOT NULL,
  list_amount_minor     integer NOT NULL,
  currency              text NOT NULL,
  amount_due_now_minor  integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'AUTHORIZED',
  authorized_by         text NOT NULL,
  authorized_at         timestamp with time zone NOT NULL DEFAULT now(),
  delivered_at          timestamp with time zone,
  CONSTRAINT raas_beta_authorizations_amount_due_zero CHECK (amount_due_now_minor = 0),
  CONSTRAINT raas_beta_authorizations_list_amount_positive CHECK (list_amount_minor > 0),
  CONSTRAINT raas_beta_authorizations_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT raas_beta_authorizations_status_range CHECK (status IN ('AUTHORIZED', 'DELIVERED')),
  CONSTRAINT raas_beta_authorizations_delivery_consistent CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS raas_beta_authorization_operation_revision_unique
  ON raas_beta_authorizations (operation_id, revision_id);
CREATE INDEX IF NOT EXISTS raas_beta_authorization_grant_idx
  ON raas_beta_authorizations (beta_grant_id, authorized_at DESC);
CREATE INDEX IF NOT EXISTS raas_beta_authorization_workspace_idx
  ON raas_beta_authorizations (workspace_id, authorized_at DESC);
