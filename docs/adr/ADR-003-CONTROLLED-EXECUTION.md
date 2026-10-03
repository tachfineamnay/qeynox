# ADR-003 — Controlled Execution

**Date : 2026-10-03**


**Statut : ACCEPTÉ**

## Décision

Production de contenu et side effect externe sont séparés.

```text
Artifact → ExecutionSpec → Policy → ExecutionRun → Evidence → Outcome
```

QeyNox peut offrir :
- checklist ;
- prompt ;
- patch/draft ;
- PR/staging ;
- action externe réelle.

## Risque

- R0 lecture ;
- R1 draft/local ;
- R2 branche/PR ou action facilement réversible ;
- R3 publication/écriture externe ;
- R4 production, dépense, envoi massif ou opération sensible.

R3/R4 nécessitent une policy d'approbation explicite.
