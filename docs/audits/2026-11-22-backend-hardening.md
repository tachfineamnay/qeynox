# Audit de durcissement backend — 22 novembre 2026

> Rapport historique du lot PR #47. La [suite du diagnostic et des corrections](2026-11-22-backend-followup.md) apporte PostgreSQL réel, les corrections résiduelles et une nouvelle matrice (41 QA PASS / 6 BLOCKED). Les résultats ci-dessous restent ceux du lot initial.

## Conclusion et périmètre

**Validation globale BLOCKED — ne pas fusionner comme une certification de production.**
Branche `arena/ec0323a4-qeynox`, baseline `311cb97b8cd6a2300b51eef828b4450d00294f47`.
Node.js 22.22.3 ; pnpm 9.15.9 installé dans la sandbox, verrou inchangé.
Aucune modification MyDash/Quiet Authority, `iasser`, `docs/architecture/`, migration ou configuration de déploiement.
Aucun déploiement, merge ou accès à une base de production.

La revue couvre la cartographie de `apps/` et des huit packages, les imports d'infrastructure,
les gardes d'authentification plateforme/workspace, le store tenant, Soul/Pilot,
ToolBroker/egress, claims/delivery/artifacts, le handler worker et l'outbox.
C'est une **revue ciblée avec remédiations**, pas une attestation ligne par ligne de l'ensemble du monorepo.
L'absence de services interdit toute conclusion globale sur les transactions, l'isolation tenant,
les migrations, la concurrence PostgreSQL, la reprise S3 ou la chaîne RaaS en intégration.

## 1. Matrice de validation : baseline → final

Toutes les commandes du `package.json` racine ont été exécutées séquentiellement, sans arrêt au premier
échec : 43 suites QA existantes, puis 44 avec la suite de régression ajoutée.
`PASS` exige une exécution complète ; `BLOCKED` désigne un prérequis absent ; `FAIL` désigne une
assertion/compilation défectueuse. Le code de sortie brut figure séparément : **0 ne signifie pas PASS**
quand le script annonce un blocage. Aucun script existant n'a été modifié pour changer son résultat.

- `PG` : aucun serveur/binaire PostgreSQL ni Docker disponible ; `QEYNOX_QA_DATABASE_URL` absent.
- `S3` : aucun MinIO ; variables `QEYNOX_QA_S3_*` absentes.
- `WB` : appel HTTPS World Bank refusé dans ce réseau Arena (hôtes sortants autorisés limités).
- `Hermes` : endpoint et clé QA absents ; aucune inférence réelle.
- Les doubles de ports/horloges de la nouvelle suite sont des tests locaux, pas une simulation DB/S3
  ni une preuve d'intégration. Les fixtures des suites historiques sont signalées ci-dessous.

