-- Durable reconciliation state for the external Chatwoot support engine.
-- No message content is stored here: this table only records the intent-to-create state machine
-- (deterministic source_id per request) so ambiguous remote outcomes can be reconciled instead of
-- duplicated. support_chatwoot_links remains the authorization mapping and gains an orphan marker.
CREATE TABLE IF NOT EXISTS support_intents (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  intent_ref text NOT NULL,
  chatwoot_contact_id text,
  chatwoot_conversation_id text,
  state text NOT NULL DEFAULT 'PENDING_CONTACT',
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotency is scoped per tenant: the same request key in another workspace is a different intent.
CREATE UNIQUE INDEX IF NOT EXISTS support_intents_user_workspace_ref_unique
  ON support_intents (workspace_id, user_id, intent_ref);
CREATE INDEX IF NOT EXISTS support_intents_state_idx ON support_intents (state, updated_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_intents_state_check'
  ) THEN
    ALTER TABLE support_intents
      ADD CONSTRAINT support_intents_state_check CHECK (state IN ('PENDING_CONTACT', 'PENDING_CONVERSATION', 'LINKED', 'FAILED', 'ORPHANED'));
  END IF;
END $$;

ALTER TABLE support_chatwoot_links
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ACTIVE';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_chatwoot_links_state_check'
  ) THEN
    ALTER TABLE support_chatwoot_links
      ADD CONSTRAINT support_chatwoot_links_state_check CHECK (state IN ('ACTIVE', 'ORPHANED'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS support_chatwoot_links_state_idx ON support_chatwoot_links (state);
