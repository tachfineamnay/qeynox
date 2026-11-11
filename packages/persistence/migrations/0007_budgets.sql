BEGIN;
CREATE TABLE operation_budgets(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL UNIQUE,version integer NOT NULL,currency text NOT NULL,max_money_minor integer NOT NULL,reserved_minor integer NOT NULL DEFAULT 0,spent_minor integer NOT NULL DEFAULT 0,max_agent_calls integer NOT NULL, max_tool_calls integer NOT NULL,used_agent_calls integer NOT NULL DEFAULT 0,used_tool_calls integer NOT NULL DEFAULT 0,max_duration_seconds integer NOT NULL,max_concurrent integer NOT NULL,started_at text NOT NULL,policy jsonb NOT NULL);
CREATE TABLE usage_reservations(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,attempt_id text NOT NULL,key text NOT NULL UNIQUE,kind text NOT NULL,provider_key text NOT NULL,policy_version integer NOT NULL,reserved_minor integer NOT NULL,state text NOT NULL,created_at text NOT NULL,settled_at text);
CREATE INDEX usage_op_state_idx ON usage_reservations(operation_id,state);
CREATE TABLE usage_ledger(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,reservation_id text NOT NULL UNIQUE,origin text NOT NULL,cost_minor integer,currency text NOT NULL,tokens_in integer,tokens_out integer,recorded_at text NOT NULL);
CREATE TABLE loop_fingerprints(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,fingerprint text NOT NULL,count integer NOT NULL,last_progress_hash text NOT NULL,updated_at text NOT NULL);
CREATE UNIQUE INDEX loop_op_fingerprint_unique ON loop_fingerprints(operation_id,fingerprint);
COMMIT;
