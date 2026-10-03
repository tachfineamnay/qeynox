# Préprod — Test & Acceptance Plan

**Date : 2026-10-03**


## P0 — Bloquants

### Domaine
- [ ] ArtifactVersion immuable.
- [ ] Approval liée à une version exacte.
- [ ] Regenerate crée JobRun + ArtifactVersion distincts.
- [ ] Anciennes versions restent accessibles.

### Capability / Provider
- [ ] Ajout d'un provider sans modification du Domain Core.
- [ ] Remplacement provider sans modification du workflow.
- [ ] Fallback lecture testé.
- [ ] Provider down ne produit jamais un faux succès.

### Hatchet
- [ ] DAG fonctionne.
- [ ] retry/backoff fonctionne.
- [ ] worker restart ne perd pas le run.
- [ ] durable approval wait fonctionne.
- [ ] cancel fonctionne.
- [ ] schedule/event fonctionne.

### Tool Fabric
- [ ] provider HTTP testé.
- [ ] provider MCP testé.
- [ ] provider Docker testé.
- [ ] provider CLI testé.
- [ ] outputs normalisés.

### Execution
- [ ] ExecutionSpec séparé de l'Artifact.
- [ ] R3/R4 bloqués sans approval.
- [ ] idempotency testée.
- [ ] evidence générée.
- [ ] rollback R2/R3 simulé.

### Sécurité
- [ ] isolation org/projet.
- [ ] secrets absents logs/Git.
- [ ] sandbox sans accès non autorisé.
- [ ] permissions provider minimales.

### Observabilité
- [ ] trace unique API → workflow → provider → artifact/execution.
- [ ] métriques runtime visibles.
- [ ] coût LLM/provider enregistré.

## P1 — Requis avant production

- [ ] backup/restauration.
- [ ] load test.
- [ ] provider certification UI/admin.
- [ ] stale dependency propagation.
- [ ] rate limits par tenant.
- [ ] webhook retry/dead letter.
- [ ] incident drill.

## Scénario E2E de référence

1. créer projet ;
2. connecter repo lecture ;
3. lancer research ;
4. générer Artifact ;
5. demander régénération avec prompt ;
6. approuver v2 ;
7. créer ExecutionSpec R2 ;
8. exécuter via provider ;
9. récupérer evidence ;
10. provoquer provider failure ;
11. vérifier fallback/retry ;
12. redémarrer worker pendant workflow ;
13. vérifier reprise ;
14. contrôler traces et coûts.
