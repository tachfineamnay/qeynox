# Security & Risk Policy — Préprod

**Date : 2026-10-03**


## Isolation

- `organization_id` obligatoire ;
- `project_id` obligatoire ;
- Row Level Security recommandée ;
- storage préfixé par org/projet ;
- aucune donnée tenant dans le repo source.

## Secrets

- jamais dans Git ;
- jamais dans les prompts ;
- jamais dans les logs ;
- injectés au dernier moment ;
- uniquement secrets nécessaires au provider ;
- rotation possible sans redeploy du Core.

## Classes de risque

### R0
Lecture pure.
Exemples : fetch repo, read analytics.

### R1
Production locale/draft sans side effect externe.
Exemples : génération document, patch local.

### R2
Action réversible et isolée.
Exemples : branche, PR, draft CMS.

### R3
Publication ou écriture externe.
Exemples : publier une page, modifier CRM.

### R4
Production critique, dépense ou envoi massif.
Exemples : deploy prod, activer Ads, email massif.

## Approval policy

- R0 : auto ;
- R1 : auto par défaut ;
- R2 : configurable ;
- R3 : approval obligatoire ;
- R4 : approval forte + contexte complet + confirmation explicite.

## Sandbox

Docker/CLI/code non fiable :
- filesystem ephemeral ;
- workspace explicitement writable ;
- pas de Docker socket hôte ;
- network deny-by-default si possible ;
- CPU/RAM/time limits ;
- secrets scoped ;
- logs filtrés.

## Audit

Toute action R2+ conserve :
- actor ;
- time ;
- target ;
- input digest ;
- provider ;
- trace ;
- evidence ;
- résultat ;
- rollback status.