| Commande (`pnpm …`) | Baseline | Final | Exit brut B/F | Preuve / limite |
|---|---|---|---|---|
| `install --frozen-lockfile` | PASS | PASS | 0/0 | --frozen-lockfile, verrou inchangé |
| `typecheck` | PASS | PASS | 0/0 | 4 tâches Turbo réussies |
| `build` | PASS | PASS | 0/0 | 4 tâches Turbo réussies |
| `qa:task02` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:backend` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:agent-runtime` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:connectors` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:raas` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:storage` | BLOCKED | BLOCKED | 0/0 | S3 : BLOCKED explicite malgré code 0 |
| `qa:egress` | BLOCKED | BLOCKED | 1/1 | WB : contrôles locaux atteints, échec TLS sur appel réel ; pas de succès live |
| `qa:platform-authorization` | BLOCKED | BLOCKED | 1/1 | PG : partie A OK ; partie B bootstrap bloqué (PilotModule lit capabilities) |
| `qa:platform-admin` | BLOCKED | BLOCKED | 0/0 | PG : base jetable absente |
| `qa:platform-users` | BLOCKED | BLOCKED | 1/1 | PG : partie A 92 assertions OK ; partie B bootstrap bloqué ; partie C non exécutée |
| `qa:platform-organizations` | BLOCKED | BLOCKED | 0/0 | PG : base jetable absente |
| `qa:platform-configuration` | BLOCKED | BLOCKED | 0/0 | PG : base jetable absente |
| `qa:chatwoot` | PASS | PASS | 0/0 | 42 assertions ; fixture HTTP locale, pas Chatwoot live |
| `qa:support-isolation` | PASS | PASS | 0/0 | fixture locale ; isolation support |
| `qa:support-private` | PASS | PASS | 0/0 | fixture locale ; notes privées |
| `qa:support-concurrency` | PASS | PASS | 0/0 | 11 assertions ; fixture locale |
| `qa:support-reconciliation` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:hermes-contract` | PASS | PASS | 0/0 | 57 assertions ; contrat, pas inférence réelle |
| `qa:hermes-live` | BLOCKED | BLOCKED | 3/3 | Hermes : configuration et credentials absents |
| `qa:hermes-live-selftest` | PASS | PASS | 0/0 | 15 assertions ; auto-test, pas inférence réelle |
| `qa:runtime-readiness` | PASS | PASS | 0/0 | 70 + 27 assertions ; readiness locale |
| `qa:runtime-verification` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:a03-service` | BLOCKED | BLOCKED | 3/3 | PG : partie locale 49 assertions OK ; intégration bloquée |
| `qa:service-catalogue` | BLOCKED | BLOCKED | 3/3 | PG : partie locale 22 assertions OK ; intégration bloquée |
| `qa:connector-hub` | BLOCKED | BLOCKED | 3/3 | PG : partie locale 18 assertions OK ; intégration bloquée |
| `qa:identity` | BLOCKED | BLOCKED | 3/3 | PG : base jetable absente |
| `qa:soul-intelligence` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:pilot-planner` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:mission-lifecycle` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:atlas-results` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:stripe-payments` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:payment-freeze` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:beta-access` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:beta-execution` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:verification-resend` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:registration` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:beta-journey` | BLOCKED | BLOCKED | 1/1 | PG : base jetable absente |
| `qa:brave-search` | BLOCKED | BLOCKED | 3/3 | PG : partie locale 23 assertions OK ; intégration bloquée |
| `qa:workspace-management` | BLOCKED | BLOCKED | 3/3 | PG : partie locale annonce 0 assertion ; aucune preuve à en déduire |
| `qa:documents` | BLOCKED | BLOCKED | 3/3 | PG : partie locale 18 assertions OK ; intégration bloquée |
| `qa:notifications` | BLOCKED | BLOCKED | 3/3 | PG : base jetable absente |
| `qa:business-packs` | BLOCKED | BLOCKED | 1/1 | PG : partie locale 217 assertions OK ; intégration bloquée |
| `qa:atlas-library` | BLOCKED | BLOCKED | 1/1 | PG : partie locale 13 assertions OK ; intégration bloquée |
| `qa:security-regressions` | FAIL* | PASS | repro/0 | 6 tests ; 0 échec, 0 ignoré ; tests locaux seulement |

**Résultat final : install/typecheck/build PASS ; QA : 8 PASS, 36 BLOCKED (33 PG, 1 S3, 1 WB, 1 Hermes), aucun FAIL de code établi dans la dernière passe.** Les 36 suites ne sont pas certifiées.

\* La nouvelle suite n'existait pas dans le `package.json` baseline. Son harnais a été exécuté
directement avec `pnpm --filter @qeynox/worker exec tsx --test scripts/qa-security-regressions.ts`
AVANT les corrections : les quatre premiers tests étaient rouges. Les deux tests du nouveau poller
ont été ajoutés ensuite. Cette reproduction n'est pas une exécution rétroactive de la suite complète.

Les suites plateforme prétendument sans DB s'arrêtent après leurs invariants locaux. Un bootstrap
avec `abortOnError:false` a exposé `ECONNREFUSED` dans
`apps/api/src/pilot/pilot.module.ts:37` (`store.getCapabilities()` pendant l'injection).
Le bootstrap de diagnostic temporaire a été supprimé ; les gardes et leurs audits n'ont pas été contournés.

Une passe intermédiaire du nouveau harnais a échoué au typecheck/build (`TS2322`, `TS2345`) à cause
de l'inférence du resolver de Promise et du narrowing de `assert.deepEqual`. Ces deux erreurs ont
été corrigées avec des types explicites, sans `any`, suppression d'assertion ou directive d'ignorance.

## 2. Journal des remédiations

Les lignes ci-dessous se rapportent à la version de cette PR.

| Priorité / fichier:ligne | Défaut | Correction | Preuve et limite |
|---|---|---|---|
| **P0** `packages/tools/src/egress.ts:59` | Les tests textuels IPv6 acceptaient les formes développées de `::`/`::1`, les mapped privées et plusieurs plages non publiques | Canonicalisation WHATWG et comparaison numérique des préfixes ; seuls les global-unicast ordinaires sont éligibles ; refus NAT64/mapped/6to4/Teredo/documentation ; ajout relais IPv4 `192.88.99.0/24` | Régression `egress rejects equivalent IPv6 spellings…` : 20 adresses rejetées aussi au resolver, 5 publiques acceptées. RED → GREEN. Transport live WB BLOCKED |
| **P0** `packages/domain/src/consent.ts:5`, `packages/roles/src/soul.ts:32`, `packages/application/src/mission-documents.ts:72` | Comparaison lexicographique, expiration vide/malformée ou avec offset ; jour impossible normalisé par JS ; règles divergentes entre consommateurs | Règle temporelle commune fail-closed ; fuseau obligatoire, date calendaire valide, expiration future stricte ; refus et normalisation lors du grant ; réutilisation dans contexte, écriture, onboarding, documents | Régression `consent expiry is temporal…` : dates invalides, égalité, offsets, révocation, identité/scopes ; RED → GREEN. Chemins Soul/documentaires DB BLOCKED |
| **P0** `packages/application/src/agent-tools.ts:61` | Scopes de consentement capturés au début du run, donc potentiellement périmés/révoqués après l'inférence | Lecture des consentements avant chaque proposition d'outil, filtrage identité workspace/utilisateur et validité temporelle | Règle temporelle locale PASS ; inspection du chemin + typecheck/build PASS. `qa:agent-runtime`/`qa:connectors` DB BLOCKED : pas de preuve d'interleaving concurrent ni de révocation linéarisable |
| **P1** `packages/tools/src/broker.ts:17`, `packages/tools/src/manifest.ts:16`, `packages/tools/src/registry.ts:17` | `NaN`, Infinity, fractions et dépassement du timer JS passaient certaines comparaisons | Entiers sûrs, coûts/quota/TTL bornés et timeout 100..2147483647 ms | Régressions registry/broker : rejet avant réservation du ledger ou appel provider ; contrôle positif outil gratuit ; RED → GREEN |
| **P1** `packages/tools/src/registry.ts:13` | Échec d'enregistrement laissant des définitions fantômes ; doublons dans le même lot | Validation complète dans une Map temporaire puis publication atomique synchrone | Régression registry : lot invalide/doublon laisse registre vide ; enregistrement corrigé possible |
| **P1** `apps/worker/src/runtime.ts:177`, `apps/worker/src/serial-poller.ts:18` | `setInterval` pouvait chevaucher les drains lents ; timer conservé après fermeture du pool | Polling sérialisé, démarrage unique ; stop annule le timer et attend le drain avant fermeture DB | Deux tests poller : drain lent, double start, stop attendu, absence de reprise après stop, erreur/reprise ; horloges locales, pas Hatchet/PG |
| **P1** `apps/worker/src/main.ts:60` | Rejet non géré pendant l'initialisation documentaire lancée avec void | Catch explicite, diagnostic et exitCode 1 ; aucun succès de démarrage inventé | Typecheck/build PASS ; pas de test dédié d'initialisation réelle, stockage/DB BLOCKED |
| **P2** `packages/persistence/src/store.ts:97` (emplacement de suppression) | Helper `updateAttempt` inutilisé qui ignorait `expectedVersion` et permettait un faux contrat de concurrence | Suppression du helper mort ; les chemins actifs worker/progression gardent leurs CAS/verrous existants | Recherche des références : aucun appel dans apps/packages ; typecheck/build PASS. Aucune prétention de QA concurrence DB |

Tests : `apps/worker/scripts/qa-security-regressions.ts:22,40,68,91,130,160`.
Commande ajoutée : `pnpm qa:security-regressions`. Aucun test existant désactivé, aucune assertion
existante retirée, aucune dépendance ajoutée, aucun verrou modifié.

## 3. Observations d'architecture et portes de déploiement

- **Domaine** : pas d'import PostgreSQL/Drizzle/SDK externe constaté. **Application : découplage
  infrastructure NON total** : dépendances directes à `QeyNoxStore`/Drizzle et adaptateurs S3,
  mail, paiements/probes. Une migration vers des ports purs est un chantier séparé, non réalisé ici.
- SDK Hatchet concentré dans `packages/orchestration`, port moteur présent, huit slots configurables
  conservés. Le poller ajouté ne programme aucun workflow métier et ne remplace pas Hatchet.
- Gardes plateforme/workspace et namespaces de session distincts observés ; invariants locaux
  plateforme OK. **Isolation NestJS/tenant et concurrence des révocations non certifiées en HTTP/DB**.
- Claims, sources/digests, revue, readiness et fulfillment sont présents dans les services inspectés ;
  **chaîne RaaS réelle non vérifiée** ici. Même limite pour les uploads SHA-256, URLs signées,
  `PENDING_UPLOAD`, récupération après crash, outbox et observation Hatchet externe.
- La relecture des consentements évite le snapshot de début de run, mais ne constitue pas une
  transaction linéarisable avec le connecteur : révocation pendant une réservation ou un appel
  déjà lancé à qualifier dans les tests de concurrence avec PostgreSQL.
- Le cycle documentaire de `main.ts` reste distinct du poller outbox : ses drains, ses leases et son
  arrêt complet nécessitent une certification DB/S3. Le catch ajouté ne garantit pas leur exécution.
- **Hermes externe** : ni inférence, ni isolation réseau/native-tools attestée réellement dans cette
  session. Les attestations d'environnement seules ne remplacent pas l'observation du runtime.
- **Egress firewall** : pinning/refus de redirections conservés ; aucun test réseau de rebinding
  réel exécuté. Plages de transition désormais refusées, même pour certains cas publics ; valider
  les providers dans le réseau cible. Un DNS64 à préfixe opérateur spécifique ne se traite pas
  par une liste statique seule : isolation/firewall sortant restent requis.
- Identité publique/MFA/rate-limit ingress, licensing/fraîcheur providers, backups et rollback DB
  restent des portes opérationnelles non certifiées ; aucun changement de déploiement ici.

### Reprise de certification

Fournir PostgreSQL jetable **local**, MinIO isolé et les variables QA documentées ; permettre
l'accès en lecture au provider World Bank dans un environnement contrôlé. Relancer toutes les suites,
puis certifier indépendamment Hatchet, Hermes et le firewall dans le réseau cible. Ne pas substituer
une DB en mémoire, un provider inventé ou un faux succès S3 pour débloquer la PR.

## Extraits bruts des commandes exécutées

Les extraits ne modifient pas les libellés des scripts : certains écrivent FAILED pour une absence
de prérequis, classée BLOCKED dans la matrice. Les codes bruts restent visibles ci-dessus.

### Compilation et installation finales

```text
$ pnpm install --frozen-lockfile
Scope: all 13 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 1.2s using pnpm v9.15.9
$ pnpm typecheck

 Tasks:    4 successful, 4 total
