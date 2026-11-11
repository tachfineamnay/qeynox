-- Claims, source links and versioned verification policies.
CREATE TABLE IF NOT EXISTS claims(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,attempt_id text NOT NULL,statement text NOT NULL,kind text NOT NULL,status text NOT NULL DEFAULT 'UNVERIFIED',created_at text NOT NULL,profile_id text,profile_version integer);
CREATE INDEX IF NOT EXISTS claim_workspace_operation_idx ON claims(workspace_id,operation_id);
CREATE TABLE IF NOT EXISTS claim_evidence_links(id text PRIMARY KEY,claim_id text NOT NULL REFERENCES claims(id),source_id text NOT NULL,evidence_id text,relationship text NOT NULL,observation_digest text,added_at text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS claim_source_relation_unique ON claim_evidence_links(claim_id,source_id,relationship);
CREATE TABLE IF NOT EXISTS verification_policies(id text PRIMARY KEY,capability_id text NOT NULL,version integer NOT NULL,minimum_sources integer NOT NULL,max_age_days integer NOT NULL,approved_providers jsonb NOT NULL,human_review_required text NOT NULL,valid_from text NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS verification_policy_version_unique ON verification_policies(capability_id,version);
CREATE TABLE IF NOT EXISTS claim_assessments(id text PRIMARY KEY,claim_id text NOT NULL REFERENCES claims(id),policy_id text NOT NULL REFERENCES verification_policies(id),status text NOT NULL,method text NOT NULL,actor_id text,rationale text NOT NULL,source_ids jsonb NOT NULL,assessed_at text NOT NULL);
CREATE INDEX IF NOT EXISTS claim_assessments_claim_idx ON claim_assessments(claim_id,assessed_at);
CREATE TABLE IF NOT EXISTS source_snapshots(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,source_id text NOT NULL,provider text NOT NULL,retrieved_at text NOT NULL,published_at text,sha256 text,storage_key text,citation_uri text,created_at text NOT NULL);
