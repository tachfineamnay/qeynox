CREATE TABLE job_run_runtime (
    job_run_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    engine TEXT NOT NULL,
    engine_run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    error TEXT,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT job_run_runtime_engine_chk CHECK (engine = 'hatchet'),
    CONSTRAINT job_run_runtime_status_chk CHECK (status IN ('queued', 'running', 'ok', 'failed', 'timed_out')),
    CONSTRAINT job_run_runtime_attempt_chk CHECK (attempt >= 0),
    CONSTRAINT job_run_runtime_run_fk
        FOREIGN KEY (job_run_id, project_id, organization_id)
        REFERENCES job_runs (id, project_id, organization_id)
);
