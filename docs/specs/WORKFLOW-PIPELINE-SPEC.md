# Workflow / Pipeline Specification

**Date : 2026-10-03**


## Principe

Un workflow compose des capabilities, jamais des providers.

## Types de nœuds

- `job`
- `approval`
- `condition`
- `fanout`
- `join`
- `wait_event`
- `execution`
- `measure`

## Exemple

```text
market.research
   ├── keyword.discover
   └── competitor.analyze
          ↓
       strategy.generate
          ↓
        approval
          ↓
       landing.generate
          ↓
       execution.prepare
```

## Versioning

Un workflow publié est immuable.

Toute modification incompatible crée une nouvelle version :
- `product-launch:v1`
- `product-launch:v2`

Les runs existants continuent sur la version d'origine.

## Idempotence

Chaque nœud mutateur doit posséder une clé d'idempotence ou un mécanisme de déduplication.

## Retry

Le retry est défini au niveau du nœud :
- max attempts ;
- backoff ;
- retryable errors ;
- timeout.

## Regeneration

La régénération d'un Artifact n'impose pas le replay du DAG complet. Le système relance le nœud producteur et uniquement les dépendances explicitement sélectionnées.
