-- Recovery incidents and operator actions.
CREATE TABLE IF NOT EXISTS recovery_incidents(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,execution_id text,outbox_id text,category text NOT NULL,status text NOT NULL,reason text NOT NULL,created_at text NOT NULL,updated_at text NOT NULL);
CREATE INDEX IF NOT EXISTS recovery_workspace_operation_idx ON recovery_incidents(workspace_id,operation_id);
CREATE TABLE IF NOT EXISTS recovery_actions(id text PRIMARY KEY,incident_id text NOT NULL,workspace_id text NOT NULL,operation_id text NOT NULL,actor_id text NOT NULL,action text NOT NULL,reason text NOT NULL,created_at text NOT NULL,details jsonb NOT NULL);
