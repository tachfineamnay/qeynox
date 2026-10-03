# ADR-002 — Artifacts immuables et régénérables

**Date : 2026-10-03**


**Statut : ACCEPTÉ**

## Décision

Tout Artifact est immuable, versionné et régénérable. Une régénération crée :

1. un nouveau `JobRun` ;
2. un nouveau `ArtifactVersion` ;
3. une nouvelle lineage.

L'utilisateur peut régénérer avec :
- aucune instruction ;
- une instruction en langage naturel ;
- un contexte actualisé ;
- une autre policy de modèle/provider.

## Invariant

Une approval porte sur une version exacte. Une version régénérée revient à `pending`.

## Dépendances

Si un Artifact amont change, les Artifacts dépendants peuvent être marqués `stale`, sans être automatiquement détruits ou remplacés.
