# QeyNox

**Statut : BETA50** — le runtime V1.5 est utilisable de bout en bout en auto-hébergé : onboard d’un dépôt, research, dossier GTM, validation humaine, swarm de missions, boucles et MCP. Le **contrat de livraison BETA50** (périmètre, flags, API, UI, limites, critères d’acceptation) est dans [docs/beta50/BETA50_CONTRACT.md](docs/beta50/BETA50_CONTRACT.md).

Le **Domain Core V2** (`core/`) est présent et testé comme bibliothèque interne (domaine, providers, PostgreSQL, Hatchet) mais **n’est pas exposé** par les surfaces BETA50. La cible V2.1 complète reste décrite dans [docs/PRD-v2.md](docs/PRD-v2.md) et [docs/05-IMPLEMENTATION-ROADMAP.md](docs/05-IMPLEMENTATION-ROADMAP.md).

[docs/PRD-v1.md](docs/PRD-v1.md) décrit la V1. Là où il parle d’un plan d’actions, de jobs, d’un ContextPack ou d’Hermes branché sur chaque tâche, ce n’est pas le comportement livré en BETA50.

## Démarrage

```bash
python qeynox.py serve                 # UI : http://127.0.0.1:8765  (QEYNOX_BIND, GTM_WEB_PORT)
python qeynox.py onboard --name "Mon Produit" --repo /chemin/ou/url.git \
        --site https://exemple.com --seed "mot-clé marché"
python qeynox.py status
python qeynox.py validate mon-produit
python qeynox.py arms list
```

SearXNG n’est pas fourni avec le dépôt. S’il répond sur `SEARXNG_URL` (défaut `http://127.0.0.1:8888`), une partie de la research l’utilise. Sinon le pipeline replie sur Bing puis DuckDuckGo. `social_pulse` et `serp_rank` ont besoin de SearXNG.

Copiez `tools/config.example.env` vers `.env`. `HERMES_API_URL` / `HERMES_API_KEY` sont **réservés** : aucun code BETA50 ne les lit (worker Hermes hors périmètre).

## BETA50

- Contrat : [docs/beta50/BETA50_CONTRACT.md](docs/beta50/BETA50_CONTRACT.md) (source machine : [BETA50_CONTRACT.json](docs/beta50/BETA50_CONTRACT.json))
- Plan d’acceptation et résultats : [docs/beta50/BETA50_ACCEPTANCE.md](docs/beta50/BETA50_ACCEPTANCE.md)
- Souveraineté par défaut : `QEYNOX_LLM=none` (aucun appel LLM), `QEYNOX_OFFLINE_SEARCH=1` pour les démos/CI.
- Hors BETA50 : surfaces produit V2 (projets, jobs, artefacts, exécution), PostgreSQL source de vérité, Hatchet activé, multi-tenant.

## Catalogue de bras

Seed versionné : `catalog/arms.json`. Le fichier d’exemple est `catalog/overrides.example.json`. `catalog/overrides.json` et `catalog/custom.json` restent locaux.

```bash
python qeynox.py arms list --mcp
python qeynox.py arms get searxng
python qeynox.py arms enable searxng --endpoint http://127.0.0.1:8888
```

## Layout

```
qeynox/
├── docs/PRD-v1.md      contrat V1 legacy
├── docs/PRD-v2.md      cible V2.1, non livrée
├── catalog/            bras versionnés + exemples
├── qeynox.py           CLI
├── engine/             pipeline, dossier, boucles, catalogue
├── web/                UI locale
├── tools/              collecteurs
├── mcp_server.py       MCP : lectures, launch_tool, propose_decision
└── stacks/             runtime local par projet, non versionné
```

`stacks/registry.json` n’est pas dans git. Au premier onboard, le code crée `stacks/` et ce fichier. Un clone frais démarre sans tenant.

## Boucles

```bash
python engine/loops.py --once <slug>
python engine/loops.py --daemon
python engine/loops.py --halt
```

Kill switch : `stacks/.halt` (local, non versionné).

## Déploiement

Image non-root, volume `/data`, healthcheck `/api/health`. Le daemon de boucles est un second service de la même image.

```bash
cp .env.example .env          # définir QEYNOX_API_TOKEN
docker compose up -d --build  # UI : http://127.0.0.1:8765
docker compose --profile search up -d   # ajoute SearXNG
```

Runbook Coolify : [docs/runbooks/COOLIFY-DEPLOY.md](docs/runbooks/COOLIFY-DEPLOY.md).

## Sécurité

Le serveur écoute `127.0.0.1` par défaut (`QEYNOX_BIND` pour un conteneur). S'il est lié à une autre adresse sans `QEYNOX_API_TOKEN`, il refuse de démarrer. Quand `QEYNOX_API_TOKEN` (ou l'ancien `GTM_HOOK_TOKEN`) est défini, toutes les routes `/api/*` sauf `/api/health` exigent `Authorization: Bearer`, `X-Qeynox-Token` ou `X-Lumira-Token`. L'UI demande le jeton au premier refus 401 (sessionStorage).

Les clones git n'acceptent que `http(s)` et `git@hôte:chemin`. Les archives zip ne peuvent pas écrire hors du dossier cible. Les URL de site passées à l'audit doivent être des http(s) publics (pas de loopback, lien-local, ni réseau privé).

Rien ne quitte la machine hors requêtes de recherche publiques. Les personas et concurrents sont des hypothèses sourcées.

Limites connues, laissées en l'état :

- `dossier/data.json` est réécrit à chaque génération. Les copies immuables sont `dossier/versions/gtm-dossier-vNNNN.*`, avec `latest.json` comme pointeur.
- Le jeton saisi dans l'UI reste dans `sessionStorage` (perdu avec la session du navigateur).
- L'URL de site est contrôlée sans résolution DNS à la création du stack. Le fetch revalide chaque redirection ; une fenêtre de DNS rebinding reste possible.
