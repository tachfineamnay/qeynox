# QeyNox

Le code actuel est la **V1 legacy** : onboard d’un dépôt, research, dossier GTM, validation humaine, veilles. La **cible actuelle est V2.1**, écrite dans [docs/PRD-v2.md](docs/PRD-v2.md). Elle n’est pas implémentée.

[docs/PRD-v1.md](docs/PRD-v1.md) décrit la V1. Là où il parle d’un plan d’actions, de jobs, d’un ContextPack ou d’Hermes branché sur chaque tâche, ce n’est pas le comportement du code.

## Démarrage

```bash
python qeynox.py serve                 # UI : http://127.0.0.1:8765
python qeynox.py onboard --name "Mon Produit" --repo /chemin/ou/url.git \
        --site https://exemple.com --seed "mot-clé marché"
python qeynox.py status
python qeynox.py validate mon-produit
python qeynox.py arms list
```

SearXNG n’est pas fourni avec le dépôt. S’il répond sur `SEARXNG_URL` (défaut `http://127.0.0.1:8888`), une partie de la research l’utilise. Sinon le pipeline replie sur Bing puis DuckDuckGo. `social_pulse` et `serp_rank` ont besoin de SearXNG.

Copiez `tools/config.example.env` vers `.env`. `HERMES_API_URL` est une variable réservée : aucun job ne l’appelle.

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

## Sécurité

Le serveur web écoute `127.0.0.1` par défaut. `GTM_WEB_HOST` élargit l’écoute. `GTM_HOOK_TOKEN`, s’il est défini, protège `POST /api/hooks/agent`. Il n’y a pas d’auth sur le reste de l’UI.
