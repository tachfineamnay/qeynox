# QeyNox — PRD V2

Suite de [PRD-v1.md](PRD-v1.md). V1 décrit l’usine et livre le dossier. V2 **exécute le plan**.

**Objectif.** Passer de « usine qui analyse et écrit un dossier » à « usine qui exécute un plan » : Hermes reçoit un job, rend un artefact typé, QeyNox garde le cerveau, les gates et le budget.

**Décisions tranchées.** Un seul scheduler (`engine/loops.py`). Hermes = worker caché (`/v1/runs`). LLM **par job**, pas par personnage. OpenClaw, Telegram, multi-tenant, billing, Graphiti : hors V2.

---

## 1. Ce que V1 a livré / ce que V2 doit livrer

| Couche | V1 (aujourd’hui) | V2 |
|---|---|---|
| Discovery → dossier | pipeline 7+ stages, `gtm.db`, gate humain | inchangé |
| Plan | missions suggérées figées à la validation | `plan.json` d’actions typées |
| Exécution | outils CLI + loops, souvent « ok » à 0 résultat | jobs avec statut honnête + artefact |
| Hermes | `HERMES_API_URL` dans l’env, pas branché | un run Hermes par job |
| LLM | `QEYNOX_LLM` pour la synthèse | modèle choisi **sur le job** |
| API | lecture + `POST /api/hooks/agent` | contrat Project / Job / Artifact + webhooks |
| MCP | lecture, `launch_tool`, `propose_decision` | + `get_plan`, `get_next_actions`, `submit_deliverable` |

---

## 2. Objets (contrats)

Fichiers par projet, sous `stacks/<slug>/` — jamais de verticale dans `engine/`.

### Project

Déjà le registre + le dossier. V2 n’ajoute que `profile.json` optionnel : langue, geo, `site_url`, `brand_aliases`, stages on/off.

### Plan

`stacks/<slug>/plan.json` — liste d’actions après le go stratégie.

```json
{
  "version": 1,
  "project": "mon-produit",
  "actions": [
    {
      "id": "a1",
      "type": "discover.keywords",
      "role": "research",
      "title": "Enrichir les graines validées",
      "inputs": { "seeds": [] },
      "arms": ["searxng"],
      "model": "auto",
      "gate": false,
      "done_when": "n_keywords >= 30 et confidence != low silencieux"
    }
  ]
}
```

Types V2 (fermés — en ajouter = nouvelle entrée catalogue + schéma, pas un `if` produit) :

- `discover.keywords` · `discover.serp` · `discover.signals`
- `crawl.site` · `audit.technical` · `audit.aeo`
- `geo.visibility` · `rank.track` · `competitors.watch`
- `analytics.traffic` · `search.web`
- `content.outline` · `content.hooks` · `strategy.critique`
- `perf.lighthouse` · `llm.observe` · `rag.embed`

### Job

Une exécution d’une action.

```json
{
  "id": "j_…",
  "action_id": "a1",
  "type": "discover.keywords",
  "status": "queued|running|ok|failed|needs_approval",
  "model": "local",
  "model_resolved": "ollama/qwen2.5",
  "arms": ["searxng"],
  "hermes_run_id": null,
  "cost": { "tokens_in": 0, "tokens_out": 0, "eur": 0 },
  "error": null,
  "artifact_id": null
}
```

Règle : 0 résultat à cause d’un bras down (SearXNG, Hermes) = `failed`, jamais `ok`.

### Artifact

Livrable typé + preuves.

```json
{
  "id": "art_…",
  "job_id": "j_…",
  "type": "keywords.table",
  "body": {},
  "sources": [{ "url": "", "note": "" }],
  "confidence": "ok|low"
}
```

### Context pack

Ce que Hermes reçoit — **jamais** le dump `research/*.json`. Fonction `build_context_pack(slug, action_type)` : offre, personas validés, top 20 kws, 10 verbatims, 3 battlecards, règles du `profile.json`.

---

## 3. Hermes (worker)

