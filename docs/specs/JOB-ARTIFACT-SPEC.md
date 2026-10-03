# Job / Artifact / Regeneration Specification

**Date : 2026-10-03**


## JobSpec

Décrit une intention stable et reproductible.

Champs :
- `id`
- `project_id`
- `type`
- `capabilities`
- `inputs`
- `instructions`
- `output_schema`
- `policy`
- `workflow_node_id`

## JobRun

Champs :
- `id`
- `job_spec_id`
- `parent_job_run_id`
- `context_snapshot_id`
- `status`
- `resolved_providers`
- `resolved_models`
- `cost`
- `trace_id`

Statuts :
`queued | running | waiting | succeeded | failed | cancelled`

## ArtifactVersion

Champs :
- `id`
- `artifact_id`
- `version`
- `job_run_id`
- `parent_artifact_version_id`
- `content`
- `blob_uri`
- `sources`
- `confidence`
- `checksum`

## Regenerate

Entrée :
- artifact version source ;
- mode ;
- instruction optionnelle.

Modes :
- `same_context`
- `with_feedback`
- `refresh_context`
- `change_execution_policy`

Sortie :
- nouveau JobRun ;
- nouvelle ArtifactVersion ;
- ancienne version intacte.

## Stale propagation

Chaque Artifact peut déclarer les versions amont utilisées. Quand une version amont change, QeyNox marque les descendants `stale=true`. La régénération reste manuelle ou policy-driven.
