# AG-UI — cause racine des projections et patch

## 1. Verdict et cause racine

**Cause démontrée :** les lectures déclenchent volontairement une matérialisation synchrone ; PostgreSQL est modifié pendant les GET. Retirer ces appels sans remplacement rend les vues et les enveloppes absentes ou périmées. Le code de travail inclut déjà l'extraction utilisateur `project()`/`sync()` ; elle est conservée.

**Verdict : READY_TO_CODE**, sous réserve de réussir la migration, les tests et la bascule ci-dessous ; aucune certification de la future correction n'est acquise.

## 2. Graphe causal réel

`GET /v1/mydash/operations/:id/{summary,activity}` → `ActivityController` → respectivement `sync` ou `activity → sync` → `project` → autorisation `getOperation` → transaction → curseur, enveloppes, vue. `GET /v1/mydash/recent` → `recent` → `listOperations` → `sync` pour chaque opération → mêmes écritures.

`project` verrouille le curseur par opération, lit tous les événements triés `(occurred_at,id)`, ignore les `event_id` déjà enveloppés, attribue les séquences restantes, met à jour le curseur et reconstruit la vue à partir de l'état métier courant. Cursor + enveloppes + vue commitent ou rollback ensemble. Même sans nouvel événement, UPDATE curseur et UPSERT vue ont lieu.

Producteurs d'événements : `QeyNoxStore.createOperation`, `transition`, `writeEvent` (`packages/persistence/src/store.ts:13,49,65`) ; transactions directes dans `packages/application/src/{planning,execution,progression,controls,revisions,delivery}.ts` ; échec dans `apps/worker/src/runtime.ts:72-87`. Les deux premières écritures du store et les écritures directes citées sont dans leurs transactions métier ; `writeEvent` est autonome. Aucun mécanisme de notification de projection trouvé. `ClaimsService.register`, `ResultAssembler.assemble` et `QeyNoxStore.decideApproval` modifient des sources de vue sans événement associé.

Le worker démarre via `apps/worker/src/main.ts` → `startQeyNoxWorker` → `startDispatcher` puis `worker.start` (`packages/orchestration/src/hatchet.ts:72`). `PgOutboxDispatcher` ne traite que `EXECUTE_STEP`, marque les autres topics FAILED et n'est pas un projecteur ; sa reprise UNKNOWN exige une réconciliation Hatchet. Aucun déclenchement de projection hors GET trouvé.

## 3. Preuves Graphify et source

- `main` HEAD `43c7e777dd61b66e064c81161232344e5b0f82f5`, un commit devant origin/main ; fichiers utilisateur modifiés : `docs/flow/AGUI_IMPLEMENTATION_CONTRACT.md`, `docs/flow/FLOW2_STATUS.md`, `packages/application/src/read-models.ts`, neuf captures non suivies. Préservés.
- Aucun `graphify-out` initial ; Graphify CLI **0.9.26**, `graphify extract . --code-only --no-cluster` : 3 035 nœuds, 9 517 arêtes, état du checkout courant incluant les modifications locales. Graphe AST seulement : 99 documents/images exclus, quatre fichiers signalés sensibles, trois fichiers JSON sans nœud ; il ne prouve pas l'absence de chemins. `graphify diagnose multigraph` signale 1 275 arêtes pendantes et 97 paires d'arêtes susceptibles d'être fusionnées : graphe incomplet, conclusions critiques vérifiées dans les sources.
- `graphify explain OperationReadModels` : classe → méthodes `project`, `sync`, `activity`, `recent` **EXTRACTED**. `graphify path ActivityController OperationReadModels` et `path OperationReadModels eventEnvelopes` : liens de contenance/import **EXTRACTED**, pas des appels ; les appels et transactions sont confirmés par `apps/api/src/activity/activity.controller.ts:10-23` et `packages/application/src/read-models.ts:8-56`.
- `eventEnvelopes.eventId` est unique, `(operationId,sequence)` unique ; `operationViews.operationId` et `projectionCursors.operationId` sont clés primaires ; index `(workspaceId,lastActivityAt)` pour les vues (`packages/persistence/src/views-schema.ts:2-20`, migration `0008_readmodels.sql`). Le curseur ne porte pas workspace ; l'autorisation précède aujourd'hui son accès.
- `occurred_at` est du texte fourni par les producteurs (`packages/persistence/src/schema.ts:29`), pas un ordre de commit. Un événement qui commit tard avec une date antérieure sera ajouté après les séquences déjà distribuées ; la déduplication ne rétablit pas l'ordre historique. Un scan par maximum timestamp ou séquence PostgreSQL globale peut sauter des commits tardifs.
- Les vues alimentent aussi `packages/persistence/src/platform-operations-store.ts:51-79` ; Flow consomme `recent`, `summary`, `activity` (`apps/web/src/components/workspace.tsx:33`, `apps/web/src/app/[lang]/missions/[id]/page.tsx:49-50`). Auth globale `AuthenticationGuard` puis `getOperation` assurent l'accès actuel par workspace, à conserver.

