-- Customer support mapping to the external Chatwoot engine.
-- Only the account <-> contact/conversation association is stored. No message, transcript or
-- attachment is duplicated in PostgreSQL: inbox, status, priority and history are read live from
-- the Chatwoot API at request time.
CREATE TABLE IF NOT EXISTS support_chatwoot_links (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  chatwoot_contact_id text NOT NULL,
  chatwoot_conversation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS support_chatwoot_conversation_unique
  ON support_chatwoot_links (workspace_id, user_id, chatwoot_conversation_id);
CREATE INDEX IF NOT EXISTS support_chatwoot_conversation_idx
  ON support_chatwoot_links (chatwoot_conversation_id);