Cached:    2 cached, 4 total
  Time:    23.662s

$ pnpm build

 Tasks:    4 successful, 4 total
Cached:    2 cached, 4 total
  Time:    24.467s

```

### Reproduction avant correction

```text
not ok 1 - egress rejects equivalent IPv6 spellings and non-public transition/reserved ranges
not ok 2 - consent expiry is temporal, timezone-aware and fail-closed for malformed timestamps
  error: 'Missing expected exception (denied): invalid'
not ok 3 - tool registry rejects non-finite limits and registration is atomic
  error: 'Missing expected exception (DomainError): NaN'
not ok 4 - broker rejects malformed budgets before ledger reservation or provider execution
  error: 'remainingCostUnits:NaN'
# pass 0
# fail 4
```

### Nouvelle suite finale

```text
> qeynox@0.1.0 qa:security-regressions /home/user/qeynox
> pnpm --filter @qeynox/worker qa:security-regressions


> @qeynox/worker@0.1.0 qa:security-regressions /home/user/qeynox/apps/worker
> tsx --test scripts/qa-security-regressions.ts

TAP version 13
# (node:22625) ExperimentalWarning: The MockTimers API is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: egress rejects equivalent IPv6 spellings and non-public transition/reserved ranges
ok 1 - egress rejects equivalent IPv6 spellings and non-public transition/reserved ranges
  ---
  duration_ms: 8.402208
  type: 'test'
  ...
