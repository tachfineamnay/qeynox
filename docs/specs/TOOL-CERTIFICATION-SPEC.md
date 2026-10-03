# Provider / Tool Certification

**Date : 2026-10-03**


## États

`unverified → discovered → tested → verified → degraded → disabled`

## Certification minimale

1. manifest valide ;
2. version pinée ;
3. capability mapping valide ;
4. schemas d'entrée/sortie valides ;
5. secrets déclarés ;
6. health check ;
7. timeout ;
8. smoke test ;
9. test d'erreur ;
10. normalisation output ;
11. policy de risque ;
12. sandbox si CLI/Docker.

## Critères supplémentaires pour outils mutateurs

- idempotency prouvée ;
- rollback défini ;
- evidence produite ;
- action testable en environnement non-production ;
- permissions minimales.

## Provider health

Le resolver ne sélectionne pas un provider :
- `disabled`
- `degraded` si policy stricte
- credentials invalides
- health check en échec au-delà du seuil.

## Ajout sans code

Acceptable lorsque l'outil peut être entièrement décrit par :
- OpenAPI ;
- HTTP manifest ;
- MCP tool mapping ;
- Docker command manifest ;
- CLI command manifest.

Sinon créer un adapter isolé avec contract tests.
