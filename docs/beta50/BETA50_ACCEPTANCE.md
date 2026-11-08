# BETA50 — Plan et résultats d'acceptation

**Date :** 2026-11-08 · **Contrat :** [`BETA50_CONTRACT.md`](BETA50_CONTRACT.md) / [`BETA50_CONTRACT.json`](BETA50_CONTRACT.json)
**Base git :** `main` local à `ec6af82` + commits BETA50 locaux (voir `git log`).

---

## 1. Environnement de certification

| Élément | Valeur |
|---|---|
| OS | Windows (session de développement) |
| Python | **3.12.4** (venv `.venv`) |
| pytest | 9.2.0 |
| ruff | 0.17.4 |
| Node.js | v24.21.0 (`node --check` pour `app.js`) |
| Runtime serveur | stdlib `http.server`, SQLite, fichiers JSON |
| PostgreSQL | **absent** (voir §5 NOT_RUN) |
| Docker | CLI présent, **daemon inaccessible** (voir §5 NOT_RUN) |

---

## 2. Commandes et résultats

| # | Commande | Résultat |
|---|---|---|
| 1 | `python -m compileall -q engine tools web scripts core mcp_server.py qeynox.py` | **PASS** (exit 0) |
| 2 | `python -m ruff check .` | **PASS** — 0 finding |
| 3 | `python -m pytest -q` | **PASS — 91 passed, 11 skipped, 0 failed** |
| 4 | `python -m pytest -q tests/test_beta50_contract.py -v` | **PASS — 11/11** |
| 5 | `node --check web/static/app.js` | **PASS** |
| 6 | `python scripts/secret_guard.py` | **PASS** — 121 fichiers suivis, aucun secret |
| 7 | `python qeynox.py status` (tenant vide) | **PASS** — message explicite |
| 8 | `python qeynox.py arms list` | **PASS** — catalogue affiché |
| 9 | `python engine/loops.py --status` (tenant vide) | **PASS** — « Aucun stack suivi » (corrigé C10) |
| 10 | MCP `initialize` + `tools/list` | **PASS** — 10 outils déclarés |

Les 11 tests `SKIPPED` sont exclusivement les tests **PostgreSQL internes V2**
(`PostgresCoreTests` 6, `ArtifactPostgresTests` 1, `ProviderPostgresTests` 1,
`HatchetRuntimeTests` 3) qui exigent `QEYNOX_TEST_DATABASE_URL`. Ils ne sont **pas** annoncés PASS.

---

## 3. Couverture du contrat BETA50 (`tests/test_beta50_contract.py`)

| Test | Ce qu'il garantit |
|---|---|
| `test_contract_declares_expected_milestone_and_no_open_contradiction` | milestone/version, aucune contradiction `open` |
| `test_contract_features_evidence_exists` | chaque feature IN/interne pointe vers des fichiers réels |
| `test_flags_match_code_and_env_example` | **union exacte** flags contrat ↔ variables lues par le code ; flags opérateur présents dans `.env.example` ; `HERMES_*` réservés et inertes |
| `test_ui_api_paths_are_contractual_and_well_formed` | chaque endpoint utilisé par l'UI est dans la matrice API ; helper `apiPath()` ; plus aucun `qs()` + `&` (C4) |
| `test_mcp_tools_are_contractual` | les 10 outils MCP annoncés existent |
| `test_acceptance_commands_are_declared` | les commandes d'acceptation sont bien déclarées |
| `test_beta50_boot_and_core_views` | santé, stacks, état, mots-clés filtres, signaux, concurrents, SERP, missions, export CSV |
| `test_beta50_reports_cover_dossier_research_and_swarm` | **C2/C3** : dossier, `research/keywords.csv`, `swarm/*.md`, `output/agent-*.md` listés **et** lisibles, en vue stack **et** en vue flotte |
| `test_beta50_mission_launch_and_hook` | mission outillée → `done`, log accessible, validation d'erreur 400 |
| `test_beta50_llm_default_is_none` | **C1** : sans `QEYNOX_LLM`, aucun fournisseur LLM n'est contacté |
| `test_loops_status_is_explicit_without_tenant` | **C10** : CLI explicite sans tenant |