# Subtest: consent expiry is temporal, timezone-aware and fail-closed for malformed timestamps
ok 2 - consent expiry is temporal, timezone-aware and fail-closed for malformed timestamps
  ---
  duration_ms: 1.63664
  type: 'test'
  ...
# Subtest: tool registry rejects non-finite limits and registration is atomic
ok 3 - tool registry rejects non-finite limits and registration is atomic
  ---
  duration_ms: 0.87266
  type: 'test'
  ...
# Subtest: broker rejects malformed budgets before ledger reservation or provider execution
ok 4 - broker rejects malformed budgets before ledger reservation or provider execution
  ---
  duration_ms: 2.788373
  type: 'test'
  ...
# Subtest: worker poller serializes slow drains and stop waits for the active drain
ok 5 - worker poller serializes slow drains and stop waits for the active drain
  ---
  duration_ms: 1.366146
  type: 'test'
  ...
# Subtest: worker poller handles rejection and continues without unhandled promises
ok 6 - worker poller handles rejection and continues without unhandled promises
  ---
  duration_ms: 0.479325
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1276.668267
```

### Suites historiques : blocages observés

```text
$ pnpm qa:task02
QA verification FAILED: DomainError: QEYNOX_QA_DATABASE_URL is required for isolated QA runs
$ pnpm qa:backend
Backend certification FAILED: DomainError: QEYNOX_QA_DATABASE_URL is required for isolated QA runs
$ pnpm qa:agent-runtime
Agent runtime QA FAILED: DomainError: QEYNOX_QA_DATABASE_URL is required for isolated QA runs
$ pnpm qa:connectors
Connector QA FAILED: DomainError: QEYNOX_QA_DATABASE_URL is required for isolated QA runs
$ pnpm qa:raas
RAAS deliverable QA FAILED: DomainError: QEYNOX_QA_DATABASE_URL is required for isolated QA runs
$ pnpm qa:storage
STORAGE QA BLOCKED: QEYNOX_QA_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY are not configured; no live S3 checks performed.
$ pnpm qa:egress
Provider egress QA FAILED: DomainError: Provider connection failed: Client network socket disconnected before secure TLS connection was established
$ pnpm qa:platform-authorization
  part A authorization invariants: OK
