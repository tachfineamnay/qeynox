BEGIN;
CREATE TABLE operation_event_envelopes(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,event_id text NOT NULL UNIQUE,sequence integer NOT NULL,schema_version integer NOT NULL DEFAULT 1,kind text NOT NULL,revision_id text,attempt_id text,actor_type text NOT NULL,correlation_id text,causation_id text,occurred_at text NOT NULL,data jsonb NOT NULL);
CREATE UNIQUE INDEX envelope_operation_sequence_unique ON operation_event_envelopes(operation_id,sequence);
CREATE TABLE operation_views(operation_id text PRIMARY KEY,workspace_id text NOT NULL,status text NOT NULL,title text NOT NULL,revision_id text,attention text NOT NULL,last_activity_at text NOT NULL,step_count integer NOT NULL,completed_steps integer NOT NULL,pending_approvals integer NOT NULL,result_count integer NOT NULL,evidence_count integer NOT NULL,last_sequence integer NOT NULL);
CREATE INDEX views_workspace_recent_idx ON operation_views(workspace_id,last_activity_at);
CREATE TABLE projection_cursors(operation_id text PRIMARY KEY,last_sequence integer NOT NULL DEFAULT 0);
COMMIT;
