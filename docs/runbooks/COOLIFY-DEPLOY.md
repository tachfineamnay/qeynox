# QeyNox V1.5 — déploiement Coolify

Ce runbook déploie la V1 telle qu'elle est (Python, SQLite, UI actuelle). Il n'introduit pas FastAPI, Postgres, Hatchet ni Next.js. Le runbook de préproduction V2 (`PREPROD-DEPLOYMENT.md`) décrit une autre topologie : ne pas le suivre pour cette image.

## Ce qui tourne

| Service | Rôle | Port |
| --- | --- | --- |
| `qeynox` | UI et API (`python qeynox.py serve`) | 8765 |
| `qeynox-loops` | Daemon de veilles (`python engine/loops.py --daemon`) | aucun |
| `searxng` | Recherche, profil Compose `search` seulement | 8080 dans le réseau, 8888 publié |

Les deux services QeyNox partagent l'image et le volume `qeynox-data` monté sur `/data`.

Le daemon est un service séparé, pas un process manager dans le conteneur HTTP. Un cycle de veille peut durer plusieurs minutes : le coller au processus web lierait le healthcheck `/api/health` à ce cycle, et un redéploiement de l'UI tuerait une veille en cours. Les deux lisent les mêmes `stacks/<slug>/`, la même SQLite et le même `stacks/.halt`.

Sans le profil `search`, `SEARXNG_URL` ne répond pas. La research retombe sur Bing/DDG et `/api/health` rapporte `"searxng": false`.

## Prérequis

- Dépôt GitHub `tachfineamnay/qeynox`, branche qui contient `docker-compose.yml` (cette branche, puis `main` une fois fusionnée).
- Coolify avec le build pack **Docker Compose**.
- Un domaine pointant vers Coolify.

Le conteneur écoute `0.0.0.0`. Sans `QEYNOX_API_TOKEN`, le processus s'arrête volontairement.

## 1. Créer la ressource

1. Coolify → New Resource → Docker Compose.
2. Source : ce dépôt GitHub. Build pack : Docker Compose. Fichier : `docker-compose.yml` à la racine.
3. Branche : la branche à déployer.
4. Domaine : l'attacher au service **`qeynox`**, pas à `qeynox-loops`. Port du conteneur : **8765**.
5. HTTPS : laisser Coolify terminer TLS devant le proxy. Ne pas publier le port 8765 sur l'hôte si le proxy suffit. Le `ports:` du compose est utile en local ; Coolify peut le remplacer par son proxy.

## 2. Variables

Les coller dans l'UI Coolify (elles servent à l'interpolation du compose). Partir de `.env.example`. Ne jamais committer le `.env` réel.

| Variable | Valeur |
| --- | --- |
| `QEYNOX_API_TOKEN` | jeton long, aléatoire. Obligatoire. |
| `QEYNOX_BIND` | déjà forcé à `0.0.0.0` dans le compose. |
| `GTM_WEB_PORT` | `8765` dans le conteneur. |
| `QEYNOX_STACKS_DIR` | `/data/stacks` |
| `QEYNOX_LOGS_DIR` | `/data/logs` |
| `QEYNOX_MISSIONS_FILE` | `/data/missions.json` |
| `SEARXNG_URL` | `http://searxng:8080` |
| `GTM_LANG` / `GTM_GL` | `fr` / `FR` |
| `QEYNOX_LLM` | `none` tant qu'aucun LLM n'est branché. |

`QEYNOX_LLM_API_KEY` reste vide. Ce n'est pas un secret à mettre dans Git.

## 3. Volume

Le compose déclare le volume nommé `qeynox-data` → `/data`.

Il contient :

- `stacks/<slug>/` (dossier, research, `data/gtm.db`) ;
- `logs/` ;
- `missions.json`.

L'image initialise `/data` avec le propriétaire `qeynox` (uid **10001**). Un volume Docker nommé reprend ce propriétaire. Si vous remplacez le volume par un bind mount hôte, le répertoire doit être inscriptible par uid 10001 (`chown -R 10001:10001` sur l'hôte) avant le premier démarrage.

Ne pas monter le dépôt Git par-dessus `/app` : le code vient de l'image. Seules les données runtime vivent sur le volume.

## 4. SearXNG (optionnel)

Le service est derrière le profil `search`. Le bouton Deploy de Coolify lance `docker compose up` **sans** ce profil : SearXNG ne démarre pas, et c'est voulu.

Pour l'activer, la commande de déploiement Coolify doit inclure `--profile search`, ou le service doit être retiré du profil dans une copie du compose que vous maintenez. Vérifier ensuite que `/api/health` contient `"searxng": true`.

## 5. Premier démarrage

1. Deploy.
2. Les logs de `qeynox` doivent afficher `auth : jeton requis` et rester vivants. S'ils s'arrêtent sur `Refus de démarrer`, le jeton est vide.
3. Les logs de `qeynox-loops` affichent `daemon démarré`. Aucun healthcheck HTTP sur ce service : il n'écoute pas.

## 6. Vérifier

Remplacer le domaine et le jeton.

```bash
curl -fsS https://qeynox.exemple.com/api/health
# {"ok": true, "searxng": false, "time": "..."}

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://qeynox.exemple.com/api/stacks \
  -H 'Content-Type: application/json' \
  -d '{"name":"x","source":"https://github.com/tachfineamnay/qeynox"}'
# 401

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://qeynox.exemple.com/api/stacks \
  -H 'Authorization: Bearer LE_JETON' \
  -H 'Content-Type: application/json' \
  -d '{"name":"x","source":"https://github.com/tachfineamnay/qeynox"}'
# 201 lance un vrai pipeline. 400 si l'URL est refusée.
```

Ouvrir l'UI. Au premier appel API refusé, elle demande le jeton (sessionStorage du navigateur, perdu si on ferme la session).

## 7. Mettre à jour

1. Pousser le commit voulu sur la branche suivie par Coolify.
2. Redeploy. Coolify reconstruit l'image et recrée les conteneurs.
3. Le volume `qeynox-data` n'est pas recréé : stacks, SQLite et logs restent.

Revérifier `/api/health` et un `POST /api/stacks` sans jeton (401).

## 8. Revenir en arrière

1. Dans Coolify, redéployer le SHA précédent (ou remettre la branche sur ce commit, puis Redeploy).
2. Ne pas supprimer le volume. Un rollback de code ne restaure pas une SQLite écrasée par une version plus récente : cette V1.5 ne change pas le schéma. Si une future version migre les fichiers, sauvegarder `/data` avant.

Sauvegarde :

```bash
docker run --rm -v qeynox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/qeynox-data.tgz -C /data .
```

Le nom exact du volume est préfixé par le projet Compose (`<projet>_qeynox-data`). `docker volume ls` donne le nom.

## 9. Arrêter les veilles sans arrêter l'UI

Dans le conteneur `qeynox-loops`, ou avec le code monté sur le même volume :

```bash
python engine/loops.py --halt
python engine/loops.py --resume
```

`--halt` crée `/data/stacks/.halt`. Le daemon le voit au tick suivant et ne lance plus de programme.
