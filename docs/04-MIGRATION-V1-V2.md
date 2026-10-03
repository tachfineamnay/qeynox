# QeyNox — Migration V1 → V2 sans big bang

**Date : 2026-10-03**


## Principe

La V1 reste fonctionnelle pendant que le V2 absorbe progressivement ses responsabilités.

```text
V1 Legacy
   │
   ├── repo_scan
   ├── research
   ├── synthesize
   ├── dossier
   └── tools
          │
          ▼
      adapters V2
          │
          ▼
Core V2 + Hatchet + PostgreSQL
```

## À conserver / wrapper

- `engine/repo_scan.py` → activities de collecte ;
- `engine/research.py` → activities de research ;
- `engine/synthesize.py` → provider/agent adapter ;
- `engine/dossier.py` → Artifact producer ;
- `tools/*.py` → CLI providers temporaires ;
- `catalog/arms.json` → seed du Provider Registry.

## À remplacer progressivement

- `engine/pipeline.py` → workflows Hatchet ;
- `engine/loops.py` → schedules/events/retries Hatchet ;
- SQLite `gtm.db` → PostgreSQL ;
- `stacks/<slug>/*.json` → tables métier + object storage ;
- serveur HTTP stdlib → FastAPI ;
- UI actuelle → Next.js.

## Séquence

### Phase 0 — stabilisation V1
Corriger les bugs connus et isoler runtime/tenant data du Git.

### Phase 1 — nouveau Core
Créer modèles domaine + PostgreSQL, sans supprimer V1.

### Phase 2 — Job/Artifact
Introduire `JobSpec`, `JobRun`, `ArtifactVersion`, `Approval`.

### Phase 3 — Hatchet
Wrapper les fonctions V1 existantes comme tasks/activities Hatchet.

### Phase 4 — Capability Router
Résolution providers par capability ; les anciens scripts deviennent providers CLI.

### Phase 5 — Execution
Ajouter `ExecutionSpec`, policies, transports et evidence.

### Phase 6 — UI/API
Basculer les surfaces vers FastAPI/Next.js.

### Phase 7 — extinction legacy
Retirer loops, SQLite et fichiers d'état uniquement après équivalence fonctionnelle testée.

## Règle de migration

Aucune étape ne doit nécessiter de modifier simultanément :
- le modèle métier ;
- l'orchestration ;
- le provider ;
- l'UI.

Une dimension à la fois, avec tests contractuels.
