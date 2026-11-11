BEGIN;
CREATE TABLE engine_selections(attempt_id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,revision_id text NOT NULL,engine_id text NOT NULL,engine_version text NOT NULL,profile_id text NOT NULL,profile_version integer NOT NULL,selected_at text NOT NULL,selection_policy jsonb NOT NULL);
CREATE TABLE workspace_data_policies(workspace_id text PRIMARY KEY,version integer NOT NULL,retention_days integer NOT NULL,updated_at text NOT NULL);
CREATE TABLE data_erasure_requests(id text PRIMARY KEY,workspace_id text NOT NULL,user_id text NOT NULL,requested_at text NOT NULL,local_context_revoked text NOT NULL,external_deletion text NOT NULL,notes text NOT NULL);
COMMIT;
