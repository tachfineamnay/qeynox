# QeyNox V2 — Domain & Data Model

**Date : 2026-10-03**


## Entités principales

### Organization
Conteneur de sécurité et de facturation future.

Champs minimaux :
- `id`
- `name`
- `status`
- `created_at`

### Project
Un business / produit / activité.

- `id`
- `organization_id`
- `slug`
- `name`
- `status`
- `default_locale`
- `default_market`
- `created_at`
- `updated_at`

### BusinessContext
Mémoire métier structurée.

- `project_id`
- `version`
- `identity`
- `offer`
- `products`
- `audience`
- `geography`
- `pricing`
- `competitors`
- `channels`
- `positioning`
- `keywords`
- `seo`
- `aeo`
- `geo`
- `acquisition`
- `conversion`

### ContextSnapshot
Snapshot immuable utilisé pour un run.

- `id`
- `project_id`
- `business_context_version`
- `payload`
- `created_at`

### JobSpec
Intention reproductible.

- `id`
- `project_id`
- `workflow_definition_id`
- `type`
- `capabilities[]`
- `inputs`
- `instructions`
- `output_schema`
- `execution_policy`
- `created_at`

### JobRun
Exécution d'un JobSpec.

- `id`
- `job_spec_id`
- `parent_job_run_id`
- `context_snapshot_id`
- `status`
- `provider_resolution`
- `model_resolution`
- `started_at`
- `finished_at`
- `cost`
- `error`

### Artifact
Identité logique d'un livrable.

- `id`
- `project_id`
- `type`
- `job_spec_id`

### ArtifactVersion
Version immuable.

- `id`
- `artifact_id`
- `version`
- `job_run_id`
- `parent_artifact_version_id`
- `body`
- `blob_uri`
- `sources`
- `confidence`
- `checksum`
- `created_at`

### Feedback
Instruction de révision.

- `id`
- `artifact_version_id`
- `instruction`
- `author_id`
- `created_at`

### Approval
Validation d'une version exacte.

- `id`
- `subject_type`
- `subject_id`
- `artifact_version_id`
- `status`
- `policy`
- `decided_by`
- `decided_at`

### Capability
Besoin métier abstrait.

- `id`
- `name`
- `input_schema`
- `output_schema`
- `risk_default`

### Provider
Implémentation externe ou interne.

- `id`
- `name`
- `status`
- `transport`
- `manifest`
- `certification_status`

### ProviderBinding
Activation d'un provider pour une organisation/projet.

- `id`
- `provider_id`
- `organization_id`
- `project_id`
- `priority`
- `config`
- `secret_refs`
- `enabled`

### ExecutionSpec
Action externe souhaitée.

- `id`
- `project_id`
- `source_artifact_version_id`
- `capability`
- `target`
- `inputs`
- `risk_level`
- `approval_policy`
- `rollback_strategy`
- `idempotency_key`

### ExecutionRun
Tentative d'exécution.

- `id`
- `execution_spec_id`
- `provider_id`
- `status`
- `started_at`
- `finished_at`
- `result`
- `error`
- `trace_id`

### Evidence
Preuve d'exécution.

- `id`
- `execution_run_id`
- `kind`
- `uri`
- `payload`
- `checksum`

### Outcome
Mesure après exécution.

- `id`
- `execution_run_id`
- `metric`
- `before_value`
- `after_value`
- `measured_at`

## Relations critiques

```text
Project
 ├── BusinessContext
 ├── JobSpec
 │    └── JobRun
 │         └── ArtifactVersion
 │              ├── Feedback
 │              └── Approval
 └── ExecutionSpec
      └── ExecutionRun
           ├── Evidence
           └── Outcome
```

## Invariants DB

1. `ArtifactVersion` : update du `body` interdit après création.
2. `Approval` : référence une version exacte.
3. `ExecutionRun` : doit référencer un `ExecutionSpec`.
4. Side effect R3/R4 : impossible sans approval valide.
5. Toutes les tables métier importantes portent `organization_id` directement ou indirectement par FK.
6. Les secrets ne sont jamais stockés en clair dans `ProviderBinding.config`.
7. Les outputs lourds sont externalisés en object storage ; PostgreSQL conserve URI + checksum + metadata.

## PostgreSQL / pgvector

Utiliser pgvector uniquement pour :
- recherche sémantique de documents ;
- similarité d'Artifacts ;
- récupération de décisions/feedback ;
- mémoire conversationnelle contextualisée.

Ne pas utiliser pgvector comme source de vérité métier.
