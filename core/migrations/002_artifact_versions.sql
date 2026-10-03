ALTER TABLE business_contexts
    ADD CONSTRAINT business_contexts_identity_unique UNIQUE (id, project_id, organization_id);

ALTER TABLE job_specs
    ADD CONSTRAINT job_specs_id_scope_unique UNIQUE (id, project_id, organization_id);

ALTER TABLE job_runs
    ADD CONSTRAINT job_runs_identity_unique UNIQUE (id, project_id, organization_id);

CREATE TABLE context_snapshots (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    business_context_id UUID NOT NULL,
    language TEXT NOT NULL,
    geo TEXT NOT NULL,
    site_url TEXT NOT NULL,
    brand_aliases TEXT[] NOT NULL,
    offer TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT context_snapshots_scope_unique UNIQUE (id, project_id, organization_id),
    CONSTRAINT context_snapshots_context_fk
        FOREIGN KEY (business_context_id, project_id, organization_id)
        REFERENCES business_contexts (id, project_id, organization_id)
);

CREATE TABLE artifacts (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    job_spec_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT artifacts_spec_unique UNIQUE (job_spec_id),
    CONSTRAINT artifacts_scope_unique UNIQUE (id, organization_id, project_id),
    CONSTRAINT artifacts_spec_fk
        FOREIGN KEY (job_spec_id, project_id, organization_id)
        REFERENCES job_specs (id, project_id, organization_id)
);

CREATE TABLE artifact_versions (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    version_number INTEGER NOT NULL,
    parent_version_id UUID,
    job_run_id UUID NOT NULL,
    context_snapshot_id UUID NOT NULL,
    body JSONB NOT NULL,
    sources JSONB NOT NULL,
    confidence TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT artifact_versions_number_chk CHECK (version_number >= 1),
    CONSTRAINT artifact_versions_lineage_chk CHECK (
        (version_number = 1 AND parent_version_id IS NULL)
        OR (version_number > 1 AND parent_version_id IS NOT NULL)
    ),
    CONSTRAINT artifact_versions_confidence_chk CHECK (confidence IN ('ok', 'low')),
    CONSTRAINT artifact_versions_body_chk CHECK (jsonb_typeof(body) = 'object'),
    CONSTRAINT artifact_versions_sources_chk CHECK (jsonb_typeof(sources) = 'array'),
    CONSTRAINT artifact_versions_number_unique UNIQUE (artifact_id, version_number),
    CONSTRAINT artifact_versions_run_unique UNIQUE (job_run_id),
    CONSTRAINT artifact_versions_scope_unique UNIQUE (id, project_id, organization_id),
    CONSTRAINT artifact_versions_line_unique UNIQUE (id, artifact_id, organization_id),
    CONSTRAINT artifact_versions_artifact_fk
        FOREIGN KEY (artifact_id, organization_id, project_id)
        REFERENCES artifacts (id, organization_id, project_id),
    CONSTRAINT artifact_versions_parent_fk
        FOREIGN KEY (parent_version_id, artifact_id, organization_id)
        REFERENCES artifact_versions (id, artifact_id, organization_id),
    CONSTRAINT artifact_versions_run_fk
        FOREIGN KEY (job_run_id, project_id, organization_id)
        REFERENCES job_runs (id, project_id, organization_id),
    CONSTRAINT artifact_versions_snapshot_fk
        FOREIGN KEY (context_snapshot_id, project_id, organization_id)
        REFERENCES context_snapshots (id, project_id, organization_id)
);

CREATE TABLE feedback (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    artifact_version_id UUID NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT feedback_note_chk CHECK (length(btrim(note)) > 0),
    CONSTRAINT feedback_version_fk
        FOREIGN KEY (artifact_version_id, project_id, organization_id)
        REFERENCES artifact_versions (id, project_id, organization_id)
);

CREATE TABLE approvals (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    artifact_version_id UUID NOT NULL,
    decision TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT approvals_decision_chk CHECK (decision IN ('go', 'no_go')),
    CONSTRAINT approvals_version_unique UNIQUE (artifact_version_id),
    CONSTRAINT approvals_version_fk
        FOREIGN KEY (artifact_version_id, project_id, organization_id)
        REFERENCES artifact_versions (id, project_id, organization_id)
);

CREATE FUNCTION qeynox_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable';
END;
$$;

CREATE TRIGGER context_snapshots_immutable
    BEFORE UPDATE OR DELETE ON context_snapshots
    FOR EACH ROW EXECUTE FUNCTION qeynox_reject_mutation();

CREATE TRIGGER artifacts_immutable
    BEFORE UPDATE OR DELETE ON artifacts
    FOR EACH ROW EXECUTE FUNCTION qeynox_reject_mutation();

CREATE TRIGGER artifact_versions_immutable
    BEFORE UPDATE OR DELETE ON artifact_versions
    FOR EACH ROW EXECUTE FUNCTION qeynox_reject_mutation();

CREATE TRIGGER feedback_immutable
    BEFORE UPDATE OR DELETE ON feedback
    FOR EACH ROW EXECUTE FUNCTION qeynox_reject_mutation();

CREATE TRIGGER approvals_immutable
    BEFORE UPDATE OR DELETE ON approvals
    FOR EACH ROW EXECUTE FUNCTION qeynox_reject_mutation();
