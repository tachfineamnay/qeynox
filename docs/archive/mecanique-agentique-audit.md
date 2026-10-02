# 🧠 Audit de la mécanique agentique QeyNox
## Qu'avez-vous oublié ? Boucles, mémoire & graphs, plugins, orchestration · octobre 2026

> Question posée : *« Dans la mécanique agentique, est-ce que je n'ai pas oublié des choses — loop, plugins, comme l'utilisation de graphify ? »*
> Réponse courte : **oui, 4 couches entières manquent** (mémoire temporelle, boucles de réflexion, évals, exécution durable). Voici l'inventaire exhaustif, ce qui existe déjà, et l'ordre de construction. Les éléments validés (LLM de synthèse + serveur MCP) sont **déjà implémentés et testés** dans ce dépôt.

---

## 0. « Graphify » → vous parlez de **Graphiti** (Zep)

C'est le moteur de **knowledge graph temporel** pour agents (~24k★, cœur de Zep) : chaque fait porte ses **fenêtres de validité** (`valid_at` / `invalid_at`), le graphe se met à jour au fil des épisodes sans tout réécrire, avec recherche hybride (sémantique + BM25 + graphe). Sur le benchmark LongMemEval : **63,8 %** vs 49 % pour Mem0. Le papier : arXiv 2501.13956. Alternatives de l'écosystème 2026 :

| Outil | Modèle | Point fort | Pour QeyNox ? |
|---|---|---|---|
| **Graphiti** (OSS) | KG temporel (Neo4j/FalkorDB) | Faits historisés, invalidation, MCP server dispo | ✅ **le bon choix V3** — parfait pour « concurrent X a changé son prix le 12/03 » |
| **Mem0** (Apache-2.0) | Vecteurs + graphe | Simplicité, self-host facile | Bien pour mémoire conversationnelle, moins pour faits datés |
| **Cognee** (OSS) | Pipeline graph-memory | Graph permanent + session | Alternative si vous voulez tout Python |
| **Graphlit** | Plateforme contexte | Ingestion → KG → RAG → MCP | Plus lourd, orienté prod |
| **LightRAG** (OSS) | RAG sur graphe | Simple, sans DB graph externe | Le compromis minimaliste |

**Pourquoi c'est LA pièce manquante pour QeyNox** : votre `gtm.db` stocke des états (le dernier prix de concurrent X), pas une **histoire** (« prix 27 € du 01/03 au 12/06, puis 29 € »). Or un dossier GTM qui dit « cette niche change de pricing tous les 45 jours » vaut 10× plus. Le graphe temporel est exactement la représentation qu'il faut. ⚠️ Mais : ne le branchez pas tout de suite — commencez par la table `facts` (§2.3), Graphiti en V3 quand les données circulent.

---

## 1. Les boucles (loops) — inventaire des 7, votre état actuel

