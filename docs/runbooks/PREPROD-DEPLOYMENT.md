# Préproduction — Deployment Runbook

**Date : 2026-10-03**


## Topologie

Services minimaux :
- API
- Web
- Worker
- PostgreSQL
- Hatchet
- MinIO/S3
- OTel Collector

Services additionnels activés selon POC :
- OPA
- Langfuse
- ToolHive
- n8n
- SearXNG
- Ollama

## Réseau

Exposer publiquement uniquement :
- Web ;
- API via reverse proxy.

Interne uniquement :
- Postgres ;
- Hatchet backend ;
- object storage admin ;
- OTel ;
- OPA ;
- provider runtimes.

## Base

Recommandation préprod :
- PostgreSQL 17 ;
- DB logique `qeynox`;
- DB logique Hatchet séparée ;
- pgvector activé côté QeyNox.

## Déploiement

1. provisionner DNS/TLS ;
2. créer volumes persistants ;
3. injecter secrets ;
4. déployer PostgreSQL ;
5. déployer Hatchet ;
6. appliquer migrations QeyNox ;
7. déployer API/Worker ;
8. déployer Web ;
9. déployer OTel ;
10. activer providers POC ;
11. lancer smoke tests ;
12. signer GO checklist.

## Health endpoints requis

- `/health/live`
- `/health/ready`
- `/health/dependencies`

Le readiness doit vérifier :
- DB QeyNox ;
- Hatchet ;
- object storage.

Les providers externes ne bloquent pas le readiness global ; leur état apparaît séparément.

## Backup

Préprod :
- backup PostgreSQL quotidien ;
- object storage versionné ou snapshoté ;
- test de restauration documenté avant GO production.

## Rollback

Chaque déploiement doit être associé à :
- image tag immuable ;
- SHA Git ;
- migration version ;
- rollback application ;
- stratégie de rollback DB.
