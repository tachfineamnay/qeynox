# Observability Runbook

**Date : 2026-10-03**


## Corrélation

Chaque opération reçoit :
- `trace_id`
- `organization_id`
- `project_id`
- `workflow_run_id`
- `job_run_id`
- `execution_run_id` si applicable.

## OpenTelemetry

Tracer :
- requêtes API ;
- Hatchet workflow/task ;
- provider resolution ;
- provider call ;
- LLM call ;
- DB queries critiques ;
- object storage ;
- execution side effects.

## Métriques minimales

### Produit
- Time to First Value ;
- Approval Rate ;
- Regeneration Rate ;
- Action Completion Rate.

### Runtime
- job latency ;
- retry count ;
- failure rate ;
- queue age ;
- worker saturation.

### Providers
- availability ;
- latency ;
- errors ;
- fallback count ;
- cost.

### LLM
- tokens ;
- cost ;
- latency ;
- error rate.

## Logs

JSON structurés.  
Interdits :
- secrets ;
- prompts contenant credentials ;
- données brutes non nécessaires.

## Alertes préprod

- DB inaccessible ;
- Hatchet inaccessible ;
- queue bloquée ;
- failure rate > seuil ;
- provider critique dégradé ;
- storage inaccessible ;
- erreurs R3/R4.