| # | Boucle | Rôle | État QeyNox | À faire |
|---|---|---|---|---|
| L1 | **Ingestion → dossier** | repo → research → dossier | ✅ existe (7+1 stages) | — |
| L2 | **Programmes récurrents** (heartbeat) | veille hebdo, rapport lun 08:00 | ✅ **IMPLÉMENTÉ** (`engine/loops.py` : daemon tick 60 s, `programs.json` par stack, exécution synchrone avec timeout, journal `loop.jsonl`, rapport `output/pulse.md`) | Ajouter l'UI de gestion des programmes (V2) |
| L3 | **Événements** (event-driven) | git push → re-scan diff ; changedetection.io → webhook | ✅ **IMPLÉMENTÉ** (programme `rescan-event` : empreinte HEAD git / fichiers du dépôt → changement détecté = re-scan keywords + competitors immédiat) | Webhook HTTP entrant — V2/V3 |
| L4 | **Plan → Exécuter → Réfléchir → Re-planifier** | GOC prépare, exécute, **critique son dossier**, relance les stages faibles | 🟡 **partiel** : réflexion par cycle (score santé + alertes dans `pulse.md`, régulation des programmes) ; la re-planification intelligente de stages attend le LLM-juge | Boucle de réflexion LLM — V2 |
| L5 | **Retry intelligent** | échec outil → diagnostic → stratégie alternative | ✅ **IMPLÉMENTÉ** (échec → retry +1 h, jamais immédiat ; 3 échecs consécutifs → programme auto-désactivé + alerte dans le pulse — jamais silencieux) | Taxonomie d'échecs + stratégie alternative — V2 |
| L6 | **Auto-amélioration** (do → learn → improve) | les runs alimentent les skills/programmes meilleurs | ❌ | Journal d'apprentissage par run (ce qui a marché/échoué) → prompt des prochains runs — V3 |
| L7 | **Auto-critique / évals** | LLM-juge note chaque dossier (0-100, rubrique : données sourcées ? personas ancrés ? actions concrètes ?) | 🟡 **partiel** : score de santé heuristique /100 par cycle (fraîcheur, volumes, AEO, taux d'échecs) dans `pulse.md` ; le jugement de FOND des dossiers attend le LLM | `engine/evals.py` + seuil « non livrable < 70 » — V2 |

**Premier cycle réel (02/10/2026, stack oracle-lumira)** : auto-dispatch de 6 programmes depuis `missions-suggested.json` → keywords **+334 mots-clés en base** (415 s), 5 concurrents snapshotés (baseline SHA), social en attente de SearXNG, trends en rate-limit Google (429) → **retry automatique programmé à +1 h, puis auto-désactivation après 3 échecs avec alerte**. Santé du stack : 67/100.

**Règle d'or des boucles** (ce que la plupart des gens oublient) : chaque boucle a besoin d'un **garde-fou** — max d'itérations, budget tokens, kill switch humain. Une boucle sans garde-fou est une facture API qui tourne en rond.

---

## 2. La mémoire — les 5 couches (vous n'en avez que 2,5)

| Couche | Contenu | État QeyNox |
|---|---|---|
| **Travail** (contexte session) | la mission en cours | 🟡 implicite (process) |
| **Épisodique** | historique des runs | 🟡 table `runs` minimale (tool + statut, pas de contexte) |
| **Procédurale** | comment faire (skills) | ✅ skills GTM portables + `TOOLS.md` |
| **Sémantique / RAG** | recherche dans tous les dossiers passés | ❌ |
| **Temporelle / graphe** | faits datés du marché (Graphiti-style) | ❌ **le grand manque** |

### 2.3 Plan pragmatique mémoire (sans sur-ingénierer)
1. **V2 — table `facts`** dans chaque `gtm.db` : `(stack, subject, predicate, object, valid_from, valid_until, source_url, confidence)`. Ex : `(oracle-lumira, astrocenter, pricing, "29€/mois", 2026-03-01, 2026-06-12, url, 0.9)`. Chaque stage écrit ses faits ; `competitor_watch` **invalide** (ferme `valid_until`) au lieu d'écraser. C'est 80 % de la valeur de Graphiti pour 5 % de l'effort, et ça reste en SQL lisible.
2. **V3 — Graphiti** au-dessus des `facts` : entités (Concurrent, Mot-clé, Persona, Canal, Verbatim) + arêtes typées + recherche hybride, servi **via son serveur MCP** — vos agents demandent « que sait-on d'astrocenter depuis 6 mois ? ». Neo4j ou FalkorDB embarqué.
3. **V3 — RAG des dossiers** : embeddings des dossiers passés (pgvector ou Qdrant) → un nouveau dossier cite « sur des stacks similaires, ces angles ont marché ».

---

## 3. Plugins & extensibilité — le point que vous aviez vu, complété

| Mécanisme | État | À faire |
|---|---|---|
| **Serveur MCP QeyNox** (votre base exposée aux agents) | ✅ **implémenté** (`mcp_server.py`, 10 outils, testé : initialize/list/call/propose_decision) | Publication + doc de branchement (Claude Code : `claude mcp add qeynox -- python3 mcp_server.py`) |
| **Client MCP** (QeyNox consomme des MCP externes) | ❌ | Un loader de config `mcp_servers.json` (Firecrawl MCP pour le scraping, **geo-optimizer MCP** pour l'AEO, GitHub MCP pour le re-scan, graphiti MCP pour la mémoire) → les tools apparaissent dans les missions. Priorité V2 |
| **Plugins de stage** (drop-in `engine/stages/*.py`) | ❌ stages codés en dur | Contrat simple : `def run(stack, analysis, seeds) -> dict` + manifest. La communauté peut ajouter un stage « ads_library_scan » sans fork — V3 |
| **Hooks pré/post-stage** | ❌ | `hooks: {post-aeo: "curl webhook..."}` dans la config — V2 (simple et puissant) |
| **Skills agents** | ✅ format agentskills.io (Hermes + OpenClaw) | auto-génération de skills par runs (L6) |
| **Permissions par outil** | ❌ tout est permis | Matrice simple : lecture libre / `launch_tool` = admin / dépenses = interdit hors validation — V2 |

---

## 4. Orchestration multi-agents — ce qui manque au circuit

- **Pattern blackboard** : ✅ vous l'avez déjà sans le nommer — `gtm.db` est un blackboard où chaque agent lit/écrit. Documentez-le comme tel dans AGENTS.md : c'est la bonne architecture (vs conversations inter-agents, plus fragiles).
- **Critic/Court-circuit** : ❌ avant de livrer un dossier, un agent « critique » (LLM-juge, L7) le relit avec une rubrique et **bloque** la livraison sous 70/100. Le pattern le plus rentable par ligne de code.
- **Handoffs typés** : 🟡 les agents passent des fichiers markdown ; manque un **schéma d'artefact** (`{type, stage, payload, confidence}`) pour que SCOUT→SCRIBE soit un contrat, pas un document.
- **Exécution durable** : ❌ si le serveur meurt au stage 5, tout est perdu (pipeline.json ne sait pas reprendre). Il faut : statuts persistés par stage (✅ déjà), reprise depuis le dernier stage done (`resume_stack(slug)`), idempotence des stages (écrasement sûr). **C'est le manque d'ingénierie n°1** — V2.
- **Parallélisme** : 🟡 keywords/signals/competitors/aeo sont séquentiels alors qu'ils sont indépendants → 4 threads = pipeline ~3× plus rapide. Facile, V2.

---

## 5. Context engineering (ce que les agents voient)

- **Context packs par mission** : ❌ chaque agent devrait recevoir un pack compilé (BUSINESS.md + personas validés + top 20 kws + 10 verbatims + diff concurrents récent) — jamais le dump brut. Fonction `build_context_pack(slug, role)` — V2.
- **Compression des logs** : 🟡 les logs de mission peuvent dépasser le contexte ; résumé LLM en fin de run → stocké comme épisode (L6).
- **Prompt registry** : ❌ les prompts du stage synthèse et des futures étapes LLM devraient être versionnés (fichiers `prompts/*.md`) pour A/B tester et rejouer les évals.

---

## 6. Évals, garde-fous, coûts (la couche que tout le monde oublie jusqu'au premier incident)

- **Golden set** : 3-5 stacks de référence avec dossiers « parfaits » annotés → chaque changement de prompt/stage est rejoué dessus (promptfoo, MIT).
- **LLM-as-judge avec rubrique** : sources citées ? faits vs hypothèses séparés ? actions actionnables ? → score dans le dossier lui-même (transparence = confiance client).
- **Budgets** : plafond tokens/€ par mission et par jour (compteur dans `runs`), coupe automatique. Les boucles L4/L5 sans budget sont dangereuses.
- **PII** : Presidio sur les verbatims avant envoi à un LLM cloud (mode Ollama local = souverain totale, argument de vente).
- **Kill switch** : un `qeynox.py halt` qui suspend toutes les boucles (L2/L3/L5) — l'équivalent du bouton d'arrêt d'urgence qu'on regrette de ne pas avoir.

---

## 7. Observabilité

- 🟡 `pipeline.json` + logs textuels : bien pour l'humain, illisible pour l'analyse.
- **V2/V3** : traces structurées par run (stage, durée, tokens, coût, verdict LLM-judge) → Langfuse (MIT, self-host) ou simple table `traces` + vue Metabase. Objectif : « pourquoi ce dossier était meilleur le mois dernier ? » répondable en 2 minutes.

---

## 8. Ce qui est DÉJÀ bien (ne sur-ingéniez pas)

1. **Le checkpoint humain obligatoire** — votre différenciateur, gardez-le coûtant (ne l'automatisez pas « plus tard », c'est le produit).
2. **Le blackboard SQL** — lisible, auditable, zéro magie ; Graphiti viendra PAR-DESSUS, pas à la place.
3. **Les flags de confiance** (`confidence: low`) sur la research dégradée — honnêteté rarissime dans les outils IA.
4. **Skills portables agentskills.io** — le bon standard, tenez-y vous.
5. **Le determinisme par défaut** — l'IA en option (`QEYNOX_LLM`), pas en dépendance : l'outil marche toujours, même sans GPU/clé.

---

## 9. Architecture cible (vue d'ensemble)

```
                        ┌──────────────────────────────────────────┐
   Agents (Hermes/      │              QEYNOX CORE                 │
   OpenClaw/Claude) ◄──►│  ┌────────┐  ┌─────────┐  ┌───────────┐  │
   via MCP ◄────────────┼─►│ MOTEUR │→ │ MÉMOIRE │→ │ BOUCLES   │  │
                        │  │ stages │  │ runs+   │  │ L2 cron   │  │
   MCP externes ───────►│  │ (+LLM  │  │ facts → │  │ L3 events │  │
   (firecrawl, geo,     │  │ synth.)│  │ graphiti│  │ L4 reflect│  │
    github, memory…)    │  └────────┘  └─────────┘  │ L7 judge  │  │
                        │  ┌────────────────┐       └───────────┘  │
   Humain ◄─────────────┼─ │ VALIDATION (gate) + décisions      │  │
                        │  └────────────────┘                       │
                        └──────────────────────────────────────────┘
```

---

## 10. Ordre de construction (validations intégrées)

| Vague | Contenu | État |
|---|---|---|
| **V1** | Stage **Synthèse IA** (Ollama auto → openai-compat → skip propre) + injection dans le dossier | ✅ **implémenté & testé** |
| **V1** | **Serveur MCP QeyNox** (10 outils : lecture base, launch_tool, propose_decision) | ✅ **implémenté & testé** |
| **V2** | Client MCP (`mcp_servers.json`) + **boucle L7** (LLM-juge) + **exécution durable** (resume) + **parallélisation** + programmes L2 + table `facts` | à faire (2-3 sem) |
| **V3** | **Graphiti** (+ MCP) au-dessus des facts · re-scan git (L3) · RAG des dossiers · plugins de stage · Langfuse | à faire (mois 2) |

**La phrase à retenir** : vous aviez un *pipeline* ; avec V1-V2 vous avez un *organisme* (il se souvient, il se juge, il recommence) ; avec V3 vous avez une *institution* (elle accumule une histoire du marché que personne ne peut copier).
