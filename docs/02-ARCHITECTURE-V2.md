# QeyNox V2 — Architecture cible

**Date : 2026-10-03**


## Architecture logique

```text
Web / Messaging / MCP / CLI / External API
                  │
                  ▼
              FastAPI
                  │
          Application Layer
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   Domain Core         PostgreSQL
        │             + pgvector
        │
        ▼
  Orchestration Port
        │
   Hatchet Adapter
        │
        ▼
      Hatchet
        │
 ┌──────┼─────────┬──────────┐
 ▼      ▼         ▼          ▼
Research Agent  Content   Execution Workers
Workers  Workers Workers
        │
        ▼
 Capability Router
        │
 Provider Resolver
        │
 ┌──────┼─────────┬─────────┬──────────┐
 ▼      ▼         ▼         ▼          ▼
HTTP   MCP      Docker      CLI       n8n
        │         │          │
     ToolHive   E2B      Dagger
        │
        ▼
 External providers
        │
        ▼
 Normalized Results
        │
 Artifact / Evidence / Outcome
```

## Services préprod

Obligatoires :
- `qeynox-api` — FastAPI ;
- `qeynox-web` — Next.js ;
- `qeynox-worker` — workers métier ;
- `postgres` — source de vérité QeyNox ;
- `hatchet` — runtime durable ;
- `object-storage` — MinIO/S3 compatible ;
- `otel-collector` — collecte traces/métriques.

Recommandés :
- `langfuse` — observabilité LLM ;
- `toolhive` — registry/runtime MCP ;
- `n8n` — bridge intégrations ;
- `opa` — policies de risque.

Optionnels :
- `ollama` ;
- `searxng` ;
- `e2b-runtime` self-host ;
- autres providers SEO/GEO.

## Frontières

### Domain Core
Ne connaît pas :
- Hatchet SDK ;
- GitHub SDK ;
- n8n ;
- ToolHive ;
- E2B ;
- Dagger ;
- un modèle LLM précis.

### Application Layer
Orchestre les use cases :
- create project ;
- create job ;
- regenerate artifact ;
- request approval ;
- create execution ;
- approve execution.

### Infrastructure
Contient :
- `hatchet/`
- `postgres/`
- `storage/`
- `providers/`
- `transports/`
- `observability/`

## Structure de repo cible

```text
qeynox/
├── apps/
│   ├── api/
│   └── web/
├── src/qeynox/
│   ├── domain/
│   ├── application/
│   ├── capabilities/
│   ├── providers/
│   ├── workflows/
│   ├── connectors/
│   └── infrastructure/
├── workers/
├── schemas/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── security/
│   └── e2e/
├── infra/
│   ├── docker/
│   └── preprod/
└── docs/
```

## Flux régénération

```text
Artifact v3
   ↓
User feedback
   ↓
Regenerate command
   ↓
new JobRun
   ↓
same JobSpec + revision instruction
   ↓
Artifact v4
```

## Flux exécution

```text
Artifact approved
      ↓
ExecutionSpec
      ↓
Policy evaluation
      ↓
Capability resolution
      ↓
Provider transport
      ↓
External side effect
      ↓
ExecutionResult
      ↓
Evidence
```

## Invariants

- aucun provider spécifique dans le Domain Core ;
- un `ArtifactVersion` n'est jamais muté ;
- toute exécution mutante est idempotente ou possède une clé d'idempotence ;
- toute exécution R3/R4 a une approval valide ;
- tous les appels providers génèrent une trace et un résultat normalisé.