## 4. Reproduction et résultats QA

Base Docker `postgres:16-alpine` locale jetable, port loopback uniquement, 17/17 migrations appliquées, NestJS réel, inscription et création d'opération QA HTTP : **PASS**. Instrumentation locale par triggers AFTER INSERT/UPDATE/DELETE sur les trois tables de projection, enregistrant chaque mutation de ligne (y compris UPDATE), entre deux lectures du journal.

| Cas exécuté | Résultat observé | Critère GET sans mutation |
| --- | --- | --- |
| activity initial, HTTP 200 | INSERT curseur, INSERT enveloppe, UPDATE curseur, INSERT vue | **FAIL** |
| summary suivant, HTTP 200 | UPDATE curseur, UPDATE vue | **FAIL** |
| recent suivant, HTTP 200 | UPDATE curseur, UPDATE vue | **FAIL** |
| activity répétée, HTTP 200 | UPDATE curseur, UPDATE vue | **FAIL** |
| autre workspace : summary et activity | 404 et 404 | **PASS**, limité à ces deux cas |
| `QeyNoxStore.writeEvent` QA puis GET activity | HTTP 200, événement présent | **PASS** pour la projection déclenchée par lecture actuelle |

Les triggers n'observent que ces trois tables ; ils ne certifient pas l'absence d'autres écritures. Redémarrage worker, interruption, concurrence, replay et SSE : **NOT_RUN**. Runtime Hatchet/Hermes externe : **NOT_RUN**. La reproduction HTTP n'a utilisé aucune base distante.

Contrôles transversaux du checkout : `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` **PASS** ; `qa:task02` **PASS** (3 297 assertions), `qa:backend` **PASS** (28), `qa:agent-runtime` **PASS** (65), `qa:connectors` **PASS** (49), `qa:raas` **PASS** (47), sur PostgreSQL local jetable. Les deux dernières suites ont également effectué une lecture publique World Bank. Ces suites ne certifient pas la correction future.

## 5. Solution retenue

**B : projecteur dans le worker existant, réveillé par polling d'un état PostgreSQL durable et transactionnel**, sans tâche Hatchet supplémentaire. Option A demanderait de rendre transactionnels tous les producteurs et toutes les mutations de sources, y compris celles sans événement, et de coupler leur commit à la projection ; ce couplage est plus invasif et coûteux. Option B conserve le commit métier indépendant, rattrape après arrêt et peut coalescer les modifications ; son coût est la latence du polling et une migration avec triggers. L'outbox Hatchet existante n'est pas réutilisable telle quelle pour ce travail.

Chaque opération possède un état persistant `(workspace_id, operation_id, dirty, next_event_sequence)` verrouillé par ligne. Les mutations des sources marquent `dirty` dans **leur transaction**, y compris sans événement. Un trigger BEFORE INSERT sur `operation_events` attribue une séquence par opération sous ce même verrou, rollback compris ; elle ordonne les insertions sérialisées, pas le temps métier. Le worker verrouille une ligne dirty `FOR UPDATE SKIP LOCKED`, projette et remet dirty à false **dans la même transaction**. Un écrivain concurrent attend ce verrou puis remet dirty à true après le commit du projecteur : pas de fenêtre commit/déclenchement perdue. Crash avant commit : rollback ; après commit : état projeté durable. Deux workers ne traitent pas simultanément la même ligne.

Conserver la séquence publique et les enveloppes existantes. L'historique jamais projeté reçoit un ordre déterministe `(occurred_at,id)` après les séquences déjà publiées ; son ordre de commit passé est irrécupérable. Toute incohérence historique empêchant la correspondance ou la contiguïté bloque la migration ; aucun renumérotage silencieux des curseurs clients.

