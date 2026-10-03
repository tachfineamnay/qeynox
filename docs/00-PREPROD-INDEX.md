# QeyNox V2 — Dossier de préparation préproduction

**Date : 2026-10-03**


**Statut : architecture cible figée pour implémentation.**  
**Baseline repo auditée :** `tachfineamnay/qeynox` — `main` — SHA `c0bdfe1` (2026-10-03).

Ce dossier remplace les choix techniques transitoires du PRD V2 actuel lorsqu'ils entrent en conflit avec les ADR ci-dessous. Le code V1 reste une source fonctionnelle à migrer progressivement ; il n'est pas à réécrire en bloc.

## Objectif préproduction

La préproduction doit prouver qu'un projet QeyNox peut :

1. être créé et isolé par organisation/projet ;
2. produire des `JobSpec` et lancer des `JobRun` durables ;
3. résoudre des `Capabilities` vers des `Providers` interchangeables ;
4. utiliser des outils via HTTP/OpenAPI, MCP, Docker ou CLI sans modifier le cœur métier ;
5. produire des `Artifacts` immuables et versionnés ;
6. régénérer un Artifact en un clic, avec ou sans instruction utilisateur ;
7. convertir un Artifact en `ExecutionSpec`, l'approuver selon sa classe de risque, puis l'exécuter ;
8. produire des `Evidence` et un `Outcome` traçables ;
9. reprendre correctement après panne/retry/restart ;
10. démontrer l'absence de dépendance métier à un fournisseur concret.

## Documents

### Produit et architecture
- `01-PRD-V2.1.md` — contrat produit cible.
- `02-ARCHITECTURE-V2.md` — architecture logique et physique.
- `03-DOMAIN-DATA-MODEL.md` — objets métier, invariants et tables.
- `04-MIGRATION-V1-V2.md` — stratégie de migration sans big bang.
- `05-IMPLEMENTATION-ROADMAP.md` — ordre de construction.

### ADR figés
- `adr/ADR-001-CAPABILITY-PROVIDER.md`
- `adr/ADR-002-ARTIFACT-REGENERATION.md`
- `adr/ADR-003-CONTROLLED-EXECUTION.md`
- `adr/ADR-004-TOOL-EXECUTION-FABRIC.md`
- `adr/ADR-005-HATCHET-RUNTIME.md`

### Contrats
- `specs/CAPABILITY-PROVIDER-SPEC.md`
- `specs/JOB-ARTIFACT-SPEC.md`
- `specs/WORKFLOW-PIPELINE-SPEC.md`
- `specs/API-EVENT-CONTRACTS.md`
- `specs/TOOL-CERTIFICATION-SPEC.md`

### Sécurité, ops et validation
- `runbooks/SECURITY-RISK-POLICY.md`
- `runbooks/PREPROD-DEPLOYMENT.md`
- `runbooks/OBSERVABILITY.md`
- `runbooks/INCIDENT-ROLLBACK.md`
- `runbooks/TEST-ACCEPTANCE-PLAN.md`
- `runbooks/PREPROD-GO-NOGO-CHECKLIST.md`

### Schémas et configuration
- `schemas/provider-manifest.example.yaml`
- `schemas/workflow-definition.example.yaml`
- `schemas/job-spec.example.yaml`
- `schemas/execution-result.example.yaml`
- `env/preprod.env.example`

## Décision d'architecture en une phrase

> QeyNox est un modular monolith piloté par des capabilities, orchestré durablement par Hatchet, où les providers sont interchangeables, les Artifacts sont immuables et régénérables, et toute action externe passe par une couche d'exécution contrôlée et auditable.

## Définition de “préprod prête”

La préproduction n'est considérée prête que si tous les tests P0 du document `runbooks/TEST-ACCEPTANCE-PLAN.md` passent et que le checklist `runbooks/PREPROD-GO-NOGO-CHECKLIST.md` est entièrement vert.
