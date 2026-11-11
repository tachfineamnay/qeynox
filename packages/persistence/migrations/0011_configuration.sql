-- Operator configuration lifecycle: versioned tool, budget-policy and apply records,
-- plus single-active-version integrity for capability, profile, verification and offer configuration.
-- No business definition, provider or price is seeded here: every row is operator-supplied at runtime.

-- Verification policies are immutable versions; only one ACTIVE policy may govern a capability.
ALTER TABLE verification_policies ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS capability_active_slot_unique ON capabilities(slot) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS agent_profile_active_role_unique ON agent_profiles(role_key) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS verification_policy_active_capability_unique ON verification_policies(capability_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS raas_offer_active_id_unique ON raas_offers(id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS tool_configurations(
  id text PRIMARY KEY,
  connector_id text NOT NULL,
  connector_version text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  digest text NOT NULL,
  configured_by text NOT NULL,
  configured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_configuration_status_range CHECK (status IN ('ACTIVE','DISABLED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_configuration_connector_version_unique ON tool_configurations(connector_id, connector_version);
CREATE UNIQUE INDEX IF NOT EXISTS tool_configuration_active_connector_unique ON tool_configurations(connector_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS budget_policies(
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id),
  version integer NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  digest text NOT NULL,
  configured_by text NOT NULL,
  configured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_policy_status_range CHECK (status IN ('ACTIVE','DISABLED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_policy_workspace_key_version_unique ON budget_policies(workspace_id, id, version);
CREATE UNIQUE INDEX IF NOT EXISTS budget_policy_active_workspace_unique ON budget_policies(workspace_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS configuration_records(
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id),
  idempotency_key text NOT NULL,
  digest text NOT NULL,
  actor_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS configuration_record_workspace_key_unique ON configuration_records(workspace_id, idempotency_key);
