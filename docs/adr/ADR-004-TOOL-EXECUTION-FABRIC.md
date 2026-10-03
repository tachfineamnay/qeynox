# ADR-004 — Execution Tool Fabric

**Date : 2026-10-03**


**Statut : ACCEPTÉ**

## Décision

Tout outil externe est un `Provider` d'une ou plusieurs `Capabilities`.

Le mode d'intégration est indépendant de la capability :
- HTTP/REST ;
- OpenAPI ;
- MCP ;
- Docker ;
- CLI ;
- Python adapter ;
- webhook ;
- n8n.

## Contrat

Chaque Provider déclare :
- capabilities ;
- transport ;
- input/output schemas ;
- secrets requis ;
- health check ;
- timeouts ;
- side effects ;
- risk hints ;
- version.

Les runners génériques exécutent les manifests lorsque possible. Un adapter spécifique est autorisé seulement si le protocole ne peut pas être décrit génériquement.

## Sécurité

Docker/CLI non fiables s'exécutent en sandbox, avec secrets minimaux et filesystem/network limités.
