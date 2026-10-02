# QeyNox — usine GTM auto-hébergée

Connectez le **repo d’un produit**. QeyNox en extrait le contexte, mène la research (marché, mots-clés, signaux, concurrents, AEO), produit un dossier + un plan, attend **votre go**, puis lance les veilles.

Produit de référence : [docs/PRD-v1.md](docs/PRD-v1.md).

Hermes Agent est le worker d’exécution (caché). OpenClaw et Telegram sont hors V1.

```
Repo produit
    → intake → discovery → strategy → validation humaine → production / veilles
```

## Démarrage

```bash
python qeynox.py serve                 # UI : http://127.0.0.1:8765
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

Local / VPS derrière auth si exposé. `GTM_HOOK_TOKEN` pour le hook agents. Rien ne quitte la machine hors requêtes de recherche publiques. Les personas et concurrents sont des hypothèses sourcées.
