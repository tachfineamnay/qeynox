# ADR-005 — Hatchet comme runtime durable unique

**Date : 2026-10-03**


**Statut : ACCEPTÉ**

## Décision

Hatchet est l'unique moteur principal pour :
- background tasks ;
- DAGs ;
- retries/backoff ;
- timeouts ;
- events ;
- schedules ;
- durable waits ;
- concurrence ;
- rate limits ;
- workers distribués.

QeyNox ne déploie pas Temporal, Celery ou un scheduler maison parallèle pour ces responsabilités.

## Frontière

Le Domain Core dépend d'un port d'orchestration, pas du SDK Hatchet.

```text
Domain/Application
      ↓
OrchestrationPort
      ↓
HatchetAdapter
      ↓
Hatchet
```

## Source de vérité

Hatchet conserve l'état runtime. PostgreSQL QeyNox conserve l'état métier.

Les tables internes Hatchet ne sont jamais manipulées directement par le Core.
