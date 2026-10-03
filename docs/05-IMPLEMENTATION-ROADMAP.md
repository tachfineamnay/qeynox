# QeyNox V2 — Roadmap d'implémentation vers préprod

**Date : 2026-10-03**


## Lot 0 — Repo & garde-fous
- nettoyer les références publiques non destinées à l'utilisateur ;
- ignorer toute donnée tenant/runtime ;
- ajouter tests, lint, typecheck, CI minimale ;
- geler la baseline V1.

## Lot 1 — Foundations
- FastAPI ;
- PostgreSQL ;
- migrations DB ;
- domain models ;
- auth préprod ;
- `organization_id` / `project_id`.

## Lot 2 — Job & Artifact
- JobSpec / JobRun ;
- Artifact / ArtifactVersion ;
- ContextSnapshot ;
- Feedback ;
- Approval ;
- régénération.

## Lot 3 — Hatchet
- adapter d'orchestration ;
- workflow simple ;
- DAG ;
- retry ;
- durable wait ;
- schedule ;
- event.

## Lot 4 — Capability Router
- Capability Registry ;
- Provider Registry ;
- ProviderBinding ;
- health/certification ;
- scoring/fallback.

## Lot 5 — Tool Fabric
- runner HTTP/OpenAPI ;
- runner MCP ;
- runner Docker ;
- runner CLI ;
- résultats normalisés.

## Lot 6 — Execution
- ExecutionSpec / ExecutionRun ;
- risk levels ;
- approvals ;
- idempotency ;
- evidence ;
- rollback hooks.

## Lot 7 — Observabilité
- OpenTelemetry ;
- trace correlation ;
- Langfuse LLM ;
- cost/tokens/provider metrics.

## Lot 8 — Web preprod
- projets ;
- job ;
- Artifact versions ;
- Regenerate ;
- Approve ;
- execution preview ;
- evidence.

## Lot 9 — Migration réelle V1
- repo scan ;
- research ;
- dossier ;
- provider CLI ;
- suppression progressive du scheduler legacy.

## Lot 10 — Préprod GO
Exécuter l'intégralité du plan d'acceptation P0/P1 et signer le checklist GO/NO-GO.