## 6. Patch exact, fichier par fichier

1. **`packages/persistence/migrations/0018_projection_delivery.sql` (nouveau)** : AVANT aucune intention durable → APRÈS table `projection_work` (PK operation_id, workspace_id, dirty boolean, next_event_sequence integer), index sur dirty, `operation_events.projection_sequence` non nul, défaut SQL 0 remplacé obligatoirement par le trigger, unique `(operation_id,projection_sequence)`. Sous verrou de migration et arrêt explicite des anciens lecteurs/projecteurs et écrivains pendant la bascule : valider workspace/event-id/sequence/cursor, recopier les numéros déjà publiés ; affecter aux événements non enveloppés `max(sequence)+row_number()` par `(occurred_at,id)`, initialiser `next_event_sequence` au maximum et `dirty=true` pour toutes les opérations. Abandonner sur incohérence, orphelin ou dépassement entier ; ne pas effacer l'historique. PREUVE : migration et répétition, fixtures historiques et échec atomique sur corruption.
2. **Même migration** : triggers transactionnels sur `operations`, `work_steps`, `step_attempts`, `approval_requests`, `claims`, `result_documents` pour INSERT/UPDATE/DELETE ; identifier workspace par `operations` pour les tables qui n'en ont pas, vérifier toute identité fournie et refuser les incohérences. Traiter OLD et NEW si identité change, en ordre stable, ou refuser ce changement ; empêcher les orphelins. BEFORE INSERT `operation_events` : vérifier workspace, verrouiller/initialiser `projection_work`, incrémenter `next_event_sequence`, affecter la valeur à NEW et marquer dirty ; interdire modification/suppression des événements existants. Ne jamais déclencher sur les tables de projection elles-mêmes. PREUVE : rollback métier annule dirty et attribution ; chaque source sans événement réveille la projection.
3. **`packages/persistence/src/schema.ts` et `views-schema.ts`** : déclarer `projectionSequence`, les contraintes et `projectionWork`, même noms/types/index que SQL ; exporter via les exports existants. PREUVE : `qa:task02` valide la parité Drizzle/migration.
4. **`packages/application/src/read-models.ts`** : extraire `projectInTransaction(tx, workspaceId, operationId)` sans principal fabriqué ; conserver le nettoyage et calcul de vue. Sous verrou `projection_work`, lire événements par `projection_sequence`, insérer les enveloppes manquantes avec cette même séquence, contrôler la correspondance existante, mettre à jour `projectionCursors` et `operationViews`, puis `dirty=false` dans le même commit. En cas d'erreur, rollback et dirty reste true. Préserver le verrou et les contraintes ; ne jamais accepter un saut. PREUVE : deux projecteurs concurrents, crash avant/après commit, ordre et déduplication.
5. **`packages/application/src/read-models.ts` et `apps/api/src/activity/activity.controller.ts`** : AVANT lecture → `sync` → écritures ; APRÈS ajouter `summary(actor,id)` qui appelle `getOperation` puis SELECT workspace/id, retourne `NOT_CONFIGURED` (503) si vue pas encore matérialisée ; `activity` appelle d'abord `getOperation`, vérifie également la présence de la vue, puis SELECT paginé ; `recent` vérifie le workspace et ne SELECT que ses vues. Le contrôleur summary appelle `summary`. Garder champs, ordre, limites, `nextCursor` et `transport='POLLING'`. Pour une nouvelle opération, 503 temporaire ou absence dans recent jusqu'au premier passage sont des différences explicites ; aucun succès fictif. PREUVE : réponses existantes identiques après projection, accès croisé 404 et zéro DML sur toutes les tables pendant GET.
6. **`apps/worker/src/runtime.ts`** : créer `projectOnce` sélectionnant en transaction une ligne dirty ordonnée, `FOR UPDATE SKIP LOCKED`, appeler `projectInTransaction` puis commit ; borner le lot, exclure l'opération échouée du reste du passage, journaliser sans données sensibles et réessayer au prochain tour. Dans `startDispatcher`, lancer un passage au démarrage puis un intervalle 5 s non chevauchant ; arrêter l'intervalle dans `close`. `apps/worker/src/main.ts` reste le point d'entrée ; Hatchet reste uniquement l'exécuteur durable de workflow. Le démarrage actuel dépend de l'initialisation Hatchet : si elle échoue, aucun rattrapage n'est assuré. PREUVE : événement committé worker arrêté puis passage après redémarrage ; erreur reste dirty et les autres opérations progressent.
7. **Reconstruction** : l'initialisation `dirty=true` reconstruit toutes les vues, y compris celles sans événement. Pour un replay ultérieur, outil QA/admin explicite met dirty=true sans supprimer enveloppes ni renuméroter ; si une enveloppe manque, la recréer avec la séquence source, sous le même verrou. Si enveloppe erronée, bloquer et ouvrir une procédure de réparation distincte, pas de réécriture automatique des curseurs publiés. PREUVE : pagination avant/après replay inchangée.
8. **Tests nouveaux** : `apps/api/scripts/qa-projection-http.ts` pour routes/auth/DML ; `apps/worker/scripts/qa-projection-worker.ts` pour transactions, backlog, crash et concurrence ; ajouter leurs scripts aux `apps/api/package.json`, `apps/worker/package.json` et raccourcis racine `package.json`. Réutiliser `apps/api/scripts/qa-isolated-database.ts` et migrations, sans réseau externe. Mettre à jour `docs/architecture/PROGRESS.md` et `IMPLEMENTATION_MAP.md` seulement après résultats réels.

