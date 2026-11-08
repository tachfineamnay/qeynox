# QeyNox — Contrat BETA50

**Version :** 1 — **Date :** 2026-11-08
**Contrat machine :** [`BETA50_CONTRACT.json`](BETA50_CONTRACT.json) (source de vérité, vérifiée par `tests/test_beta50_contract.py`)
**Plan d'acceptation :** [`BETA50_ACCEPTANCE.md`](BETA50_ACCEPTANCE.md)

---

## 1. Objet

BETA50 est la **première bêta auto-hébergée utilisable** de QeyNox. Elle expose le runtime V1.5
(onboarding d'un dépôt, research, dossier GTM, validation humaine, swarm de missions, boucles,
MCP, UI web) et garde le **Domain Core V2 comme bibliothèque interne** : présent, testé, versionné,
mais **non exposé** par une surface produit.

Ce contrat définit ce qui est livré, ce qui ne l'est pas, les flags qui changent le comportement,
et les contradictions interface/API/flags qui ont été corrigées pour rendre la bêta utilisable.

> Règle : **aucune fonctionnalité annoncée n'est absente du code** ; inversement, une capacité
> interne (V2) n'est pas promise à l'utilisateur BETA50.

## 2. Positionnement et périmètre

| Dimension | BETA50 |
|---|---|
| Utilisateur | un opérateur/admin unique, en local ou sur un VPS dédié |
| Tenancy | **mono-tenant** : N stacks/produits, pas d'organisations ni de rôles |
| Stockage | SQLite par stack (`stacks/<slug>/data/gtm.db`) + fichiers JSON versionnés |
| Réseau | sorties limitées aux recherches web publiques ; **aucun appel LLM par défaut** |
| Déploiement | `docker compose` (web + loops + SearXNG optionnel) ou exécution locale |
| V2 | `core/` interne (domaine, providers, PostgreSQL, Hatchet) — **hors surfaces BETA50** |

### 2.1 Dans le périmètre (IN)

- **F01** Onboarding d'un dépôt par chemin local, URL git (`https://`, `git@`) ou archive `.zip`.
- **F02** Pipeline déterministe 8 étapes : clone → scan → keywords → signals → competitors → aeo
  → synthèse (skippable) → dossier.
- **F03** Dossier GTM markdown **versionné et immuable** (`dossier/versions/`, pointeur `latest.json`).
- **F04** Validation humaine du dossier → workspace `swarm/` (`BUSINESS.md`, `personas.md`,
  `keywords-seeds.json`, `missions-suggested.json`), statut du stack `active`.
- **F05** Missions : `keywords`, `social`, `competitors`, `serp`, `trends` avec logs en direct.
- **F06** UI web 9 vues (Stacks, Tableau de bord, Mots-clés, Signaux, Concurrents, SERP, Missions,
  Rapports, Agents).
- **F07** Rapports : livrables par stack **et** vue flotte, lecteur markdown/CSV, export CSV des mots-clés.
- **F08** Boucles : heartbeat, re-scan sur changement de la source distante, retry avec plafond,
  kill switch global.
- **F09** MCP : 10 outils (lecture + `launch_tool` + `propose_decision`).
- **F10** Catalogue de bras : `qeynox.py arms list|get|add|enable|disable`.
- **F11** Garde-fous : bind loopback par défaut, jeton API, allowlist git, anti zip-slip,
  anti SSRF, redaction des credentials, secret guard.
- **F12** Déploiement : image non-root, volume `/data`, second service de boucles, runbook Coolify.
- **F13** Souveraineté : `QEYNOX_LLM=none` par défaut ; mode `QEYNOX_OFFLINE_SEARCH=1` pour démos/CI.
- **F14** *(interne)* Domain Core V2 : domaine, application, providers, artefacts immuables,
  repository PostgreSQL, adaptateur Hatchet, tests V2.

### 2.2 Hors périmètre (OUT) — non promis en BETA50

- Surfaces produit V2 : projets, JobSpec/JobRun, versions d'Artifact, Regenerate, Approve,
  ExecutionSpec/ExecutionRun, Evidence/Outcome.
