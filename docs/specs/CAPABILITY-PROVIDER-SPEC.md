# Capability & Provider Specification

**Date : 2026-10-03**


## Capability ID

Format recommandé :

```text
<domain>.<resource>.<verb>
```

Exemples :
- `repo.read`
- `repo.branch.create`
- `repo.pr.create`
- `crawl.site`
- `seo.audit.technical`
- `geo.visibility.measure`
- `cms.page.publish`
- `ads.campaign.create_draft`
- `deploy.staging`

## Capability contract

Chaque capability définit :
- `id`
- `version`
- `input_schema`
- `output_schema`
- `default_risk`
- `side_effect`
- `idempotency_required`

## Provider manifest

Chaque provider définit :
- identité/version ;
- capabilities ;
- transport ;
- configuration ;
- secrets ;
- health check ;
- operation mapping ;
- limits ;
- certification.

## Resolver

Filtrage obligatoire :
1. provider enabled ;
2. capability supportée ;
3. version compatible ;
4. health OK ;
5. credentials disponibles ;
6. tenant autorisé ;
7. policy risque autorisée ;
8. budget/rate limit compatibles.

Scoring recommandé :
- priorité explicite ;
- coût ;
- latence ;
- fiabilité ;
- qualité ;
- data residency ;
- préférence tenant.

## Fallback

Un fallback est possible uniquement si :
- output contract identique ;
- side-effect semantics compatibles ;
- idempotency préservée.

Une action mutante ne doit jamais fallback vers un provider différent si cela peut créer un double side effect sans garantie d'idempotence.
