-- MISSION P11 — durable processing leases for document ingestion (additive).
--
-- Defect: document_ingest_jobs rows claimed as PROCESSING stayed there forever when the worker
-- crashed between claim and completion, leaving the document PROCESSING indefinitely.
--
-- lease_owner       — identity of the worker instance holding the job (diagnostic only).
-- lease_token       — fencing token, new on every claim. Every write a worker makes for a job is
--                     conditioned on (state = 'PROCESSING' AND lease_token = <its token>), so a worker
--                     whose lease expired and was re-claimed can no longer change the job or document.
-- lease_expires_at  — a PROCESSING job whose lease has expired is abandoned: it is re-claimed by the
--                     next drain (counting as a new attempt) or failed terminally once its attempts
--                     are exhausted.
--
-- Legacy PROCESSING rows (claimed before this migration, so without a lease) are treated as
-- abandoned once their updated_at is older than the lease duration. No existing column, constraint
-- or row is changed.

ALTER TABLE document_ingest_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE document_ingest_jobs ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE document_ingest_jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS document_ingest_jobs_lease_idx
  ON document_ingest_jobs (lease_expires_at)
  WHERE state = 'PROCESSING';
