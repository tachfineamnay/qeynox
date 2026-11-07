CREATE TABLE capabilities (
    key TEXT PRIMARY KEY,
    CONSTRAINT capabilities_key_chk CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE providers (
    key TEXT PRIMARY KEY,
    CONSTRAINT providers_key_chk CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE provider_capabilities (
    provider_key TEXT NOT NULL,
    capability_key TEXT NOT NULL,
    PRIMARY KEY (provider_key, capability_key),
    CONSTRAINT provider_capabilities_provider_fk FOREIGN KEY (provider_key) REFERENCES providers (key),
    CONSTRAINT provider_capabilities_capability_fk FOREIGN KEY (capability_key) REFERENCES capabilities (key)
);

CREATE TABLE provider_bindings (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    capability_key TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    priority INTEGER NOT NULL,
    health TEXT NOT NULL,
    CONSTRAINT provider_bindings_priority_chk CHECK (priority >= 0),
    CONSTRAINT provider_bindings_health_chk CHECK (health IN ('up', 'down')),
    CONSTRAINT provider_bindings_project_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects (id, organization_id),
    CONSTRAINT provider_bindings_offer_fk
        FOREIGN KEY (provider_key, capability_key)
        REFERENCES provider_capabilities (provider_key, capability_key),
    CONSTRAINT provider_bindings_unique UNIQUE (project_id, capability_key, provider_key)
);

INSERT INTO capabilities (key) VALUES ('search');

INSERT INTO providers (key) VALUES ('searxng'), ('duckduckgo');

INSERT INTO provider_capabilities (provider_key, capability_key) VALUES
    ('searxng', 'search'),
    ('duckduckgo', 'search');
