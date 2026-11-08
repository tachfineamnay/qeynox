# docs/beta50 — Socle de livraison BETA50

Ce dossier est le **contrat de référence** de la bêta BETA50 de QeyNox. Il décrit ce qui est
livré, ce qui reste interne, les flags, les surfaces et les preuves d'acceptation.

| Fichier | Rôle |
|---|---|
| [`BETA50_CONTRACT.md`](BETA50_CONTRACT.md) | Contrat lisible : périmètre IN/OUT, surfaces, flags, sécurité, contradictions, critères de sortie |
| [`BETA50_CONTRACT.json`](BETA50_CONTRACT.json) | Contrat machine (source de vérité) : features, APIs, UI, flags, outils MCP, contradictions, commandes d'acceptation |
| [`BETA50_ACCEPTANCE.md`](BETA50_ACCEPTANCE.md) | Plan d'acceptation et résultats réels de la certification locale |

## Comment vérifier ce socle

```bash
# 1. Contrat ↔ code/UI/flags/MCP + parcours HTTP de bout en bout
python -m pytest -q tests/test_beta50_contract.py -v

# 2. Suite complète et qualité
python -m pytest -q
python -m ruff check .
python -m compileall -q engine tools web scripts core mcp_server.py qeynox.py
node --check web/static/app.js
python scripts/secret_guard.py
```

Le test `tests/test_beta50_contract.py` échoue si :

- une variable d'environnement lue par le code n'est pas déclarée dans le contrat (ou l'inverse) ;
- un flag opérateur n'est pas documenté dans `.env.example` ;
- un endpoint utilisé par l'UI n'est pas dans la matrice API ;
- une URL de l'UI est malformée sans stack sélectionné (`qs()` + `&` interdit) ;
- un outil MCP annoncé n'existe pas ;
- un fichier de preuve d'une feature a disparu ;
- une contradiction contractuelle passe au statut `open` ;
- le parcours onboarding → dossier → rapports → validation → mission → hook régresse ;
- `QEYNOX_LLM` n'est plus `none` par défaut.

## Périmètre en une phrase

BETA50 = **V1.5 utilisable de bout en bout** (web + CLI + API + MCP + boucles + Docker) avec
un **Domain Core V2 interne** déjà présent mais non exposé.