QeyNox POST vers `HERMES_API_URL` (`/v1/runs` ou `/v1/responses`) :

- `instructions` = rôle + règles + context pack
- `input` = brief de l’action
- `output_schema` = schéma de l’artefact attendu
- `model` / `provider` = résolution LiteLLM du job

Hermes exécute tools / MCP / sous-agents. QeyNox n’ouvre pas son UI.

Si Hermes est injoignable : job `failed`, `error` explicite, retry selon `engine/loops.py` (+1 h, 3 échecs → disable). Pas de second cron chez Hermes.

Steer / stop : l’UI job appelle les endpoints Hermes déjà prévus (`/v1/runs/{id}/steer`, `/stop`) — pas une nouvelle flotte.

---

## 4. LLM par job

Sélecteur : `Auto · Fast · Strong · Local · Custom`.

| Type de job | Auto |
|---|---|
| Extraire, crawler, classer, search | Fast ou Local (Ollama, Flash, Haiku) |
| Synthèse, positionnement, `strategy.critique` | Strong (frontier) — **juge ≠ rédacteur** |
| Drafts (`content.*`) | mid (Sonnet / équivalent) |
| Custom | `provider/model` collé sur le job |

Routeur : LiteLLM (ou OpenRouter derrière). Fallbacks + budget par projet. `QEYNOX_LLM` reste le défaut de la synthèse si Auto n’a rien d’autre.

---

## 5. API métier

Préfixe `/v1`. Auth : token unique V2 (`QEYNOX_API_TOKEN`), pas encore multi-tenant.

**In**

- `POST /v1/projects` — onboard (déjà CLI)
- `POST /v1/projects/:slug/sync` — re-scan source
- `POST /v1/projects/:slug/jobs` — enfiler une action du plan
- `POST /v1/jobs/:id/artifacts` — Hermes / MCP rend le livrable
- `POST /v1/approvals/:id` — go / no-go

**Out**

- `GET /v1/projects/:slug`
- `GET /v1/projects/:slug/context`
- `GET /v1/projects/:slug/plan`
- `GET /v1/jobs` · `GET /v1/jobs/:id`
- `GET /v1/artifacts/:id`
- `POST /v1/webhooks` — abonnements

Événements : `strategy.ready`, `job.completed`, `job.failed`, `artifact.ready`, `approval.needed`.

Payload stable : `project_id`, `job_id`, `sources[]`, `cost`, `model`. Ne pas inventer un protocole parallèle à Hermes.

---

## 6. MCP V2

En plus des tools V1 :

- `get_plan(slug)`
- `get_next_actions(slug)`
- `submit_deliverable(job_id, artifact)`

Un client MCP (Hermes) **lit** QeyNox et **rend** des artefacts. Il ne devient pas le scheduler.

---

## 7. UI V2

Toujours 3 surfaces. Ce qui change :

1. **Projets** — état + prochaine action du plan.
2. **Projet** — dossier à gauche, jobs du plan à droite, bouton « Lancer la prod » (go unique).
3. **Job** — brief, modèle, bras, stream Hermes, artefact, Approuver / Relancer / Changer de modèle, coût.

Pas d’onglet flotte GOC/SCOUT comme identité.

---

## 8. Critères d’acidité

1. Job `geo.visibility` sur un second produit (SocioPulse) **sans** `if` dans `engine/`.
2. Hermes down → le job est `failed`, visible dans l’UI et le pulse — jamais un succès à 0 citation.
3. Relancer le même job est idempotent (même `action_id` : nouvel `job_id`, artefact précédent conservé).

---

## 9. Hors V2

OpenClaw, Telegram / WhatsApp, comptes clients, Paddle, Graphiti, marketplace de templates, RAG Qdrant obligatoire, golden set juge bloquant (< 70 = non livrable — V3 si on vend du RaaS).

---

## 10. Non-négociable (repris de V1)

- Checkpoint humain avant publication / dépense.
- Claims sourcés ; research dégradée = `confidence: low`.
- Determinisme par défaut ; LLM optionnel.
- Aucun tenant réel dans le git du cœur.
