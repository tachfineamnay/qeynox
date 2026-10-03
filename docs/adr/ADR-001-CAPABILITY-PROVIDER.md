# ADR-001 — Capability-driven / Provider-agnostic

**Date : 2026-10-03**


**Statut : ACCEPTÉ**

## Décision

Les workflows et le Core QeyNox expriment des besoins sous forme de `Capabilities`. Ils ne référencent jamais directement un outil concret.

```text
Workflow → Capability → Resolver → Provider
```

## Conséquences

- ajout d'un provider sans modification du Domain Core ;
- remplacement d'un provider sans modifier les workflows ;
- fallback possible ;
- sélection par coût, santé, priorité, sécurité ou tenant ;
- tests contractuels communs.

## Interdit

```python
if provider == "outil-x":
    ...
```

dans le domaine, l'application layer ou les workflows métier.

Les particularités fournisseur vivent uniquement dans `providers/` ou `connectors/`.
