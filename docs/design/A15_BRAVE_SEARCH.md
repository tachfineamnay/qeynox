# MISSION A15 (first increment) — licensed web search adapter (Brave)

**Status: implemented and verified against isolated infrastructure only. Draft PR; not merged.**
This note records what was built, what it refuses to do, and exactly what was verified — and what was
not. MISSION A15 spans several provider families; this increment ships the **highest-priority,
fully implemented** one: a licensed web search/research provider. The remaining families (Google
Workspace, WordPress/WooCommerce, GitHub/GitLab, Meta/LinkedIn) are separate increments.

## What shipped

```
Business capability "Licensed web research"              [operator bundle infra/operator/a15-web-research.json]
  → TOOL 'brave-search' v1, READ_ONLY, operator-tightened rate limit
  → AGENT_PROFILE "Web research analyst" + VERIFICATION_POLICY (approvedProviders: brave-search)
  → NO RAAS_OFFER and NO BUDGET_POLICY (internal capability; spend must be approved explicitly)
createConfiguredToolRegistry()                           [triple-gated, fail-closed]
  → ACTIVE operator TOOL configuration  + QEYNOX_BRAVE_SEARCH_ENABLED=true
  + QEYNOX_BRAVE_SEARCH_API_KEY set     + attested egress allowlisting api.search.brave.com
  → ENABLE switch off, missing token or un-allowlisted host ⇒ NOT_CONFIGURED / DENIED
ToolBroker invocation                                    [packages/tools]
  → permission (profile/capability allowlist, consent scope web:search, remaining calls)
  → budget reservation, rate limit, ledger reserve/complete with request/response digests
  → provenance: provider "brave-search", sourceUri (the documented endpoint + query), retrievedAt
BraveSearchConnector                                     [packages/tools/src/providers/brave-search.ts]
  → zod-typed input (query, count ≤ 20, offset ≤ 9, safesearch, country, searchLang, freshness)
  → HTTPS via secureProviderRequest: pinned validated IP, no redirects, byte/time caps
  → X-Subscription-Token header only — never in the URL, never logged
  → typed mapping of 401/403 → NOT_CONFIGURED, 429 → BUDGET_EXHAUSTED, 5xx → UNAVAILABLE, malformed
    payload → INVALID_STATE
```

## The licensed provider (and the honesty boundary)

The adapter speaks the documented Brave Search API (`GET https://api.search.brave.com/res/v1/web/search`,
auth header `X-Subscription-Token`). Brave Search is a **commercial** service: an operator must hold an
active plan (as of 2026-11 the Search plan is priced per thousand requests with a small monthly free
credit; pricing is the provider's to change) and comply with the Brave Search API Terms of Service,
including any attribution and re-publication restrictions applicable to that plan tier. Query text
leaves this deployment to Brave and is therefore consent-gated (`web:search`).

This adapter is **not verified against the live provider in this environment**: no subscription token
was ever available here and the sandbox refuses the connection (TLS unreachable). All integration
evidence below is against an in-process loopback fake — the only double permitted, never a product
fallback. A live read remains a deployment gate: one successful provider call must be recorded
(`sourceUri` + digests) after an operator configures the token.

Pagination ceiling: Brave documents that deep offsets are not supported; `offset` is capped at 9 and
`count` at 20. The adapter refuses rather than fakes deeper pages.

## What was verified (2026-11-20, branch `arena/5c2dfdf2-qeynox`, off main `d2c8d2b`)

`pnpm qa:brave-search` → **57 assertions PASS**, disposable PostgreSQL (created/dropped by the
harness), never production:

- PART 1 (contracts, 23): real connector zod contracts — defaults, normalization, every malformed
  variant rejected (query bounds, count/offset ceilings, safesearch enum, country/searchLang grammar,
  `pd|pw|pm|py`/date-range freshness); output contract; reviewed manifest invariants; `validateBundle`
  enforces READ_ONLY consistency.
- PART 2 (registry + broker, 34): operator bundle applies cleanly; `createConfiguredToolRegistry`
  fails closed with ENABLE switch off, with the token missing, and with the provider host not
  allowlisted; ACTIVE configuration registers `web@1` read-only with the `web:search` scope;
  operator-tightened rate ceiling (10/min) replaces the reviewed one; broker end-to-end invoke
  through the loopback fake — consent `web:search` required, results normalized (`page_age` → `age`,
  publisher `profile.name` → `source`), header token observed on the wire, provenance digests,
  ledger COMPLETED; guards: missing consent → DENIED, tool outside profile → DENIED, zero remaining
  calls → DENIED, capability mismatch → DENIED, replayed intentId → CONFLICT; provider failure
  mapping 401/429/500/malformed/wrong-shape; adapter recovers after transient failures; egress
  assertion fires inside `invoke` when the host is not allowlisted.

Cross-checks: `pnpm typecheck` 4/4 clean; `qa:connector-hub` 79 assertions PASS (A14 untouched);
`qa:connectors` proceeds through operator configuration and fails only at the pre-existing live
World Bank leg (TLS BLOCKED in this sandbox — not a regression; World Bank live reads remain BLOCKED).

## Operator activation (what an operator must do)

1. Subscribe to a Brave Search API plan; keep the subscription token server-side only.
2. `QEYNOX_BRAVE_SEARCH_API_KEY=<token>`, `QEYNOX_BRAVE_SEARCH_ENABLED=true`.
3. `QEYNOX_NETWORK_POLICY_ATTESTED=true`, `QEYNOX_EGRESS_ALLOWED_HOSTS=api.search.brave.com`.
4. Apply `infra/operator/a15-web-research.json` (internal capability; no offer, no spend authorization).
5. Grant consent scope `web:search` to executing members.
6. Approve spend explicitly: map `brave-search:web@1` in the workspace `unitMaxMinor` budget policy
   (e.g. upper bound 1 minor unit per call) — until then the executor path fails closed.
7. Record one successful provider read (sourceUri + response digest) as evidence; only then set
   `infra/connectors.registry.json` state to ACTIVE. Until then it stays INACTIVE with the real
   blocker.

## Known limitations / not done

- No live provider call was made (no token; sandbox TLS BLOCKED). Licence terms per plan tier are an
  operator responsibility at subscription time.
- Only the anonymous web search endpoint ships. Answers/rich callback, local/POI, news, images and
  videos are separate reviewed surfaces — not implemented, by design.
- `qa:backend` remains pre-existing-failing and untouched. The full executor path (commerce accept →
  OperationExecutionService) was not wired because the capability deliberately ships no offer/budget.
- Proposed remaining A15 increments (separate PRs): Google Drive/Docs/Gmail/Search Console/GA4
  (consume the A14 credential resolver), WordPress/WooCommerce, GitHub/GitLab, Meta/LinkedIn
  documented operations only.
