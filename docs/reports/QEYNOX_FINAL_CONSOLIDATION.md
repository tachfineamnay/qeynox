# QeyNox — Rapport final de consolidation

- **Repository** : https://github.com/tachfineamnay/qeynox
- **Date** : 2026-11-07 (Africa/Casablanca)
- **Branche de référence** : `main`
- **Branche d'intégration** : `consolidation/qeynox-final` (PR #9)
- **Statut final** : **GO** pour la consolidation du code, avec les contrôles non exécutables en local explicitement listés en §8.

---

## 1. Résumé exécutif

Tout le travail utile dispersé sur les branches a été réuni dans `main` sans perte de code :

1. les correctifs **V1.5** déjà fusionnés sur `main` (sécurité, chemins runtime, runner unique, repository SQLite unique, dossiers versionnés, déploiement Coolify) sont **conservés** ;
2. les **garde-fous legacy P0** de `fix/lot0a-foundation-guards` (6 commits) ont été récupérés et adaptés à l'API V1.5 ;
3. le **Domain Core V2** de `fix/lot0-legacy-p0` (8 commits : domaine, providers, artefacts immuables, PostgreSQL, adaptateur Hatchet, tests) est intégré ;
4. les PR empilées #3 à #7, dont le code était déjà un ancêtre de `main`, ont été **clôturées comme superseded** avec preuve d'ascendance, sans perdre leur historique ;
5. la documentation d'architecture V2 (`docs/`) et le pack preprod sont présents dans `main`.

Aucune branche distante n'a été supprimée. Aucun force-push. Aucun merge aveugle. Aucune migration destructive. Aucun déploiement.

---

## 2. Références Git

