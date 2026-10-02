# Graph Report - QeyNox  (2026-10-02)

## Corpus Check
- 28 files · ~30,567 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 329 nodes · 741 edges · 15 communities (14 shown, 1 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- gtm_store.py
- app.js
- pipeline.py
- arms.py
- loops.py
- QeyNox — PRD V1
- research.py
- mcp_server.py
- app.py
- repo_scan.py
- 2. Les 7 oublis qui tuent — par ordre de priorité absolue
- 🕵️ Insider — Ce que QeyNox est VRAIMENT (et ce que vous n'en voyez pas)
- dossier.py
- _TextExtractor

## God Nodes (most connected - your core abstractions)
1. `esc()` - 19 edges
2. `api()` - 18 edges
3. `connect()` - 15 edges
4. `log_run()` - 15 edges
5. `run_pipeline()` - 14 edges
6. `renderDashboard()` - 13 edges
7. `run_program()` - 12 edges
8. `cycle()` - 12 edges
9. `render()` - 12 edges
10. `skeleton()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `searxng_available()` --calls--> `searxng_url()`  [INFERRED]
  engine/research.py → tools/gtm_common.py
- `_search()` --calls--> `searx_search()`  [INFERRED]
  engine/research.py → tools/gtm_common.py
- `stage_signals()` --calls--> `domain_of()`  [INFERRED]
  engine/research.py → tools/gtm_common.py
- `stage_competitors()` --calls--> `domain_of()`  [INFERRED]
  engine/research.py → tools/gtm_common.py
- `stage_competitors()` --calls--> `fetch_text()`  [INFERRED]
  engine/research.py → tools/gtm_common.py

## Import Cycles
- None detected.

## Communities (15 total, 1 thin omitted)

### Community 0 - "gtm_store.py"
Cohesion: 0.11
Nodes (43): Connection, Row, _from_competitors_json(), _from_targets_file(), load_targets(), main(), autocomplete(), db_path() (+35 more)

### Community 1 - "app.js"
Cohesion: 0.18
Nodes (42): AGENT_META, api(), chipIntent(), debounce(), emptyState(), ensurePoll(), esc(), I (+34 more)

### Community 2 - "pipeline.py"
Cohesion: 0.14
Nodes (30): _load(), validate_stack(), create_stack(), get_stack(), init_pipeline(), load_registry(), now_iso(), pipeline_path() (+22 more)

### Community 3 - "arms.py"
Cohesion: 0.17
Nodes (27): Any, ArgumentParser, add_arm(), build_parser(), cmd_add(), cmd_disable(), cmd_enable(), cmd_get() (+19 more)

### Community 4 - "loops.py"
Cohesion: 0.20
Nodes (25): brand_of(), build_cmd(), cmd_status(), cycle(), db_counts(), default_programs(), health_score(), list_stacks() (+17 more)

### Community 5 - "QeyNox — PRD V1"
Cohesion: 0.09
Nodes (20): 10. Hors V1, 11. Non-négociable, 1. Problème, 2. Produit, 3. Utilisateurs V1, 4. Surfaces, 5. Objets métier, 6. LLM par job (défauts, overridables) (+12 more)

### Community 6 - "research.py"
Cohesion: 0.17
Nodes (19): bing_search(), ddg_search(), _decode_bing_url(), _market_noun(), _q(), Fallback sans SearXNG : résultats HTML Bing (b_algo)., Recherche web : SearXNG si dispo, sinon Bing, sinon DDG., Le « marché » du stack : 1re graine admin si fournie, sinon mots de catégorie. (+11 more)

### Community 7 - "mcp_server.py"
Cohesion: 0.16
Nodes (17): db_rows(), handle(), now_iso(), Lance un outil du swarm en tâche de fond (keywords|social|competitors|serp|trend, Un agent propose une décision → l'admin la retrouve dans les Rapports du stack., read_json(), registry(), serve() (+9 more)

### Community 8 - "app.py"
Cohesion: 0.25
Nodes (10): BaseHTTPRequestHandler, build_args(), db_rows(), db_scalar(), Handler, now_iso(), run_mission(), save_missions() (+2 more)

### Community 9 - "repo_scan.py"
Cohesion: 0.16
Nodes (13): detect_manifests(), is_git_url(), now_iso(), PageParser, parse_html_file(), prepare_repo(), HTMLParser, Analyse statique complète du dépôt. (+5 more)

### Community 10 - "2. Les 7 oublis qui tuent — par ordre de priorité absolue"
Cohesion: 0.12
Nodes (15): 1. État des lieux — ce qui est DÉJÀ prêt (plus que la plupart des projets), 2. Les 7 oublis qui tuent — par ordre de priorité absolue, 3. Le spécifique RaaS — vendre des RÉSULTATS change 3 choses, 4. Ce qu'il ne faut PAS faire maintenant (le piège inverse), 5. Plan « 30 jours → premier euro », 6. Réponse directe à la question, 🚀 Checklist startup — QeyNox en SaaS / RaaS, 🔴 Oubli n°1 — Vous n'avez encore vendu RIEN (le seul qui compte vraiment) (+7 more)

### Community 11 - "🕵️ Insider — Ce que QeyNox est VRAIMENT (et ce que vous n'en voyez pas)"
Cohesion: 0.12
Nodes (15): 1. Le reframe brutal : ce que vous avez construit sans le nommer, 2. Les 10 angles morts du fonctionnement actuel (audit sans pitié), 3. Segments clients pour QeyNox (du plus évident au plus juteux), 4.1 Open core à l'envers (le « engine-first »), 4.2 Le serveur MCP comme produit d'appel, 4.3 « GTM-as-a-Service » (le fulfilment vendu), 4.4 Le registre QeyNox (le jeu de données), 4.5 Le template marketplace (communauté) (+7 more)

### Community 12 - "dossier.py"
Cohesion: 0.39
Nodes (8): _aeo_table(), build_dossier(), build_personas(), _competitor_table(), _kw_table(), _load(), _load_ctx(), Personas heuristiques ancrés dans les données réelles (verbatims + questions).

## Knowledge Gaps
- **49 isolated node(s):** `I`, `AGENT_META`, `STAGE_ICON`, `state`, `VIEWS` (+44 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `searxng_available()` connect `research.py` to `gtm_store.py`, `app.py`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `run_pipeline()` connect `pipeline.py` to `repo_scan.py`, `dossier.py`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `I`, `AGENT_META`, `STAGE_ICON` to the rest of the system?**
  _49 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `gtm_store.py` be split into smaller, more focused modules?**
  _Cohesion score 0.10980392156862745 - nodes in this community are weakly interconnected._
- **Should `pipeline.py` be split into smaller, more focused modules?**
  _Cohesion score 0.13903743315508021 - nodes in this community are weakly interconnected._
- **Should `QeyNox — PRD V1` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._
- **Should `2. Les 7 oublis qui tuent — par ordre de priorité absolue` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._