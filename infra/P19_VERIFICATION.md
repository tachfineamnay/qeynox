# P19 — business-provider integration verification (2026-11-22)

Branch `arena/25933fe7-qeynox`; starting HEAD and fetched `origin/main` both
`230d6bbbc46e3253b4ebb0c332185ab6fca53dae`. `AGENTS.md` read before implementation.

**Verdict: missing runtime/configuration integration implemented; minimal compilation passes.
No live-provider, database, network-isolation or business-flow certification.**

## Inspection and implementation

Inspected the eight individual A16 pack bundles plus suite, typed contracts/plan builders,
P09 pack execution/citation validation, ToolBroker, existing World Bank/Brave adapters and secure
transport, registry/configuration, hub/identity OAuth, capability/provider readiness, catalogue,
PlanRead/Pilot and workspace/beta budget path. Exact requirements and remaining connector boundaries:
[BUSINESS_PROVIDERS_RELEASE.md](BUSINESS_PROVIDERS_RELEASE.md).

| Requirement | Source implementation / honest boundary |
| --- | --- |
| Runtime registration/resolution | Shared per-provider resolver used by readiness/API launch/Worker and last broker authorization; partial fail-closed runtime registry, strict legacy builder preserved. Only existing reviewed WB/Brave v1 adapters. Fixed exact A16 operation alias mismatch without rewriting configuration rows. Actual input schemas supplied as proposal guidance; strict fields reject silently ignored provider input keys. |
| Operator credentials/status | Existing audited config + backend secret-managed Brave key; no secret in DB/response/prompt, arbitrary credential reference not resolved. New OPERATIONS-protected `/v1/platform/providers` and authenticated hub `/v1/connections/business-providers` are no-store, configuration-only reads, not activation/probe endpoints. Role examples/release egress checks updated; defaults remain off. |
| Catalogue/Pilot readiness | No ACTIVE-row-only readiness. Exact adapter/version/switch/key/egress/shared-quota config and compatible profile/policy are checked; additive providerStatus/providerBlockers propagate through catalogue, PlanRead, Pilot prompt/notes/cache and client parsers. Configured is explicitly NOT live verified. |
| Permissions/cost ceilings | Tenant/membership/operation/revision/attempt/profile/capability/consent authority retained and re-read after quota/ledger waits. Pack tool selection fixed to the reviewed contract. Per-provider finite ceilings preflight at launch/run/readiness; Brave needs positive reserved ceiling. Existing atomic operation/beta reservation and ESTIMATED/UNKNOWN settlement retained; no provider price or FX invented. |
| Source metadata/digests | Canonical request/response digest contract preserved; separate UTF-8 provider-response-text SHA-256 and retrieval/freshness notes retained in tool ledger. Actual returned Brave page URLs/titles become citable, deduplicated metadata sources bound to response digest, not fabricated fetched page content. Snapshots/evidence remain scoped and UNVERIFIED. Publication time not invented from snippet age. |
| Timeout/rate/unavailability | Existing shared Redis quota retained. Broker hard race and transport overall deadline cover authority/invocation and DNS/connect/body respectively. No redirects/public-IP guard bypass; response caps preserved. Consistent safe auth/429/5xx/malformed/no-observation failures, no raw network error text or automatic paid retries. |
| Honest missing connectors | Unknown/unimplemented/inactive providers resolve no tools and expose BLOCKED reasons. Existing GA4/Search Console/Meta/LinkedIn/CMS/Stripe/business Workspace/GitHub limitations retained. Google hub CONNECTED identity is not a business adapter. No test/product fallback or speculative provider. |
| Correct pack selection | Research and financial-analysis -> WB indicator; strategy, marketing, SEO, sales, operations and content -> Brave web. Planning/Worker reject substitutions/broader pack tool contracts. Fixed SEO/content prompt field names and SEO language-vs-country parameter mismatch without altering stored request fingerprints. |
| No invented success | Empty Brave/all-null WB responses refuse evidence creation; WB rejects wrong country/indicator. Search snippets explicitly not page-fetch/verification evidence. No provider becomes LIVE_VERIFIED from flags or compilation. Existing deliverable validation/claims/human-review boundaries preserved. |
| External WRITE | Runtime resolver exposes READ_ONLY tools only. Existing ToolBroker write approvals preserved; no browser/MCP/generic HTTP bypass, OAuth scope expansion, ad/publishing/mailbox/CRM/payment write or scheduler added. |

## Executed local checks — minimal compilation only

| Command/check | Result |
| --- | --- |
| `corepack prepare pnpm@9.15.9 --activate`, `pnpm install --frozen-lockfile` | PASS, no dependency/lockfile changes |
| `pnpm typecheck` | **PASS: 6 tasks plus dedicated release-tool TypeScript check**, including changed API/Worker/shared source/client parsers/QA fixture source |
| `git diff --check` | PASS |
| Dependency/DB migration diff | Unchanged |

Initial compilation caught missing optional Pilot fields and a readonly-vs-mutable view projection;
fixed directly with typed fields/copies. Final typecheck passed. No suppression, `any` escape, removed
assertion or disabled test used to force success. Existing Brave positive-path fixture now supplies
an explicit paid-search ceiling; added focused source assertions for zero-ceiling denial, returned-page
citations and raw response digest. **These tests were compiled but NOT EXECUTED.**

As requested, **no QA suites, production builds, dev servers, browser smoke runs, Docker builds,
live/provider probes or external certification** were run. Compilation is not behavioral evidence.

## Deferred / external gates

- P22: real WB/Brave entitlement/terms/attribution, response shapes, locale/clock/availability behavior,
  actual subscription token validity and secret/egress isolation. No claim of successful provider calls.
- P22: registration/deactivation/revocation races, strict input/schema guidance, all eight pack journeys,
  honest empty/no-data/error outcomes, snippets/citation/digest linkage, tenant isolation and human review.
- P22: Redis quota/concurrency/outage, provider 429/auth/slow DNS/body/abort recovery and bounded retries,
  operation/beta ceilings and uncertain cost retention. Readiness is configuration-only for providers;
  legacy overall OPERATIONAL runtime status is not a provider-certification stamp.
- No DB connection/config apply/migration, credential read/change/rotation, OAuth exchange/refresh,
  object/provider mutation, deployment/restart/rollback or Stripe activation in this mission.
- No architecture decision, storage/encryption/KMS/volume, financial history, commerce posture or UI
  design changes. No use of `iasser`; no new connector. Commit/PR creation authorized; merge not authorized.

Operational/configuration contract and rollout caveats:
[BUSINESS_PROVIDERS_RELEASE.md](BUSINESS_PROVIDERS_RELEASE.md).
