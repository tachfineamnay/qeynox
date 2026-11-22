# Suite du durcissement backend — 22 novembre 2026

## Verdict

**Corrections ciblées implémentées et vérifiées ; certification de production toujours BLOCKED.**
Branche `arena/a0e79c48-qeynox`, base `b85f602054402f7860e19521209b579752a23afd` (PR #47 fusionnée).
Ce rapport complète l'[audit précédent](2026-11-22-backend-hardening.md), sans en réécrire les observations historiques.
Aucune UI, modification `iasser`, décision `docs/architecture/`, migration appliquée ou configuration de production modifiée.
Aucun push, merge ou déploiement effectué pour ce lot.

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` : **PASS**, verrou inchangé.
- Les **47 suites QA racine ont été exécutées** : **41 PASS dans leurs frontières, 6 BLOCKED**, aucun FAIL applicatif restant observé dans cette matrice.
- Les résultats ne constituent pas une preuve d'inférence Hermes, d'exécution Hatchet réelle, de livraison fournisseur, de stockage S3 ou de protection réseau de production.
- Les anomalies reproductibles ciblées sont corrigées. « Tout certifié » serait faux : le plan des travaux externes et architecturaux restants figure ci-dessous.

## 1. Plan exécuté et preuves avant/après

### Lot A — PostgreSQL réel et diagnostic différentiel

La première matrice sans services ne permettait pas de vérifier les intégrations. Un vrai serveur PostgreSQL **16.6** a été provisionné dans le scratch local à partir de `@embedded-postgres/linux-x64@16.6.0-beta.14` : binaire natif, `initdb`, pool `pg`, migrations et bases jetables créées/supprimées par les suites. Ce n'est ni PGlite, ni un mock DB. Aucun paquet projet ajouté. L'[observation SQL du serveur](evidence/2026-11-22-followup/postgresql-runtime.txt) conserve version, base et adresse.
Le serveur ne servait qu'à la QA locale sur loopback. Les opérations ne concernent aucune base de production.

Baseline avec PostgreSQL, sur les 44 suites préexistantes : **33 PASS, 5 FAIL applicatifs/harnais, 6 BLOCKED externes**.
Les cinq FAIL étaient `task02`, `platform-authorization`, `platform-users`, `beta-execution`, `business-packs`.
Les erreurs TLS de `connectors`, `raas`, `egress` sont classées BLOCKED réseau, avec leur exit brut **1** conservé ; elles ne sont pas transformées en PASS.

### Lot B — Pilot : bootstrap, fraîcheur et cache

**Avant :** `PilotModule` lisait les capacités au bootstrap Nest ; même les routes de contrôle ne nécessitant aucune DB échouaient sur une connexion volontairement inaccessible. Le catalogue restait ensuite figé. Un cache par tentative pouvait retourner budget/readiness/profil/prompt périmés.

**Correction :**
- `apps/api/src/pilot/pilot.module.ts:36` : factory synchrone, lecture lazy par requête via un port.
- `packages/roles/src/pilot-planner.ts:302-355` : un seul snapshot de capacités par proposition, également utilisé pour valider la sortie ; empreinte du cache sur workspace/utilisateur/opération/tentative et configuration complète des capacités, profil, budget, objectif, requête et readiness.
- Les tentatives inchangées restent cachées ; une désactivation rend `NO_CAPABILITIES` sans rejouer une proposition ancienne.
- `packages/roles/src/capabilities.ts:11-14` : versions et plafonds actifs obligatoirement entiers sûrs ; NaN, infini, fractions et valeurs hors plage refusés.

**Preuves :** trois nouveaux groupes d'abord **RED 0/3**, ensuite **GREEN 3/3**, transcript conservé. `qa:platform-authorization` **107 assertions** sans DB ; `qa:platform-users` **165 assertions**, dont 58 PostgreSQL ; `qa:pilot-planner` **10 groupes PASS**. Les tests de fraîcheur utilisent des ports locaux explicitement nommés QA, pas un modèle live.

### Lot C — Autorisation au dernier point avant le fournisseur

**Avant :** recharger le consentement avant la réservation budgétaire ne couvrait pas une révocation pendant les attentes budget/limiteur/ledger. Un snapshot d'approbation WRITE pouvait aussi être devenu inactif.

**Correction :**
- `packages/tools/src/authorization.ts:7-39` : port d'autorisation et adaptateur PostgreSQL ; vérifie propriétaire et workspace, appartenance ACTIVE, opération/tentative RUNNING, révision courante, consentements encore actifs et approbation WRITE courante/valide liée à l'intention.
- `packages/application/src/agent-tools.ts:20` : l'exécuteur runtime injecte obligatoirement cet adaptateur dans son broker.
- `packages/tools/src/broker.ts:25-46` : dernière relecture **après** limiteur et réservation ledger, avant `connector.invoke`. Un refus pré-appel inscrit `FAILED`, pas `UNKNOWN` ; une erreur WRITE après entrée dans le connecteur reste incertaine.
- Version de profil du broker également bornée à un entier sûr.

**Preuve nouvelle `qa:tool-authorization` :** vraie base PostgreSQL jetable et vrai `PgToolLedger`, ports fournisseur/file d'attente explicitement QA. Les seules deux entrées fournisseur sont le READ autorisé et le WRITE explicitement approuvé. Révocation au quota puis au ledger, retrait d'appartenance, interruption, expiration de consentement et approbation WRITE devenue inactive : refus et aucune entrée fournisseur. Refus WRITE pré-appel enregistré `FAILED`.

**Frontière importante :** cette décision n'est pas une transaction distribuée avec le fournisseur. Elle n'annule pas un appel déjà entré, ne garantit pas une révocation atomique inter-processus après le dernier SELECT, et ne revalide pas à elle seule toutes les politiques/profils/catalogues pendant chaque tour d'inférence. Pas de verrou DB maintenu pendant une requête réseau. Ces propriétés exigent une politique explicite, des epochs/leases d'autorisation si nécessaires, et des tests système concurrents (plan ci-dessous).

### Lot D — Cycle de vie worker/poller documentaire

**Avant :** `main.ts` démarrait un deuxième pool et un `setInterval` documentaire hors du cycle worker ; drains chevauchants, pas d'attente de fin ni de fermeture de pool.

**Correction :**
- `apps/worker/src/main.ts:5-10` : orchestration dans `try/finally`, fermeture des dépendances.
- `apps/worker/src/runtime.ts:37-49,185-227` : poller documentaire sur le pool du worker ; `SerialPoller` enchaîne ingestion, rétention et suppression sans chevauchement dans cette boucle. Arrêt des pollers attendu avant fermeture idempotente du pool ; une initialisation échouée ferme aussi sa connexion.
- `QEYNOX_DOCUMENT_INGEST_INTERVAL_MS=0` désactive ; valeurs non entières, négatives ou hors plage de timer refusées. Sans stockage configuré, aucune ingestion prétendue.
- `packages/orchestration/src/worker-lifecycle.ts:12-45`, `hatchet.ts:73-79` : cycle start/stop, erreurs et SIGINT/SIGTERM ; `handleKill:false` laisse QeyNox attendre son nettoyage au lieu d'un `process.exit(0)` du SDK.

**Preuves :** `qa:worker-lifecycle` **5/5** (signaux, drains lents, erreurs startup/worker/teardown) ; `qa:security-regressions` **6/6**, dont sérialisation/arrêt du poller. Ce sont des tests de ports et d'horloge, **pas Hatchet/S3 live**. Le SDK installé possède aussi ses propres handlers de signal : son arrêt peut commencer en parallèle ; la fermeture du pool attend le nettoyage géré. Un drain réseau bloqué peut prolonger l'arrêt ; pas de faux succès ni de fermeture forcée sous un handler actif. Le délai de grâce du déploiement reste à qualifier.

### Lot E — Parité du schéma et fixtures métier obsolètes

**Parité PostgreSQL/Drizzle :** `qa:task02` échouait sur les index uniques nommés différemment des contraintes réellement appliquées. La suite stricte a ensuite exposé un index et un CHECK non déclarés.
- `packages/persistence/src/notification-schema.ts:24,55` : unicité déclarée sur les colonnes, conforme aux contraintes inline de la migration 0024 (pas un deuxième index inventé).
- `packages/persistence/src/schema.ts:33` : index partiel `operation_events_notification_scan_idx` de la migration 0031 déclaré.
- `packages/persistence/src/result-schema.ts:69` : CHECK `access_count >= 0` et ordre DESC de l'index existant représentés.
- **Aucune migration appliquée et aucune assertion de parité modifiée. `qa:task02` PASS : 5022 assertions.**

**Harnais des packs :** les suites terminaient manuellement les étapes avec du texte, sans le `businessDeliverable` requis depuis P09 ni les claims de l'étape terminale. Le refus de `ResultAssembler` était légitime.
- `apps/api/scripts/qa-pack-step.ts:15-33` récupère la mission persistée, identifie le step terminal, utilise le vrai validateur lié au fingerprint/contrat, les captures enregistrées et le vrai pipeline de claims.
- `qa-business-packs.ts:1202`, `qa-beta-execution.ts:416` persistent l'enveloppe ; les claims sont évalués/revus explicitement. La fixture beta attache ses captures corroborantes via `ClaimsService` (les deux sources exigées restent exigées).
- **Production fail-closed inchangée**, aucune assertion supprimée : `qa:business-packs` **372 assertions PASS**, `qa:beta-execution` **472 assertions / 13 groupes PASS**. Les fournisseurs de ces suites sont des fixtures locales préexistantes ; pas de preuve de livraison externe.

## 2. Matrice complète et preuves terminal

Les sorties terminal ne sont pas paraphrasées ; seuls les espaces de fin de ligne sont normalisés pour Git. Les [transcripts bruts](evidence/2026-11-22-followup/validation-finale.txt) conservent les frontières annoncées par chaque suite. La [matrice TSV](evidence/2026-11-22-followup/validation.tsv) contient les exits baseline/final de chaque commande. Le wrapper de collecte continue après erreur : son exit global n'est jamais utilisé comme verdict.

- [Baseline PostgreSQL et checks racine initiaux](evidence/2026-11-22-followup/baseline-postgresql.txt).
- [Régressions RED](evidence/2026-11-22-followup/regressions-red.txt).
- [Erreur de compilation intermédiaire](evidence/2026-11-22-followup/compilation-intermediaire.txt) : le nouveau test lifecycle a révélé un port `Pick<Process, 'on' | 'off'>` trop large pour EventEmitter ; corrigé par une interface minimale `WorkerSignalsPort`, sans cast ni suppression. Root typecheck/build relancés avec succès.

**PASS ne dépasse jamais la frontière de la suite.** En particulier documents teste une DB réelle mais un port stockage mémoire préexistant ; beta-journey et runtime-verification utilisent des fixtures locales de runtime ; paiements/e-mails/support utilisent des replays ou transports QA. Pas de DB/S3 simulé ajouté pour prétendre à une certification live. Aucun fournisseur live bloqué n'a été remplacé pour faire passer sa suite.

| Commande `pnpm …` | Baseline | Final | Exit B/F |
|---|---|---|---|
| `install --frozen-lockfile` | PASS | PASS | 0/0 |
| `typecheck` | PASS | PASS | 0/0 |
| `build` | PASS | PASS | 0/0 |
| `qa:task02` | FAIL | PASS | 1/0 |
| `qa:backend` | PASS | PASS | 0/0 |
| `qa:agent-runtime` | PASS | PASS | 0/0 |
| `qa:connectors` | BLOCKED | BLOCKED | 1/1 |
| `qa:raas` | BLOCKED | BLOCKED | 1/1 |
| `qa:storage` | BLOCKED | BLOCKED | 0/0 |
| `qa:egress` | BLOCKED | BLOCKED | 1/1 |
| `qa:platform-authorization` | FAIL | PASS | 1/0 |
| `qa:platform-admin` | PASS | PASS | 0/0 |
| `qa:platform-users` | FAIL | PASS | 1/0 |
| `qa:platform-organizations` | PASS | PASS | 0/0 |
| `qa:platform-configuration` | PASS | PASS | 0/0 |
| `qa:chatwoot` | PASS | PASS | 0/0 |
| `qa:support-isolation` | PASS | PASS | 0/0 |
| `qa:support-private` | PASS | PASS | 0/0 |
| `qa:support-concurrency` | PASS | PASS | 0/0 |
| `qa:support-reconciliation` | PASS | PASS | 0/0 |
| `qa:hermes-contract` | PASS | PASS | 0/0 |
| `qa:hermes-live` | BLOCKED | BLOCKED | 3/3 |
| `qa:hermes-live-selftest` | PASS | PASS | 0/0 |
| `qa:runtime-readiness` | PASS | PASS | 0/0 |
| `qa:runtime-verification` | PASS | PASS | 0/0 |
| `qa:a03-service` | BLOCKED | BLOCKED | 3/3 |
| `qa:service-catalogue` | PASS | PASS | 0/0 |
| `qa:connector-hub` | PASS | PASS | 0/0 |
| `qa:identity` | PASS | PASS | 0/0 |
| `qa:soul-intelligence` | PASS | PASS | 0/0 |
| `qa:pilot-planner` | PASS | PASS | 0/0 |
| `qa:mission-lifecycle` | PASS | PASS | 0/0 |
| `qa:atlas-results` | PASS | PASS | 0/0 |
| `qa:stripe-payments` | PASS | PASS | 0/0 |
| `qa:payment-freeze` | PASS | PASS | 0/0 |
| `qa:beta-access` | PASS | PASS | 0/0 |
| `qa:beta-execution` | FAIL | PASS | 1/0 |
| `qa:verification-resend` | PASS | PASS | 0/0 |
| `qa:registration` | PASS | PASS | 0/0 |
| `qa:beta-journey` | PASS | PASS | 0/0 |
| `qa:brave-search` | PASS | PASS | 0/0 |
| `qa:workspace-management` | PASS | PASS | 0/0 |
| `qa:documents` | PASS | PASS | 0/0 |
| `qa:notifications` | PASS | PASS | 0/0 |
| `qa:business-packs` | FAIL | PASS | 1/0 |
| `qa:atlas-library` | PASS | PASS | 0/0 |
| `qa:security-regressions` | PASS | PASS | 0/0 |
| `qa:hardening-followup` | — | PASS | —/0 |
| `qa:tool-authorization` | — | PASS | —/0 |
| `qa:worker-lifecycle` | — | PASS | —/0 |

L'avertissement `terminating connection due to administrator command` après les 98 assertions notifications provient du nettoyage de la base jetable ; conservé dans le transcript. Il n'est pas une preuve d'incident production, ni silencieusement effacé.

## 3. Plan restant — critères de levée, pas de faux « tout terminé »

| Priorité / lot | État | Travail et preuve de sortie requis |
|---|---|---|
| P0 — fournisseurs réseau / RaaS live | BLOCKED réseau Arena | Sur runner à egress autorisé, relancer `qa:connectors`, `qa:egress`, `qa:raas`, `qa:a03-service` avec PostgreSQL jetable. Conserver provenance réelle, digest de réponse, claims revus et livraison ; aucun replay substitué. Vérifier licences, fraîcheur et quotas fournisseur. |
| P0 — stockage réel et reprise | BLOCKED S3 | Fournir un S3/MinIO **jetable** et `QEYNOX_QA_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY`, puis `pnpm qa:storage`. Qualifier put/head/get, digest, versioning, URLs signées, isolation tenant. Tester crash après réservation `PENDING_UPLOAD`, après PUT/avant commit, double reconciliation, objet incompatible, suppressions/retries et leases de reprise. Les mécanismes existants ne sont pas certifiés par une simple revue. |
| P0 — runtime complet | BLOCKED services | Déployer une QA isolée Hatchet/Hermes réellement configurée ; `qa:hermes-live`, readiness worker propre, exécution complète ToolBroker → claims → revue humaine → artefacts. Vérifier déconnexion/reconnexion, arrêt SIGTERM pendant étape/dispatch/ingestion, reprise outbox, pas de double side effect. Les suites contrats/selftests ne lèvent pas cette porte. |
| P0 — isolation outils natifs et egress | BLOCKED infra | Démontrer que Hermes n'a pas de chemin outil natif hors broker. Tester firewall réellement appliqué, métadonnées cloud/private IP, IPv6 et DNS rebinding/pinning, redirects et timeouts sur le réseau déployé. Un booléen d'attestation ne suffit pas. |
| P1 — révocation systémique | PARTIEL, dernier check outil testé | Définir le point d'effet contractuel d'une révocation pour inférence/contexte/outils. Si l'exigence impose une linéarisation multi-processus, concevoir epochs/leases d'autorisation avec invalidation, et tests avec deux connexions/transactions et fournisseur retardé. Revalider si nécessaire capacités/profils/politiques en cours de run. Ne jamais promettre d'annuler des données déjà envoyées ni conserver un verrou transactionnel sur le réseau. |
| P1 — isolation HTTP/DB | PARTIEL, suites existantes PASS | Étendre la matrice aux nouveaux endpoints et à deux connexions concurrentes : membership retiré, révision changée, IDs étrangers, sessions/partages révoqués ; code de refus, aucune ligne inter-tenant, aucune URL signée indue. Les tests existants valident leurs routes, pas toutes les combinaisons possibles. |
| P1 — ports application / transactions | PLANIFIÉ | 1. Inventorier imports infrastructure par use case et transactions atomiques. 2. Extraire ports étroits par domaine (lecture autorisation/catalogue, puis missions/commerce), garder adaptateurs PostgreSQL dans la composition. 3. Préserver outbox, contraintes et verrous dans une unité de travail explicite ; pas d'interface générique masquant les invariants SQL. 4. Contrats d'adaptateur sur PG réel, isolation/concurrence et matrice inchangées à chaque lot. 5. Seulement ensuite déplacer providers/S3/probes hors application. Les nouveaux ports catalogue/autorisation/lifecycle sont un premier pas, pas une architecture hexagonale achevée. |
| P1 — arrêt et observabilité en déploiement | PARTIEL, ports locaux PASS | Mesurer durée max des drains/appels, grace period superviseur, signaux du SDK installé, sondes en vol et absence de pool après arrêt ; métriques outbox/ingestion/suppressions épuisées et alertes opérateur. Ne pas assimiler tests d'EventEmitter à une preuve de SIGTERM sur runtime live. |
| P0/P1 — exploitation production | BLOCKED opérateur | Audit ingress TLS, MFA plateforme/admin, rotation des secrets, sauvegarde/restauration, rollback compatible migrations et preuve d'isolation des environnements. Exécuter une qualification indépendante avant toute ouverture publique. |

**MinIO :** la release courante consultée n'offrait pas d'assets. Une ancienne release officielle possédait un binaire Linux, mais `gh release download` échoue sur la redirection vers `release-assets.githubusercontent.com` (hôte non autorisé dans ce réseau). Ni binaire non vérifié lancé, ni S3 factice substitué. Une ancienne version n'aurait de toute façon servi qu'à une QA jetable, jamais de recommandation de production.

## 4. Reproduire

Dans un environnement isolé, avec une base QA autorisant create/drop (jamais production) :

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
# Définir QEYNOX_QA_DATABASE_URL via la configuration sécurisée du runner.
pnpm qa:task02
pnpm qa:hardening-followup
pnpm qa:tool-authorization
pnpm qa:worker-lifecycle
# Puis chaque commande QA de validation.tsv ; ne pas ignorer les exits non nuls.
```

Le script d'autorisation retourne **3** si la DB QA manque. `qa:storage` historique retourne **0** en annonçant BLOCKED sans S3 : un runner doit donc conserver l'interprétation du log, pas seulement le code shell. Les services externes et leurs secrets doivent être configurés côté runner, pas dans le dépôt ou la conversation.

Nettoyage final : aucune base QA résiduelle (observation SQL conservée), serveur PostgreSQL jetable arrêté proprement, distribution native/données/scratch et checklist temporaire supprimés après conservation des preuves ci-dessus.
