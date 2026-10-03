# Incident & Rollback Runbook

**Date : 2026-10-03**


## Priorités

P0 : perte de données, fuite secret, side effect production non autorisé.  
P1 : workflows bloqués, execution incorrecte mais réversible.  
P2 : provider dégradé, erreurs non bloquantes.

## Kill switches

Prévoir :
- global execution freeze ;
- freeze R3/R4 ;
- disable provider ;
- disable workflow version ;
- disable tenant/project execution.

## Incident provider

1. passer provider `degraded` ou `disabled` ;
2. stopper nouveaux runs ;
3. conserver runs en attente ;
4. activer fallback uniquement si side-effect safe ;
5. ouvrir incident ;
6. recertifier avant réactivation.

## Incident execution

1. suspendre la capability ;
2. collecter evidence ;
3. appliquer rollback strategy ;
4. marquer outcome ;
5. conserver lineage complète ;
6. aucune suppression d'historique.

## Incident secret

1. désactiver provider ;
2. rotation credential ;
3. rechercher usage dans traces/logs ;
4. invalider bindings affectés ;
5. recertifier.
