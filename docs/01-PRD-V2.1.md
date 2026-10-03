# QeyNox — PRD V2.1

**Date : 2026-10-03**


## 1. Vision

QeyNox est un **Business Growth Operating System** capable de comprendre un business, rechercher, décider, produire, faire valider, exécuter, mesurer et améliorer.

L'utilisateur ne doit pas choisir un crawler, un modèle, un protocole ou un framework. Il exprime une intention métier ; QeyNox sélectionne les capabilities et les providers adaptés.

### Promesse

> Explique ce que tu veux vendre ou améliorer. QeyNox organise le travail, prépare les livrables, te demande validation lorsque nécessaire, puis peut exécuter les actions autorisées.

## 2. Principes non négociables

1. **Capability-driven** : les workflows demandent des capabilities, jamais un outil précis.
2. **Provider-agnostic** : un provider peut être ajouté ou remplacé sans refactor du Core.
3. **Artifacts immuables** : toute nouvelle génération crée une nouvelle version.
4. **Régénération native** : un clic + prompt optionnel suffit pour refaire une tâche.
5. **Execution séparée** : produire un livrable et modifier un système externe sont deux opérations distinctes.
6. **Human-in-the-loop** : toute action à risque respecte une policy d'approbation.
7. **Durable runtime unique** : Hatchet gère orchestration, retry, attente, events et schedules.
8. **PostgreSQL = source de vérité métier**.
9. **Runtime ≠ domaine** : Hatchet, LLMs et providers restent derrière des adapters.
10. **Auditabilité complète** : chaque résultat et exécution conserve lineage, sources, contexte, provider, coût et evidence.

## 3. Parcours cible

```text
Business / Repo / Site / Documents
        ↓
Business Context
        ↓
Plan / Workflow
        ↓
JobSpec
        ↓
JobRun
        ↓
Capabilities
        ↓
Provider Resolver
        ↓
Provider(s)
        ↓
Artifact vN
        ↓
Human Review
   ┌────┼───────────────┐
Approve Edit        Regenerate
   │                    ↓
   │                 JobRun N+1
   │                    ↓
   │                Artifact vN+1
   ↓
Action Proposal
        ↓
ExecutionSpec
        ↓
Policy / Approval
        ↓
ExecutionRun
        ↓
Evidence
        ↓
Outcome
```

## 4. Surfaces

### Web
Dashboard principal : Aujourd'hui, Business, Marché, Visibilité, Contenu, Leads, Pages, Analytics, Automatisations.

### API
API métier stable pour Project, BusinessContext, JobSpec, JobRun, Artifact, Approval, Provider, Capability, ExecutionSpec et ExecutionRun.

### MCP
Surface d'accès pour clients IA et outils compatibles. MCP n'est pas le bus interne de QeyNox.

### Messaging
Gateway future-proof pour WhatsApp et autres canaux. Les canaux sont des adapters au-dessus du même Application Core.

## 5. Objets métier

- `Organization`
- `Project`
- `BusinessContext`
- `WorkflowDefinition`
- `WorkflowRun`
- `JobSpec`
- `JobRun`
- `Capability`
- `Provider`
- `ProviderBinding`
- `ContextSnapshot`
- `Artifact`
- `ArtifactVersion`
- `Feedback`
- `Approval`
- `ExecutionSpec`
- `ExecutionRun`
- `Evidence`
- `Outcome`
- `Event`

## 6. Job et Artifact

Un `JobSpec` décrit **ce que l'on veut obtenir**.  
Un `JobRun` décrit **une tentative d'exécution**.  
Un `ArtifactVersion` décrit **le résultat immuable d'un JobRun**.

La régénération n'écrase rien : elle crée un nouveau `JobRun` et une nouvelle version d'Artifact.

## 7. Execution

QeyNox doit pouvoir proposer plusieurs niveaux d'action :

- checklist ;
- prompt prêt à copier ;
- fichier ou patch ;
- draft ;
- branche/PR ;
- staging ;
- publication ou écriture externe ;
- automatisation déclenchée par event.

Une action externe est toujours représentée par un `ExecutionSpec` puis un `ExecutionRun`.

## 8. Tool Fabric

Les providers peuvent être intégrés par :

- HTTP / REST ;
- OpenAPI ;
- MCP ;
- Docker ;
- CLI ;
- adapter Python isolé ;
- webhook ;
- provider n8n.

Le Core ne contient aucun `if provider == ...`.

## 9. Orchestration

Hatchet est l'unique runtime durable de QeyNox V2.

Hatchet gère :
- DAGs ;
- retries ;
- backoff ;
- timeouts ;
- schedules ;
- events ;
- durable waits ;
- concurrence ;
- rate limits ;
- distribution vers workers.

Les données métier restent dans PostgreSQL QeyNox.

## 10. Sécurité

- isolation stricte par `organization_id` / `project_id` ;
- secrets hors Git, injectés au provider selon besoin minimal ;
- sandbox obligatoire pour Docker/CLI/code non fiable ;
- policy engine pour les classes de risque R0 à R4 ;
- aucune écriture production sans policy explicite ;
- evidence obligatoire pour une exécution mutante.

## 11. Préproduction minimale

La préprod doit démontrer au minimum :

1. un provider HTTP ;
2. un provider MCP ;
3. un provider Docker ;
4. un provider CLI ;
5. un workflow DAG ;
6. une attente d'approbation durable ;
7. une régénération d'Artifact ;
8. une Execution R2 type branche/PR ou équivalent ;
9. un fallback provider ;
10. un restart du worker sans perte de workflow ;
11. traces et métriques corrélées par `trace_id`.

## 12. Hors périmètre initial

- Kubernetes ;
- Kafka ;
- Qdrant obligatoire ;
- multi-region active/active ;
- marketplace publique ;
- billing complexe ;
- autonomie R4 sans approbation ;
- réécriture complète de la V1 en une seule étape.