$ pnpm qa:platform-admin
BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The platform administration HTTP e2e suite needs an isolated PostgreSQL database; no result is claimed.
$ pnpm qa:platform-users
  part A users-management invariants: OK (92 assertions so far)
$ pnpm qa:platform-organizations
BLOCKED: QEYNOX_QA_DATABASE_URL is not set. The organizations QA suite requires an isolated PostgreSQL database; no result is claimed.
```

### Codes de sortie bruts finaux (non assimilés aux statuts de certification)

```text
install	0
typecheck	0
build	0
qa:task02	1
qa:backend	1
qa:agent-runtime	1
qa:connectors	1
qa:raas	1
qa:storage	0
qa:egress	1
qa:platform-authorization	1
qa:platform-admin	0
qa:platform-users	1
qa:platform-organizations	0
qa:platform-configuration	0
qa:chatwoot	0
qa:support-isolation	0
qa:support-private	0
qa:support-concurrency	0
qa:support-reconciliation	1
qa:hermes-contract	0
qa:hermes-live	3
qa:hermes-live-selftest	0
qa:runtime-readiness	0
qa:runtime-verification	1
qa:a03-service	3
qa:service-catalogue	3
qa:connector-hub	3
qa:identity	3
qa:soul-intelligence	1
qa:pilot-planner	1
qa:mission-lifecycle	1
qa:atlas-results	1
qa:stripe-payments	1
qa:payment-freeze	1
qa:beta-access	1
qa:beta-execution	1
qa:verification-resend	1
qa:registration	1
qa:beta-journey	1
qa:brave-search	3
qa:workspace-management	3
qa:documents	3
qa:notifications	3
qa:business-packs	1
qa:atlas-library	1
qa:security-regressions	0
```
