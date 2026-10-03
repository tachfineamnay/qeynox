# API & Event Contracts — cible préprod

**Date : 2026-10-03**


## API principale

Préfixe : `/v2`

### Projects
- `POST /v2/projects`
- `GET /v2/projects/{id}`
- `PATCH /v2/projects/{id}`

### Jobs
- `POST /v2/job-specs`
- `POST /v2/job-specs/{id}/runs`
- `GET /v2/job-runs/{id}`
- `POST /v2/job-runs/{id}/cancel`

### Artifacts
- `GET /v2/artifacts/{id}`
- `GET /v2/artifacts/{id}/versions`
- `POST /v2/artifact-versions/{id}/regenerate`

### Approvals
- `POST /v2/approvals`
- `POST /v2/approvals/{id}/approve`
- `POST /v2/approvals/{id}/reject`

### Providers
- `GET /v2/capabilities`
- `GET /v2/providers`
- `POST /v2/providers`
- `POST /v2/providers/{id}/test`
- `POST /v2/providers/{id}/enable`

### Executions
- `POST /v2/execution-specs`
- `POST /v2/execution-specs/{id}/runs`
- `GET /v2/execution-runs/{id}`

## Events

Envelope stable :

```json
{
  "event_id": "evt_...",
  "event_type": "artifact.ready",
  "occurred_at": "ISO-8601",
  "organization_id": "org_...",
  "project_id": "prj_...",
  "subject_id": "...",
  "trace_id": "...",
  "payload": {}
}
```

Events minimaux :
- `job.queued`
- `job.started`
- `job.failed`
- `job.completed`
- `artifact.ready`
- `artifact.stale`
- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `execution.requested`
- `execution.started`
- `execution.failed`
- `execution.completed`
- `provider.degraded`
- `provider.recovered`

## Webhooks

- signature HMAC ;
- retry avec backoff ;
- idempotency via `event_id` ;
- journal de livraison.