Ordre : sauvegarder le diff utilisateur ; écrire d'abord les tests ciblés ; migration + schémas ; projecteur transactionnel ; polling worker ; lectures/contrôleur ; lancer backfill QA puis tests ; vérifier `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm qa:task02`, `pnpm qa:backend`, `pnpm qa:agent-runtime`, `pnpm qa:connectors`, `pnpm qa:raas` avec `QEYNOX_QA_DATABASE_URL` locale jetable. Bascule réelle : opérateur séparé, fenêtre de quiescence, migration puis backfill achevé et contrôlé avant servir les nouveaux GET ; aucune instruction de déploiement ici.

## 7. Matrice de certification future

| Cas | Vérification attendue | État |
| --- | --- | --- |
| GET activity/summary/recent | tracer tous INSERT/UPDATE/DELETE SQL sur requête HTTP authentifiée, aussi à vide et répétée | NOT_RUN |
| Événement et données sans événement | commit → worker → enveloppe/vue exactes sans GET ; rollback ne réveille pas | NOT_RUN |
| Arrêt/reprise | worker absent après commit puis redémarré ; crash avant/après commit, aucun travail perdu | NOT_RUN |
| Concurrence | deux workers et deux transactions dont commits inversés ; pas de doublon, saut ou perte ; verrou libéré après panne | NOT_RUN |
| Replay/historique | migration avec enveloppes existantes, ordre stable, curseurs inchangés ; corruption bloque | NOT_RUN |
| Isolation | deux tenants, IDs croisés, absence d'exposition dans les trois routes et état interne | NOT_RUN |
| Contrat | schémas Flow, pagination, accès plateforme et fenêtre 503 vérifiés | NOT_RUN |
| Exécuteurs externes | aucun changement de contrat Hatchet/Hermes ; intégrations réelles séparées | NOT_RUN |

## 8. Risques restants

Les triggers et verrous ajoutent contention et possibilités de deadlock sur transactions multi-opérations : tester et laisser PostgreSQL annuler/retry sans perdre le travail. L'ordonnancement historique précis ne peut être reconstitué. Une opération continuellement en échec doit être visible dans les logs et ne pas affamer les autres ; vérifier équité et saturation. L'instrumentation présente ne couvre pas l'ensemble des tables. Fenêtre de quiescence et disponibilité du worker sont des conditions de bascule, pas des garanties déjà démontrées. Les gates externes et certification indépendante restent ouverts.

## 9. Instruction prête pour l'agent codeur

Implémente exactement les étapes 1–8 ci-dessus sur une branche de travail adaptée, en préservant le diff existant. Ne retire `sync` des GET qu'après mise en place du rattrapage atomique et des contrôles workspace ; n'ajoute ni SSE ni moteur. Exécute la matrice et les commandes avec PostgreSQL QA local, documente chaque PASS/FAIL/NOT_RUN et ne prétends pas certifier les runtimes externes. Un résultat ambigu ou une incompatibilité historique bloque la bascule.
