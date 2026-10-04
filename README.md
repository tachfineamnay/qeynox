# QeyNox — usine GTM auto-hébergée

Connectez le **repo d’un produit**. QeyNox en extrait le contexte, mène la research (marché, mots-clés, signaux, concurrents, AEO), produit un dossier + un plan, attend **votre go**, puis lance les veilles.

Contrats produit : [docs/PRD-v1.md](docs/PRD-v1.md) (usine, dossier, gate) · [docs/PRD-v2.md](docs/PRD-v2.md) (plan, jobs, Hermes, LLM par tâche).

Hermes Agent est le worker d’exécution (caché). OpenClaw et Telegram sont hors V1.

```
Repo produit
    → intake → discovery → strategy → validation humaine → production / veilles
```

## Démarrage

```bash
python qeynox.py serve                 # UI : http://127.0.0.1:8765  (QEYNOX_BIND, GTM_WEB_PORT)
python qeynox.py onboard --name "Mon Produit" --repo /chemin/ou/url.git \
        --site https://exemple.com --seed "mot-clé marché"
python qeynox.py status
python qeynox.py validate mon-produit
python qeynox.py arms list             # catalogue d'outils (bras)
```

SearXNG (recommandé, port 8888) améliore la research. Sans lui, fallback Bing/DDG et `confidence: low`.

Copiez `tools/config.example.env` vers `.env`. `HERMES_API_URL` est réservé au worker (pas encore branché sur chaque job).

## Catalogue de bras

Seed versionné : `catalog/arms.json`. Ajouts : `catalog/custom.json`. Endpoints locaux : `catalog/overrides.json` (voir `overrides.example.json`).

```bash
python qeynox.py arms list --mcp
python qeynox.py arms get searxng
python qeynox.py arms enable searxng --endpoint http://127.0.0.1:8888
```

## Layout

```
qeynox/
├── docs/PRD-v1.md      contrat produit V1
├── docs/PRD-v2.md      exécution du plan (jobs, Hermes, API)
├── catalog/            bras OSS/payants (alimentable)
├── qeynox.py           CLI
├── engine/             pipeline, dossier, boucles, catalogue
├── web/                UI locale
├── tools/              collecteurs (keywords, SERP, veilles…)
├── mcp_server.py       MCP lecture + launch_tool
└── stacks/<slug>/      un projet = un tenant (jamais dans le cœur)
```

## Boucles

```bash
python engine/loops.py --once <slug>
python engine/loops.py --daemon
python engine/loops.py --halt
```

Kill switch : `stacks/.halt`.

## Sécurité

Le serveur écoute `127.0.0.1` par défaut (`QEYNOX_BIND` pour un conteneur). S'il est lié à une autre adresse sans `QEYNOX_API_TOKEN`, il refuse de démarrer. Quand `QEYNOX_API_TOKEN` (ou l'ancien `GTM_HOOK_TOKEN`) est défini, toutes les routes `/api/*` sauf `/api/health` exigent `Authorization: Bearer`, `X-Qeynox-Token` ou `X-Lumira-Token`. L'UI demande le jeton au premier refus 401 (sessionStorage).

Les clones git n'acceptent que `http(s)` et `git@hôte:chemin`. Les archives zip ne peuvent pas écrire hors du dossier cible. Les URL de site passées à l'audit doivent être des http(s) publics (pas de loopback, lien-local, ni réseau privé).

Rien ne quitte la machine hors requêtes de recherche publiques. Les personas et concurrents sont des hypothèses sourcées.