Le parcours HTTP est exécuté sur le **vrai serveur embarqué** (`web.app.Handler`) avec un
pipeline d'onboarding réel en mode offline : `create_stack` → 8 étapes → dossier versionné →
rapports → validation → swarm → mission → hook agent.

---

## 4. Contradictions interface / API / flags — avant / après

Reproduites par probe HTTP réel avant correction, puis couvertes par tests après correction :

| ID | Symptôme observé avant | Statut | Preuve après |
|---|---|---|---|
| C1 | sans `QEYNOX_LLM`, `auto` tentait Ollama/OpenAI | **fixed** | test `llm_default_is_none` |
| C2 | `GET /api/reports?stack=…` → `{"rows": []}` alors que le dossier existe | **fixed** | test rapports : `dossier/*.md` listé + lisible |
| C3 | `GET /api/reports` (flotte) → chemins `…\stacks\slug\…` puis `GET /api/report` → **404** | **fixed** | test flotte : chemins relatifs lisibles |
| C4 | `GET /api/keywords&intent=…` et `/api/report&path=…` → **404** sans stack | **fixed** | test statique : `apiPath()` et zéro `qs()&` |
| C5 | `?stack=` ignoré par `GET /api/missions` | documenté | contrat : liste flotte-wide, UI alignée |
| C6 | README « V2.1 non implémentée » | **fixed** | README + contrat |
| C7 | flags lus non documentés | **fixed** | test flags |
| C8 | `HERMES_*` présentés comme actifs | **fixed** | flags réservés + test |
| C9 | page Signaux vide après onboarding | documenté | flux de données assumé |
| C10 | `loops --status` silencieux sans tenant | **fixed** | test dédié |

**Aucune contradiction BETA50 ne reste `open`.**

---

## 5. Non exécuté (NOT_RUN) — déclaré, jamais transformé en PASS

| Contrôle | Raison |
|---|---|
| Tests PostgreSQL internes V2 (11) | Pas de base PostgreSQL dans l'environnement de certification ; la CI fournit un service `postgres:16` + `QEYNOX_TEST_DATABASE_URL`. Tests **SKIPPED** explicites. |
| Tests d'intégration Hatchet runtime | Dépendent de PostgreSQL (juste au-dessus). Les transitions domaine sont testées et PASS. |
| `docker compose build/up` | Daemon Docker Desktop non joignable (`//./pipe/dockerDesktopLinuxEngine` introuvable) ; aucun conteneur lancé, aucun déploiement. |
| GitHub Actions | Compte verrouillé pour facturation (annotation officielle du run) ; la certification BETA50 repose sur les contrôles locaux ci-dessus. |
| Coolify / VPS | Hors périmètre local ; runbook présent (`docs/runbooks/COOLIFY-DEPLOY.md`). |

---

## 6. Limites connues acceptées en BETA50

1. **Mono-tenant local** : pas d'organisations, pas de rôles, pas de quotas par utilisateur.
2. **Signaux** : la vue Signaux lit la table SQLite ; les verbatims de l'onboarding restent dans le dossier jusqu'à une mission « Scan signaux sociaux » (C9).
3. **SearXNG optionnel** : sans SearXNG, la research retombe sur Bing/DDG ; `serp_rank` et `social_pulse` peuvent être dégradés hors SearXNG.
4. **V2 interne** : `core/` n'a pas de surface produit en BETA50 ; aucun basculement de stockage ou d'orchestration.
5. **Synthèse IA** désactivée par défaut (`QEYNOX_LLM=none`) : le dossier reste 100 % déterministe.
6. **Jeton UI** conservé en `sessionStorage` (perdu à la fermeture de session navigateur).

---

## 7. Verdict

**BETA50 : GO** — le socle est utilisable de bout en bout en local, les contradictions bloquantes
sont corrigées et testées, les flags et surfaces sont contractualisés, et les contrôles non
exécutables sont explicitement documentés.

Reproduction :

```bash
python -m pytest -q tests/test_beta50_contract.py -v   # contrat
python -m pytest -q                                   # suite complète
python -m ruff check . && node --check web/static/app.js && python scripts/secret_guard.py
```
