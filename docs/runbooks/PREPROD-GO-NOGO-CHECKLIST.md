# QeyNox V2 — Préprod GO / NO-GO

**Date : 2026-10-03**


## Architecture
- [ ] ADR-001 à ADR-005 présents et acceptés.
- [ ] aucun provider spécifique dans le Domain Core.
- [ ] Hatchet unique orchestrateur durable.
- [ ] PostgreSQL source de vérité métier.

## Données
- [ ] migrations reproductibles.
- [ ] ArtifactVersion immuable.
- [ ] lineage complète.
- [ ] isolation tenant validée.

## Providers
- [ ] au moins 4 transports validés : HTTP, MCP, Docker, CLI.
- [ ] certification tool opérationnelle.
- [ ] provider health visible.
- [ ] fallback testé.

## Execution
- [ ] risk R0-R4 actif.
- [ ] approvals R3/R4 obligatoires.
- [ ] idempotency.
- [ ] evidence.
- [ ] rollback.

## Ops
- [ ] backups.
- [ ] restore test.
- [ ] health endpoints.
- [ ] traces OTel.
- [ ] alerting.
- [ ] kill switch.

## Sécurité
- [ ] aucune clé dans Git.
- [ ] secrets scoped.
- [ ] sandbox.
- [ ] logs nettoyés.
- [ ] permissions minimales.

## Produit
- [ ] regenerate 1 clic.
- [ ] feedback libre.
- [ ] historique versions.
- [ ] checklist/prompt/execution disponibles selon permissions.

## Verdict

**GO** uniquement si tous les P0 sont verts.  
Un seul P0 rouge = **NO-GO**.
