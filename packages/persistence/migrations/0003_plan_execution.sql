-- Plan seals and step outputs.
CREATE TABLE IF NOT EXISTS plan_seals(revision_id text PRIMARY KEY,operation_id text NOT NULL,content_hash text NOT NULL,sealed_at text NOT NULL,capability_versions jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS step_outputs(id text PRIMARY KEY,operation_id text NOT NULL,revision_id text NOT NULL,step_id text NOT NULL,attempt_id text NOT NULL UNIQUE,content jsonb NOT NULL,quality text NOT NULL DEFAULT 'UNVERIFIED',created_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS step_output_revision_attempt ON step_outputs(revision_id,attempt_id);
