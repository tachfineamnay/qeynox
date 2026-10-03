# QeyNox — PRD V1

Usine GTM auto-hébergée. Un produit connecté devient un dossier, un plan, puis de la production — comme une agence, pas comme une flotte d’agents mascottes.

**Décisions tranchées.** Hermes = worker d’exécution (caché). OpenClaw hors V1. Telegram / WhatsApp hors V1. Zéro verticale hardcodée.

**Suite :** [PRD-v2.md](PRD-v2.md) — exécution du plan (jobs, Hermes branché, LLM par tâche, API métier).

---

## 1. Problème

Le GTM d’un produit (recherche marché, positionnement, contenus, veille) est encore un chantier artisanal : slides, tabs SEO, agents Discord. QeyNox industrialise ça en local : **connecter le repo du produit**, en extraire le contexte, produire une stratégie sourcée, faire valider un humain, puis exécuter.

Ce n’est pas un kit pour un marché particulier. Lumira, SocioPulse ou le suivant sont des *projets*, pas le code.

---

## 2. Produit

**QeyNox** = couche métier (contexte, dossier, plan, jobs, budget, preuves) + UI minimale + API in/out.

**Hermes Agent** = atelier. QeyNox lui envoie un job (`/v1/runs` ou `/v1/responses`) avec un context pack et un `output_schema`. L’utilisateur n’ouvre pas Hermes.

**LiteLLM / OpenRouter / Ollama** = quel modèle tourne *sur ce job*. Pas un LLM par personnage.

**Bras** = outils du catalogue `catalog/` (SearXNG, crawlers, GEO, analytics…). OSS d’abord, clé payante en option.

### Parcours agence

```
Connecter le repo
        │
        ▼
  1. INTAKE      nom, source, site, graines optionnelles
        │
        ▼
  2. DISCOVERY   deep dive code / docs / site / marché
        │         → context pack versionné
        ▼
  3. STRATEGY    dossier + plan 90 jours
        │         → 1 go humain « on produit »
        ▼
  4. PRODUCTION  jobs du plan (drafts, veilles)
        │         publish / spend = second gate
        ▼
  5. REPORTING   pulse, preuves, coût, prochaines actions
```

Les drafts peuvent partir après le go stratégie. Rien de public (post, mail, ads) sans approbation.

### Critère d’acidité

Onboarder un second produit **sans** `if projet` dans `engine/`. Si le cœur change, ce n’est pas une usine.

---

## 3. Utilisateurs V1

Opérateur unique (toi) en local / VPS. Deux projets internes visés : un produit consumer-search, un produit B2B/social — mêmes contrats, profils différents.

Hors V1 : comptes clients, rôles agency, billing.

---

## 4. Surfaces

| Surface | V1 | Non-V1 |
|---|---|---|
| UI web locale (`qeynox.py serve`) | 3 vues : projets, projet (timeline + dossier + jobs), job | refonte visuelle, onglet « flotte d’agents » comme identité |
| CLI | onboard, status, validate, serve, arms | — |
| API métier | lecture stacks / dossier / keywords ; hook livrables existant | contrat public Project / Job / Artifact + webhooks sortants |
| MCP QeyNox | lecture + launch_tool + propose_decision (déjà là) | get_plan, submit_deliverable |
| Hermes | documenté, endpoint dans l’env | runs branchés sur chaque job |
| Chat Telegram | — | canal optionnel d’`approval.needed` |

---

## 5. Objets métier

- **Project** (aujourd’hui « stack ») : un produit, un dossier `stacks/<slug>/`.
- **ContextPack** : extrait versionné du repo + site (offre, stack tech, CTAs, contraintes). C’est ce que le worker reçoit, pas le dump brut.
- **Strategy** : dossier GTM markdown + `dossier/data.json`.
- **Plan** : liste d’actions typées (`discover.keywords`, `crawl.site`, `geo.visibility`, …).
- **Job** : `{ type, model, arms[], schema, status, cost }`.
- **Artifact** : livrable d’un job, avec `sources[]`.
- **Arm** : entrée du catalogue (capability + deploy + MCP).

Les rôles (recherche, rédaction, critique) sont des champs du job, pas une identité produit GOC / SCOUT / SCRIBE.

---

## 6. LLM par job (défauts, overridables)

| Type de job | Défaut | Pourquoi |
|---|---|---|
| Extraire, crawler, classer | cheap / local (Ollama, Flash, Haiku) | volume |
| Synthèse stratégique | frontier | c’est le livrable vendu |
| Drafts contenu | mid | volume × qualité |
| Critique du dossier | **autre** frontier que le rédacteur | pas d’auto-congratulation |

Sélecteur prévu en UI job : `Auto · Fast · Strong · Local · Custom`. V1 code : env `QEYNOX_LLM` déjà utilisé par la synthèse ; le routeur LiteLLM vient ensuite.

---

## 7. Bras (catalogue)

Source de vérité : `catalog/arms.json` (seed) + `catalog/custom.json` (ajouts) + `catalog/overrides.json` (enabled / endpoint locaux, non versionné avec des secrets).

CLI : `python qeynox.py arms list|get|add|enable|disable`.

V1 seed (18) : OpenSEO, CrawlSEO, Scouter, SEOnaut, Open SEO Crawler, SEO Intelligence, SerpBear, OpenCited (self-host partiel), Gego, AI SEO Platform, Lighthouse CI, Matomo, Umami, SearXNG, Langfuse, Ollama, Qdrant, pgvector.

Règle : **aucun bras n’est une verticale**. Un crawler ne connaît pas Lumira. Les cibles concurrents viennent du *projet* (`research/competitors.json`).

Activation V0 recommandée : SearXNG. Le reste = slots.

---

## 8. API (contrat, pas tout livré en V1)

**In** — recevoir : créer un projet, sync git, faits (prix, CRM), approbations, artefacts worker.

**Out** — faire sortir : projet, context pack, plan, jobs, artefacts ; webhooks `strategy.ready`, `job.completed`, `approval.needed`.

Aujourd’hui : serveur web stdlib + `POST /api/hooks/agent`. Le contrat ci-dessus est la cible ; ne pas inventer un second protocole propriétaire (Hermes parle déjà OpenAI-compat).

---

## 9. Architecture

```
Repo produit
    → QeyNox core (pipeline, gtm.db, plan, gates)
         → UI
         → API métier
         → catalog/arms
         → Hermes (worker) → LiteLLM (modèle du job) → bras MCP/HTTP
```

Un seul scheduler de veille : `engine/loops.py`. Pas de cron Hermes *et* heartbeat OpenClaw sur le même projet.

---

## 10. Hors V1

Multi-tenant, Paddle/billing, Graphiti, OpenClaw, marketplace de templates, RAG Qdrant obligatoire, UI « parfaite » (le socle 3 vues suffit), golden set LLM-juge bloquant.

---

## 11. Non-négociable

- Checkpoint humain avant publication / dépense.
- Claims sourcés (`gtm.db` / JSON research) ; research dégradée = `confidence: low`.
- Determinisme par défaut ; LLM optionnel.
- Données du projet dans `stacks/<slug>/` ; le git du cœur ne contient **aucun** tenant réel.
