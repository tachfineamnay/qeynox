# MISSION A13 — Service catalogue and customer ordering

**Status: implemented and verified against isolated infrastructure. Not merged; draft PR only.**
This note records what was built, what it refuses to do, and exactly what was verified — and what was
not.

## What shipped

```
Operator service bundle (infra/operator/a03-economic-research.json)
  └── applied once by the operator through the existing platform configuration flow
        (POST /v1/platform/configuration/{preview,apply}, validated, audited, ACTIVE-gated)
Customer-facing catalogue                     [NEW: Web /[lang]/services]
  → Service detail                            [NEW: Web /[lang]/services/[offerId]]
  → Typed request form (World Bank)           [NEW: envelope world-bank-economic-research@1]
  → Request → operation + bounded plan         [NEW API: POST /v1/services/:offerId/requests]
  → Plan review, quote, acceptance             [existing flow, unchanged]
  → AUTHORIZED (free offers) or PAYMENT_REQUIRED
```

### Source of truth: configuration, never code

Services are **RaaS offers** applied by the operator, not entries in a static catalogue. The
deployment reads ACTIVE offers at request time and joins them with the real capability availability
projection (`capabilityAvailability`) and the deployment's registered request contracts. A service
exists on the customer surface only because an operator published it; there is no seed, fixture, or
checked-in example that would appear without configuration.

### The request contract registry (`packages/application/src/service-contracts.ts`)

- `ServiceRequestContract` — one implementation per orderable service. Key is stable and versioned;
  `capabilityIds` must match the offer's capability set exactly.
- `ServiceContractRegistry` + `resolveContract` — fail closed: an offer with no registered contract,
  or a contract whose capability set disagrees with the offer, is `SERVICE_NOT_CONFIGURED` and can
  never be ordered. There is no generic order form.
- `parseWorldBankServiceConfig` — strict parse of the `service` section of an operator service file
  (budget policy id, allowlisted countries/indicators, observation ceiling). Malformed ⇒ the A03
  contract is not registered at all; the offer may still be listed with availability, never ordered.
- Adding a future service = a new envelope member in `@qeynox/contracts` + one contract
  implementation + one registry entry. Pages never widen.

### Catalogue read model (`packages/application/src/service-catalogue.ts`)

`ServiceCatalogueService` (one implementation, consumed by both Web and the API):
- lists ACTIVE offers only; EXCLUDED/UNCONFIGURED/DISABLED offers never resolve (`detail()` → null →
  404);
- price, scope, exclusions, regions, locales, terms version and deliverable schema version are
  copied from the operator-published offer row — never normalized, defaulted or regenerated; a zero
  price without `isExplicitlyFree` is rendered as invalid; `taxPolicy` is surfaced as published;
- availability per offer is the worst of its linked capabilities' real
  `capabilityAvailability(...)` states, with named blockers (`PROVIDER_NOT_CONFIGURED`,
  `PROVIDER:<ref>`, `PROFILE_NOT_CONFIGURED`, `POLICY_NOT_CONFIGURED`, `RUNTIME_NOT_OPERATIONAL`,
  `CAPABILITY_NOT_CONFIGURED`);
- `deployment` for the World Bank contract echoes `QEYNOX_WORLD_BANK_ENABLED` and
  `QEYNOX_NETWORK_POLICY_ATTESTED` as **booleans, never values**;
- `requestable` = a contract is registered AND the offer's capabilities are ACTIVE. Execution
  readiness (`isExecutable`) is reported separately and independently; ordering prepares a plan and a
  quote — it never executes.

### API (`apps/api/src/services/`)

- `GET /v1/services`, `GET /v1/services/:offerId` — session-required; prices/scope are operator data.
- `POST /v1/services/:offerId/requests` — validates the envelope (discriminated union), re-checks the
  ownership of the offer, resolves the contract, refuses when not configured/not requestable, and
  delegates to the contract (`WorldBankResearchContract` → `EconomicResearchService.createPlan`).
  Nothing is quoted, accepted, charged or executed by this endpoint.
- Wiring: `QEYNOX_SERVICE_CATALOG_PATH=infra/operator/a03-economic-research.json` (or any operator
  service file). Unset/invalid ⇒ catalogue works, ordering fails closed with `SERVICE_NOT_CONFIGURED`.

