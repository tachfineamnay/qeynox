CREATE TABLE organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    CONSTRAINT organizations_name_chk CHECK (length(btrim(name)) > 0),
    CONSTRAINT organizations_slug_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT organizations_slug_unique UNIQUE (slug)
);

CREATE TABLE projects (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    CONSTRAINT projects_name_chk CHECK (length(btrim(name)) > 0),
    CONSTRAINT projects_slug_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT projects_org_fk FOREIGN KEY (organization_id) REFERENCES organizations (id),
    CONSTRAINT projects_slug_unique UNIQUE (organization_id, slug),
    CONSTRAINT projects_id_org_unique UNIQUE (id, organization_id)
);

CREATE TABLE business_contexts (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    language TEXT NOT NULL,
    geo TEXT NOT NULL,
    site_url TEXT NOT NULL,
    brand_aliases TEXT[] NOT NULL,
    offer TEXT NOT NULL,
    CONSTRAINT business_contexts_language_chk CHECK (language ~ '^[a-z]{2}$'),
    CONSTRAINT business_contexts_geo_chk CHECK (length(btrim(geo)) > 0),
    CONSTRAINT business_contexts_url_chk CHECK (site_url ~ '^https?://[^[:space:]]+$'),
    CONSTRAINT business_contexts_offer_chk CHECK (length(btrim(offer)) > 0),
    CONSTRAINT business_contexts_aliases_chk CHECK (NOT ('' = ANY (brand_aliases))),
    CONSTRAINT business_contexts_project_unique UNIQUE (project_id),
    CONSTRAINT business_contexts_project_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects (id, organization_id)
);

CREATE TABLE job_specs (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    type TEXT NOT NULL,
    role TEXT NOT NULL,
    title TEXT NOT NULL,
    inputs JSONB NOT NULL,
    arms TEXT[] NOT NULL,
    model TEXT NOT NULL,
    gate BOOLEAN NOT NULL,
    done_when TEXT NOT NULL,
    CONSTRAINT job_specs_type_chk CHECK (type IN (
        'discover.keywords', 'discover.serp', 'discover.signals',
        'crawl.site', 'audit.technical', 'audit.aeo',
        'geo.visibility', 'rank.track', 'competitors.watch',
        'analytics.traffic', 'search.web',
        'content.outline', 'content.hooks', 'strategy.critique',
        'perf.lighthouse', 'llm.observe', 'rag.embed'
    )),
    CONSTRAINT job_specs_model_chk CHECK (model IN ('auto', 'fast', 'strong', 'local', 'custom')),
    CONSTRAINT job_specs_role_chk CHECK (length(btrim(role)) > 0),
    CONSTRAINT job_specs_title_chk CHECK (length(btrim(title)) > 0),
    CONSTRAINT job_specs_done_chk CHECK (length(btrim(done_when)) > 0),
    CONSTRAINT job_specs_inputs_chk CHECK (jsonb_typeof(inputs) = 'object'),
    CONSTRAINT job_specs_arms_chk CHECK (NOT ('' = ANY (arms))),
    CONSTRAINT job_specs_project_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects (id, organization_id),
    CONSTRAINT job_specs_identity_unique UNIQUE (id, project_id, organization_id, type, model)
);

CREATE TABLE job_runs (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    job_spec_id UUID NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT job_runs_status_chk CHECK (status IN ('queued', 'running', 'ok', 'failed', 'needs_approval')),
    CONSTRAINT job_runs_error_chk CHECK (error IS NULL OR length(btrim(error)) > 0),
    CONSTRAINT job_runs_spec_fk
        FOREIGN KEY (job_spec_id, project_id, organization_id, type, model)
        REFERENCES job_specs (id, project_id, organization_id, type, model)
);