- PostgreSQL comme source de vérité du runtime BETA50.
- Activation du runtime durable **Hatchet** (l'adaptateur est interne et testé).
- Multi-tenant (organisations, rôles, quotas), billing, analytics, OpenTelemetry/Langfuse.
- FastAPI / refonte du serveur web.
- Exécution Hermes par job : `HERMES_API_URL` / `HERMES_API_KEY` sont **réservés et inertes**.
- `plan.json` d'actions typées et exécution du plan.

## 3. Surfaces et points d'entrée

| Surface | Entrée | Public |
|---|---|---|
| Web | `python qeynox.py serve` → `http://127.0.0.1:8765` | admin |
| CLI | `python qeynox.py serve|onboard|status|validate|arms …` | opérateur |
| API | `http://127.0.0.1:8765/api/*` (jeton si configuré) | UI, intégrations locales |
| MCP | `python mcp_server.py` (stdio JSON-RPC) | clients IA locaux |
| Boucles | `python engine/loops.py --daemon` | scheduler interne |
| Déploiement | `docker compose up -d --build` | hébergement |

### 3.1 Matrice API

`auth = token` signifie : ouvert sur loopback **sans jeton configuré**, sinon `Authorization: Bearer`,
`X-Qeynox-Token` ou `X-Lumira-Token`. `/api/health` reste toujours ouvert.

| Méthode | Chemin | Auth | Usage |
|---|---|---|---|
| GET | `/api/health` | public | liveness + disponibilité SearXNG |
| GET | `/api/state` | token | KPI, runs récents, agents |
| GET | `/api/stacks` | token | registre + pipeline + dossier_data |
| GET | `/api/stacks/{slug}/pipeline` | token | étapes du pipeline |
| GET | `/api/stacks/{slug}/dossier` | token | dernier dossier markdown |
| GET | `/api/stacks/{slug}/context` | token | analyse statique |
| GET | `/api/keywords` | token | mots-clés (filtres `intent`, `q`) |
| GET | `/api/signals` | token | signaux SQLite |
| GET | `/api/serp` | token | positions SERP |
| GET | `/api/competitors` | token | snapshots concurrents |
| GET | `/api/missions` | token | missions **flotte entière** + types |
| GET | `/api/missions/{id}/log` | token | log de mission |
| GET | `/api/reports` | token | livrables du stack sélectionné ou de la flotte |
| GET | `/api/report` | token | contenu d'un livrable (`path`) |
| GET | `/api/export/keywords.csv` | token | export CSV |
| POST | `/api/stacks` | token | créer un stack + lancer le pipeline |
| POST | `/api/stacks/{slug}/validate` | token | valider le dossier → swarm |
| POST | `/api/missions` | token | lancer une mission |
| POST | `/api/hooks/agent` | token | dépôt d'un livrable par un agent externe |

### 3.2 Matrice UI

| Vue | Contenu | Endpoints |
|---|---|---|
| Stacks | onboarding, pipeline, dossier, validation | `/api/stacks`, `/api/stacks/{slug}/*`, `POST /api/stacks` |
| Tableau de bord | KPI, missions, activité | `/api/state`, `/api/missions`, `/api/stacks` |
| Mots-clés | table, filtres intent, export | `/api/keywords`, `/api/export/keywords.csv` |
| Signaux | verbatims scorés | `/api/signals` |
| Concurrents | snapshots + versions | `/api/competitors` |
| SERP | positions par requête | `/api/serp` |
| Missions | lancement, logs live | `/api/missions`, `/api/missions/{id}/log` |
| Rapports | livrables markdown/CSV | `/api/reports`, `/api/report` |
| Agents | flotte, rôles | `/api/state` |

**Règle de navigation** : toutes les URLs de l'UI sont construites par `apiPath(path, params)`
dans `web/static/app.js`. Aucune concaténation `?stack=` manuelle, y compris **sans stack sélectionné**.

## 4. Feature flags (matrice)

La matrice complète, avec défauts, valeurs et effets, est dans
[`BETA50_CONTRACT.json`](BETA50_CONTRACT.json) (`flags`, `test_flags`, `reserved_flags`) et vérifiée
par les tests (union exacte avec les variables lues par le code).

### 4.1 Flags opérateur

| Flag | Défaut | Effet |
|---|---|---|
| `QEYNOX_BIND` | `127.0.0.1` | écoute ; hors loopback exige un jeton (fail closed) |
| `QEYNOX_API_TOKEN` | *(vide)* | jeton sur `/api/*` sauf `/api/health` |
| `GTM_HOOK_TOKEN` | *(vide)* | ancien nom de jeton, encore accepté |
| `GTM_WEB_PORT` | `8765` | port HTTP |
| `QEYNOX_ROOT` | racine du dépôt | racine code si le process démarre ailleurs |
| `QEYNOX_STACKS_DIR` / `QEYNOX_LOGS_DIR` / `QEYNOX_MISSIONS_FILE` | `<root>/*` | chemins du volume tenant |
| `QEYNOX_LLM` | **`none`** | `none` = aucun appel LLM ; `auto`/`ollama`/`openai` activent la synthèse |
| `QEYNOX_LLM_MODEL` | *(vide)* | modèle de synthèse |
| `QEYNOX_OLLAMA_URL` / `QEYNOX_LLM_BASEURL` / `QEYNOX_LLM_API_KEY` | défauts locaux / vide | cibles LLM |
| `QEYNOX_GIT_TOKEN` | *(vide)* | PAT GitHub lecture seule pour dépôts privés |
| `SEARXNG_URL` | `http://127.0.0.1:8888` | moteur prioritaire, sinon Bing/DDG |
| `GTM_LANG` / `GTM_GL` | `fr` / `FR` | langue/pays de recherche |
| `QEYNOX_OFFLINE_SEARCH` | *(vide)* | mode démo/CI : résultats de recherche déterministes |

### 4.2 Flags internes (injectés par le runtime, non destinés à l'opérateur)

`GTM_DB`, `GTM_BRAND`, `GTM_BRAND_ALIASES`, `GTM_DOMAIN` — positionnés par le serveur pour chaque
mission. `QEYNOX_TEST_DATABASE_URL` est réservé aux tests PostgreSQL V2 (internes).

### 4.3 Flags réservés (inertes en BETA50)

`HERMES_API_URL`, `HERMES_API_KEY` : présents dans `tools/config.example.env` pour la cible V2
(lot exécution Hermes), **aucun code ne les lit**.

## 5. Sécurité, données et exploitation

- **Bind** : loopback par défaut. Hors loopback sans jeton → le processus refuse de démarrer.
- **Clones** : seuls `http(s)` et `git@hôte:chemin` sont acceptés ; credentials embarqués refusés ;
  token GitHub transmis hors URL/argv/logs et redacté.
- **Archives** : zip-slip et symlinks refusés, limites de taille.
- **SSRF** : URL de site contrôlée (pas de loopback/lien-local/réseau privé).
- **Données** : `stacks/`, `logs/`, DB, `missions.json`, `catalog/overrides.json` hors git.
- **Backups** : le volume `/data` contient tout l'état tenant (stacks + logs + missions).
- **Observabilité BETA50** : `/api/health`, logs par mission (`logs/mission-*.log`), `logs/tool-runs.jsonl`,
  `stacks/<slug>/pipeline.json`, `stacks/<slug>/loop_state.json`.

## 6. Contradictions identifiées et traitées

| ID | Contradiction | Statut | Résolution |
|---|---|---|---|
| C1 | `QEYNOX_LLM` défaut code `auto` vs docs/compose `none` | **fixed** | défaut code `none`, valeurs inconnues → `none` |
| C2 | Vue Rapports d'un stack vide (seul `output/` scanné) | **fixed** | racine `stacks/<slug>` (dossier, research, output, swarm) |
| C3 | Rapports flotte : chemins relatifs au dépôt, lecteur relatif à `stacks/` → 404 | **fixed** | chemins relatifs à la racine affichée, liste = lecteur |
| C4 | URLs UI malformées sans stack (`/api/keywords&intent=…`) | **fixed** | helper `apiPath()` ; test statique de non-régression |
| C5 | `GET /api/missions?stack=` ignoré | documenté | contrat : liste flotte-wide ; l'UI n'envoie plus le paramètre |
| C6 | README « V2.1 non implémentée » alors que `core/` existe | **fixed** | README + contrat distinguent interne vs exposé |
| C7 | Flags lus mais non documentés (`QEYNOX_ROOT`, `QEYNOX_OFFLINE_SEARCH`, `GTM_*`) | **fixed** | `.env.example` + matrice du contrat |
| C8 | `HERMES_*` présentés comme configurables | **fixed** | marqués réservés/inertes |
| C9 | Vue Signaux vide après onboarding malgré des verbatims au dossier | documenté | flux assumé : `research/signals.json` → dossier ; table SQLite ← mission « Scan signaux sociaux » |
| C10 | CLI `engine/loops.py --status` silencieuse sans tenant | **fixed** | message explicite « Aucun stack suivi » + test dédié |

Aucune contradiction BETA50 ne reste au statut `open` (vérifié par test).

## 7. Critères d'acceptation

1. `python -m compileall -q engine tools web scripts core mcp_server.py qeynox.py` → PASS
2. `python -m ruff check .` → PASS
3. `python -m pytest -q` → PASS (les tests PostgreSQL V2 restent `SKIPPED` sans base, jamais PASS)
4. `node --check web/static/app.js` → PASS
5. `python scripts/secret_guard.py` → PASS
6. `python -m pytest -q tests/test_beta50_contract.py -v` → PASS : contrat JSON ↔ code/UI/flags/MCP,
   parcours HTTP de bout en bout, rapports stack et flotte, flags LLM.
7. Aucune contradiction `open` dans le contrat.

Résultats détaillés et limites : [`BETA50_ACCEPTANCE.md`](BETA50_ACCEPTANCE.md).

## 8. Sortie de bêta (après BETA50)

Le passage à la suite (préprod V2) suppose : surfaces produit V2 exposées (projets, jobs, artefacts,
approvals, exécution), PostgreSQL source de vérité, Hatchet activé, multi-tenant, observabilité.
Ces lots sont décrits dans `docs/05-IMPLEMENTATION-ROADMAP.md` et restent **hors BETA50**.