| Élément | SHA |
|---|---|
| **SHA initial de `main`** (début de mission, après `fetch`) | `c15cc2cdee162345d993d40fd41fe20fb1069fc2` (« Merge PR #8 ») |
| **SHA final de `main`** (fusion de la consolidation, code) | `7aaa3c17866b397cc7f08ce6132da3ab7a01b555` (« Merge PR #9: consolidation V1.5 + Domain Core V2 ») |
| Fusion PR #1 (pack preprod docs) | `b9c948e` |
| Fusion PR #2 (V1.5 sécurité/hygiène) | `d233596` |
| Fusion PR #8 (token GitHub privé) | `c15cc2c` |
| `fix/lot0-legacy-p0` | `85945d77080319427d43e9f29776cd0ea5140f89` |
| `fix/lot0a-foundation-guards` | `7124df5e6df636f0c5ce0ae1509031cf3148c85c` |
| `docs/preprod-v2-2026-10-03` | `e3e6bda` |
| `cursor/v15-security-hygiene-c229` | `25f3bcc3` |
| `cursor/v15-e2e-safety-net-c229` | `270c11cf` |
| `cursor/v15-data-access-c229` | `92cdc32c` |
| `cursor/v15-tool-runner-c229` | `3fb9acf9` |
| `cursor/v15-coolify-deploy-c229` | `449ad7ee` |
| `cursor/v15-stability-bugs-c229` | `91c13d99` |
| `cursor/v15-git-token-c229` | `46d16ff` |

### Sauvegardes locales créées avant toute modification
Ces refs sont locales (non poussées, ne polluent pas le repository) :

- `refs/qeynox/backup/main-initial` → `c15cc2c`
- `refs/qeynox/backup/fix-lot0-legacy-p0` → `85945d7`
- `refs/qeynox/backup/fix-lot0a-foundation-guards` → `7124df5`

### État du workspace au départ
`git status` propre (aucune modification locale non committée). Les éléments générés/runtime présents sur disque et **non versionnés** (donc non réintégrés) : `__pycache__/`, `graphify-out/`, `logs/`, `web/missions.json`, `.venv/`, `.pg-tmp/`. `graphify-out/*` et `stacks/registry.json` avaient déjà été retirés de `main` avant la mission et n'ont pas été réintroduits.

---

## 3. Branches examinées

| Branche | Commits d'avance sur la base | Contenu | Décision |
|---|---|---|---|
| `main` (`c15cc2c`) | — | V1.5 complet (PR #2→#8) + pack docs prétprod | Base de la consolidation |
| `fix/lot0a-foundation-guards` (`7124df5`) | 6 (base `b9c948e`) : `8857b25`, `2c605eb`, `d5f0a45`, `4755988`, `8c9501e`, `7124df5` | Correctifs legacy P0 + hygiène + sécurité credentials + cwd web | **Intégrée** (fusion 1) |
| `fix/lot0-legacy-p0` (`85945d7`) | 8 (base `b9c948e`) : `062148e` → `85945d7` | Domain Core V2, providers, artefacts immuables, PostgreSQL, Hatchet, tests P0/V2, secret guard | **Intégrée** (fusion 2) |
| `docs/preprod-v2-2026-10-03` (`e3e6bda`) | 28 commits docs, base `c0bdfe1` | Pack architecture V2 (docs, ADR, specs, schemas, env) | **Déjà intégré via PR #1** (squash `b9c948e`) : diff d'arbre vérifié identique ; seule différence = `docs/runbooks/COOLIFY-DEPLOY.md` ajouté plus tard sur main |
| `cursor/v15-security-hygiene-c229` | déjà fusionnée (PR #2) | — | Rien à récupérer |
| `cursor/v15-e2e-safety-net-c229` | déjà fusionnée (PR #3, code dans main) | — | PR clôturée superseded |
| `cursor/v15-data-access-c229` | déjà fusionnée (PR #4, code dans main) | — | PR clôturée superseded |
| `cursor/v15-tool-runner-c229` | déjà fusionnée (PR #5, code dans main) | — | PR clôturée superseded |
| `cursor/v15-coolify-deploy-c229` | déjà fusionnée (PR #6, code dans main) | — | PR clôturée superseded |
| `cursor/v15-stability-bugs-c229` | déjà fusionnée (PR #7, code dans main) | — | PR clôturée superseded |
| `cursor/v15-git-token-c229` | déjà fusionnée (PR #8) | — | Rien à récupérer |

### Doublons identifiés
- `top_keyword_rows` (colonne `kw`) : correctif lot0 déjà présent dans `engine/repository.py` via PR #7 → pas de duplication, la version V1.5 a été conservée.
- `upsert_keywords` : trois variantes de SQL existaient (legacy `gtm_store`, lot0a, lot0). Une **seule** implémentation consolidée subsiste dans `engine/repository.py` ; `tools/gtm_store.py` reste une façade.
- `redact_git_text` / `redact_git_url` / `scrub_git_credentials` / `redact_source` : quatre helpers équivalents ont été réunis en `engine/repo_scan.redact_git_url` + `scrub_git_credentials` (URL-aware, corrige au passage une regex erronée `\\s`/`\\1` présente sur la branche).
- `_safe_extract_zip` de lot0 : redondant avec `engine/safety.safe_extract_zip` (plus strict : symlinks, tailles, traversée) → version V1.5 conservée.
- `normalize_slug` / `contained` / `resolve_under` / `bind_address` (lot0) : redondants avec `safe_slug` / `safe_join` / `bind_host` de `engine/safety.py` (realpath) → version V1.5 conservée.

---

## 4. Modifications récupérées lors de la consolidation

### Depuis `fix/lot0a-foundation-guards`
- `engine/loops.py` : re-scan déclenché sur changement réel de la source distante (fingerprint), correction du comptage/métadonnées des mots-clés.
- `engine/pipeline.py` : `redact_source` sur les sources persistées (registre, analyse).
- `engine/repo_scan.py` : masquage des credentials dans les erreurs de clone/source.
- `engine/repository.py` : rafraîchissement `source`/`intent`/`parent` lors d'un upsert de mot-clé, sans écraser par des valeurs vides ou `?`.
- `web/app.py` : exécution des missions depuis `stacks/<slug>` (isolation cwd) et validation de slug.
- `.gitignore` : données tenant/runtime et artefacts générés.

### Depuis `fix/lot0-legacy-p0`
- `core/domain/model.py` (342 l.), `core/domain/__init__.py` : modèle métier V2 (organisations, projets, contextes, job specs/runs, artefacts, feedback, approvals, capabilities/providers).
- `core/application/service.py` (451 l.), `providers.py` (98 l.), `orchestration.py` (50 l.) : services applicatifs, résolution capability→provider, orchestration.
- `core/ports/` : ports repository/orchestration.
- `core/postgres/repository.py` (512 l.), `migrate.py` (61 l.) : repository PostgreSQL et migration runner.
- `core/migrations/001..004` (4 fichiers SQL, 261 l.) : schéma domaine, versions d'artefacts, runtime job, résolution providers.
- `core/hatchet/adapter.py` (343 l.) : adaptateur d'orchestration durable Hatchet.
- `scripts/secret_guard.py` : scan de secrets sur les fichiers suivis.
- `tests/test_lot0_p0.py` (432 l., adapté), `tests/test_repo_safety.py` (70 l.), `tests/test_v2_*.py` (~1500 l.).
- `requirements-core.txt` : psycopg, pydantic, hatchet-sdk.
- `.github/workflows/ci.yml` : job V2 avec PostgreSQL 16 (fusionné avec le job lint/test V1.5).

### Points de résolution significatifs
- `run_program(slug, prog, programs)` évite le rechargement/écrasement de `programs.json` pendant un cycle (bug de la branche legacy).
- `source_fingerprint` : ordre de résolution `FETCH_HEAD` → `origin/HEAD` → `origin/main` → `origin/master` → `HEAD`, candidats multiples (`stack/repo/repo`, `stack/repo`, source locale) et fallback mtime — le tout à travers `engine.runner` (seam unique V1.5, pas de `sqlite3`/`subprocess` direct).
- `web/app.py` : auth, loopback par défaut, `safe_join`, SSRF et allowlist git de V1.5 conservés ; cwd de mission et `GTM_BRAND`/`GTM_DOMAIN` récupérés de V2.
- `create_stack` : refuse désormais les URL git contenant des credentials (politique V1.5) ; l'ancien test de simple masquage a été remplacé par un test de refus + non-persistance.

---

## 5. Pull Requests traitées individuellement

| PR | Titre | État GitHub avant | Action | Justification |
|---|---|---|---|---|
| #1 | docs: preprod architecture pack | MERGED | Rien à faire | Contenu déjà dans `main` (`b9c948e`) |
| #2 | fix: V1.5 security and repo hygiene | MERGED | Rien à faire | Fusionnée (`d233596`) |
| #3 | test: V1.5 end-to-end safety net | OPEN | **Clôturée superseded** | Tête `270c11cf` déjà ancêtre de `main` (`c15cc2c`) |
| #4 | refactor: single SQLite repository | OPEN | **Clôturée superseded** | Tête `92cdc32c` déjà ancêtre de `main` |
| #5 | refactor: single tool runner | OPEN | **Clôturée superseded** | Tête `3fb9acf9` déjà ancêtre de `main` |
| #6 | feat: Coolify Docker Compose | OPEN | **Clôturée superseded** | Tête `449ad7ee` déjà ancêtre de `main` |
| #7 | fix: V1 stability bugs | OPEN | **Clôturée superseded** | Tête `91c13d99` déjà ancêtre de `main` |
| #8 | feat: GitHub token clone auth | MERGED | Rien à faire | Fusionnée (`c15cc2c`) |
| **#9** | **consolidation: V1.5 + Domain Core V2 → main** | — | **Créée puis fusionnée** | Merge commit `7aaa3c1` |
| #10 | docs: rapport final de consolidation | — | Créée et fusionnée immédiatement après ce rapport | Documentation seule (aucun changement source) |

Preuve d'ascendance utilisée pour #3→#7 : `git merge-base --is-ancestor <tête> c15cc2c` → code de sortie 0. Aucune branche `cursor/*` supprimée ; l'historique et les commentaires restent consultables.

---

## 6. Fonctionnalités V1 conservées

- Serveur web stdlib, UI statique, endpoints `/api/*` avec jeton optionnel (`QEYNOX_API_TOKEN` / `GTM_HOOK_TOKEN`), loopback par défaut, refus de bind public sans jeton.
- Chemins runtime pilotés par `QEYNOX_ROOT` / `QEYNOX_STACKS_DIR` / `QEYNOX_LOGS_DIR` / `QEYNOX_MISSIONS_FILE` (volume `/data` du conteneur).
- Runner d'outils unique (`engine/runner.py`) : argv construits, timeouts, journalisation, scrubbing des secrets, `ToolResult`.
- Repository SQLite unique (`engine/repository.py`) : aucune connexion sqlite3 hors de ce module (test dédié).
- Sécurité : `validate_git_url` (http(s)/`git@`), `safe_extract_zip`, `safe_join`/`safe_slug`, `validate_public_http_url` (SSRF), redaction des credentials, auth par jeton.
- Dossiers GTM versionnés et immuables (`dossier/versions/gtm-dossier-vNNNN.*`, `latest.json`), pipeline d'onboarding et registre des stacks.
- Boucles heartbeat/rescan/retry avec kill switch, plafonds, pulse de santé.
- Déploiement Coolify : `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, runbook.
- Tests V1/V1.5 existants conservés et verts.

## 7. Fonctionnalités V2 intégrées

- **Domain Core V2** (`core/domain`) : modèle métier complet et validations.
- **Application** (`core/application`) : `CoreService`, résolution capability→provider, orchestration de jobs.
- **Ports** (`core/ports`) : abstractions repository/orchestration.
- **PostgreSQL** (`core/postgres`, `core/migrations`) : repository, runner de migrations idempotent, contraintes FK, index, isolation multi-tenant.
- **Artefacts immuables** : versions, régénération, lignée, approvals, feedback.
- **Providers** : catalogue de capacités/providers, bindings, santé/priorité/repli.
- **Adaptateur Hatchet** (`core/hatchet/adapter.py`) : lancement, worker, retry, timeout, reprise.
- **Tests V2** : domaine, application, artefacts, providers, PostgreSQL, Hatchet.
- **Secret guard** (`scripts/secret_guard.py`) et durcissement CI (Python 3.12, job PostgreSQL 16).

---

## 8. Certifications locales

Environnement : Windows, Python **3.12.4**, venv `.venv` isolé, pytest 9.2.0, ruff 0.17.4, psycopg 3.3.8, pydantic 2.14.3, hatchet-sdk 1.45.1.

| Contrôle | Commande | Résultat |
|---|---|---|
| Syntaxe (compileall) | `python -m compileall -q engine tools web scripts core mcp_server.py qeynox.py` | **PASS** (exit 0) |
| Ruff | `ruff check .` | **PASS** (0 finding) |
| Pytest (V1 + V1.5 + V2 non-DB) | `pytest -q -p no:cacheprovider` | **PASS : 80 passed, 11 skipped, 0 failed, 0 error** |
| Unittest (classes V2) | `python -m unittest discover -s tests` | **PASS : 46 tests, OK, 4 skipped** |
| Tests de sécurité (bind, jeton, SSRF, zip-slip, traversée, git allowlist, token GitHub) | inclus dans pytest | **PASS** |
| Tests isolation multi-tenant / immutabilité / providers (niveau domaine & mémoire) | inclus dans pytest | **PASS** |
| Secret guard | `python scripts/secret_guard.py` | **PASS** (120 fichiers suivis, aucun secret) |
| Import smoke V1+V2 | import de `web.app`, `engine.*`, `mcp_server`, `core.*` | **PASS** |
| Tests PostgreSQL (FK, isolation, migration, artefacts/providers/hatchet DB) | `pytest` avec `QEYNOX_TEST_DATABASE_URL` | **NOT_RUN localement** — 11 tests explicitement `SKIPPED` |
| Tests Hatchet runtime (worker/retry/reprise DB) | idem | **NOT_RUN localement** (dépend de PostgreSQL) ; transitions domaine testées et **PASS** |
| Docker / PostgreSQL local | `docker info`, `initdb` | **NOT_RUN** — daemon Docker inaccessible (pipe nommé indisponible derrière le bac à sable) et `initdb` bloqué par l'interdiction des stdio pipés du bac à sable |
| GitHub Actions | workflow `ci` | **NOT_RUN** — runs en échec immédiat avec annotation GitHub : « The job was not started because your account is locked due to a billing issue ». Non utilisé comme preuve. |

Détail des 11 skips (tous la même cause : `QEYNOX_TEST_DATABASE_URL` absent) :
`PostgresCoreTests` (6), `ArtifactPostgresTests` (1), `ProviderPostgresTests` (1), `HatchetRuntimeTests` (3).
Le workflow CI consolidé fournit un service `postgres:16` et l'URL correspondante : ces tests s'exécuteront en CI dès que la facturation GitHub sera rétablie.

Tests non exécutés ⇒ **jamais annoncés PASS**.

---

## 9. Limitations restantes

1. **PostgreSQL non exécuté localement** : aucun serveur PostgreSQL disponible dans l'environnement de certification (Docker daemon inaccessible, PostgreSQL embarqué bloqué par le bac à sable). Les tests sont prêts et explicitement skippés ; la CI les exécute via le service `postgres:16`.
2. **GitHub Actions bloquées** : facturation du compte (annotation officielle du run). La certification repose uniquement sur les contrôles locaux ci-dessus.
3. **V2 non branché au runtime web V1** : `core/` est un contexte borné parallèle, conformément à `docs/04-MIGRATION-V1-V2.md` / ADR ; aucune bascule destructive n'a été faite (hors périmètre de la consolidation).
4. **Hatchet SDK** : dépendance d'orchestration lourde ; l'adaptateur échoue volontairement à l'import avec un message explicite si le SDK est absent. Les tests d'intégration Hatchet nécessitent PostgreSQL (skippés localement).
5. **Fingerprint de re-scan** : en environnement sans accès réseau au remote, `FETCH_HEAD` peut rester celui du dernier fetch réussi ; comportement conservateur (pas de faux re-scan).
6. **Artefacts locaux** : le venv de certification (`.venv/`), les caches et le répertoire `.pg-tmp/` sont gitignorés et absents de `main`.

---

## 10. Contrôles d'intégrité finaux

- `git diff --diff-filter=D --name-only c15cc2c..7aaa3c1` → **aucun fichier supprimé** par la consolidation.
- `git diff --stat c15cc2c..7aaa3c1` → 44 fichiers modifiés/ajoutés, +5074 / −75 (le code V1.5 existant est modifié de façon additive, hors corrections ciblées).
- Branches distantes : **aucune suppression**, aucun force-push (`git push` en fast-forward uniquement).
- Secrets : `secret_guard` PASS, `.gitignore` couvre `.env`, keys, DB, stacks, logs, artefacts générés.
- Livraison : l'archive ZIP de `main` est produite via `git archive` (fichiers suivis uniquement, hors secrets et artefacts générés), jointe à la livraison.

---

## 11. Verdict

**GO** — consolidation réussie : `main` contient l'intégralité du travail V1.5 et V2 compatible, aucun développement utile oublié sur une branche, aucune PR ouverte non traitée, aucun faux résultat de validation. Les seuls contrôles non exécutés (PostgreSQL, Hatchet DB, GitHub Actions) sont explicitement documentés et outillés pour la CI.