### Web (`apps/web`)

- `/[lang]/services` — cards with real price (or explicit free / invalid zero), scope, regions,
  availability badge and named blockers, capability limits. Empty state is honest: services appear
  only after an operator publishes them.
- `/[lang]/services/[offerId]` — detail + typed request form (objective, country code, indicator,
  observation controls, ≤2 comparisons, optional interpretation step, note ≤500 chars — note is
  context, never an instruction). Submission lands on the mission workspace; the customer still
  reviews plan, quote and acceptance through the existing flow.
- Nav item "Services" (EN/FR). Forms are disabled and say why when the deployment cannot serve the
  service; the page states when ordering is possible but launch remains readiness-gated.

### Control (`apps/control`) — operator publishing workflow

Publishing remains the existing platform configuration flow (this is intentional: offers are
configuration, not a second write path). A13 adds to the Configuration console:
- scope, exclusions, terms/deliverable versions and linked capabilities in the offers table;
- **Validate a service definition** — read-only check of one offer + capability against the live
  configuration: ACTIVE capability, offer, tax treatment, verification policy (human review, approved
  providers, freshness), enabled provider, budget that can afford the plan, iteration basis read from
  the ACTIVE business profile (or explicitly "none", with iteration-dependent checks skipped and
  BUDGET checks still enforced). The platform API endpoint
  (`POST /v1/platform/configuration/validate-service`, platform `CONSULTATION`, audited) is the same
  validator the operator QA exercises. Nothing is created, modified or activated.

## Verification (disposable PostgreSQL, never production)

- `pnpm typecheck` clean (4/4); `pnpm --filter @qeynox/web build` and `pnpm --filter @qeynox/control build` clean.
- `pnpm qa:service-catalogue` (new) — **63 assertions PASS** against a disposable PostgreSQL created
  and dropped by the harness itself:
  - PART 1 (pure): envelope accept/reject matrix (unknown discriminator, bounds, patterns), service
    config parsing (missing budget policy id, malformed indicator pattern), registry fail-closed
    behaviour (empty registry, null registry, capability-set mismatch).
  - PART 2 (isolated DB): empty catalogue before publish; apply of the reviewed A03 operator bundle;
    listed offer carries scope/exclusions/terms/regions/locales verbatim, free-price and
    tax-configured flags, named blockers without an attested runtime (`RUNTIME_NOT_OPERATIONAL`),
    `SERVICE_NOT_CONFIGURED` without a contract; with an attested runtime and registered contract:
    `requestable`, deployment probe booleans, request → operation READY + single-step plan, member
    still workspace-scoped, outsider 404; quote carries the configured price (0), acceptance
    AUTHORIZES the free offer; validator healthy, and `maximumIterations: null` skips
    iteration-dependent checks without inventing a basis.
- Regression: `qa:a03-service` — PART 1 49/49, then BLOCKED at the live provider step (TLS
  unreachable in this environment), zero-fixture substitution; the A13 changes to the shared
  validator are covered by the 82 assertions before the block. Pre-existing `qa:backend` failure
  remains untouched and was not chased.
- Live provider leg is **BLOCKED** here (World Bank TLS); no claim of live verification is made.

**NOT executed:** a real browser pass over the services pages (no installable Chromium system
libraries in this sandbox); the interactive form path is covered by build + typecheck + the HTTP
contract it calls, not by UI automation. The Control validation form calls the audited,
permission-checked endpoint; its end-to-end permission matrix is covered by the existing
platform-configuration suite, not by a new Control HTTP suite in this PR.

## Operator dependencies (unchanged fail-closed posture)

A customer sees and can order the World Bank service only after an operator (1) applies
`infra/operator/a03-economic-research.json` through the platform configuration flow, (2) sets
`QEYNOX_SERVICE_CATALOG_PATH` to that file on the API deployment, (3) enables the provider
(`QEYNOX_WORLD_BANK_ENABLED=true` with attested egress) and (4) attests the runtime for execution
readiness. Any missing step yields an honestly blocked service — listed with named blockers, or not
listed, never fake-available.
