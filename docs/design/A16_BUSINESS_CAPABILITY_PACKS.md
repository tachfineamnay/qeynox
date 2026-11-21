# Mission A16 — Eight Business Capability Packs

## Purpose

Mission A16 populates all eight configurable capability slots (`1..8`) with distinct, operator-editable,
Results-as-a-Service (RaaS) business service packs — never generic chatbots and never simulated
third-party integrations.

Each pack pairs:
1. **Typed customer input contract** (`packages/contracts/src/business-packs.ts`) — domain-specific
   fields, bounds, enums, and allowlists enforced on both Web and API.
2. **Structured deliverable output contract** (`*DeliverableSchema` + `validatePackDeliverable` in
   `packages/application/src/business-pack-deliverables.ts`) — separating provider-observed facts
   from caller-supplied assumptions and analytical synthesis, with anti-fabrication guards.
3. **Bounded multi-step DAG planning template** (`packages/application/src/business-packs.ts`) —
   explicit `dependsOnIndices`, parallel fan-in where appropriate, strict `maximumSteps` and
   `maximumToolCalls` checks that fail closed rather than truncating, and zero unreviewed
   `EXTERNAL_ACTION` steps.
4. **Operator-editable profiles & specialization** (`infra/operator/packs/01-research.json` ..
   `08-content.json` and `infra/operator/a16-business-packs.json`) — operators edit capability
   `name`/`purpose`, agent `title`/`systemInstructions`, RaaS offer `label`/`scope`/`amountMinor`,
   and service `displayName`/`specialization`/allowlists/ceilings without code changes.
5. **Verification, budget, and approval policies** — explicit `humanReviewRequired: true`, approved
   provider lists, minor-unit rate cards, and consent-scope enforcement (`web:search` whenever query
   terms leave the deployment to Brave Search).
6. **Honest configuration & external-connector state** — real reviewed adapters (`world-bank` and
   `brave-search`) execute only when enabled and attested; unavailable third-party connectors
   (`search-console`, `ga4`, `meta`, `linkedin`, `wordpress-woocommerce`, `google-workspace`,
   `stripe`, `github`) are explicitly disclosed as `BLOCKED` on API and Web surfaces.

## Eight Business Service Packs

| Slot | Domain | Contract Key | Reviewed Tool | Key Domain Guarantees | Disclosed `BLOCKED` Connectors |
| --- | --- | --- | --- | --- | --- |
| 1 | `research` | `research-pack@1` | `world-bank:indicator@1` | Parallel primary + comparison + benchmark series fan-in; preserves `null` observations and publication-lag disclosures | none |
| 2 | `strategy` | `strategy-pack@1` | `brave-search:web@1` | Parallel market + competitor research fan-in; isolates unverified beliefs in `assumptionsRequiringValidation` | `google-workspace` |
| 3 | `marketing` | `marketing-pack@1` | `brave-search:web@1` | Channel budget share must sum to 100%; requires per-channel hypothesis & kill criterion; rejects guaranteed-ROI claims | `meta`, `ga4`, `linkedin` |
| 4 | `seo` | `seo-pack@1` | `brave-search:web@1` | Enforces domain hostname ownership on `auditedUrls`; tags `SERP_OBSERVED` vs `CALLER_REPORTED`; rejects ranking guarantees | `search-console`, `ga4` |
| 5 | `sales` | `sales-pack@1` | `brave-search:web@1` | MEDDPICC/SPICED account briefs; rejects personal email addresses & phone numbers on both input and deliverable | `linkedin`, `google-workspace` |
| 6 | `operations` | `operations-pack@1` | `brave-search:web@1` | Deterministic `computeProcessDiagnostics` cycle-time sum, SLA gap & bottleneck ranking; sequential RACI SOP + control gates | `google-workspace`, `github` |
| 7 | `financial-analysis` | `financial-analysis-pack@1` | `world-bank:indicator@1` | Deterministic `computeFinancialSensitivity` gross profit, burn, runway & CAC payback reconciled to minor units; non-advisory governance | `stripe` |
| 8 | `content` | `content-pack@1` | `brave-search:web@1` | Bilingual EN/FR editorial brief + optional full draft; mandatory `claimCitationLedger` bound to captured URIs | `wordpress-woocommerce`, `linkedin` |

## API, Web, and Control Surfaces

- **API (`apps/api/src/services/`)**:
  - `QEYNOX_SERVICE_CATALOG_PATH` accepts legacy single-service files (`a03-economic-research.json`),
    individual pack files (`infra/operator/packs/0X-*.json`), multi-pack suites
    (`infra/operator/a16-business-packs.json`), or comma-separated paths.
  - `GET /v1/services` & `GET /v1/services/:offerId` surface `packDomain`, `displayName`,
    `specialization`, `contractMeta`, boolean-only `deployment` switches, and
    `unavailableExternalConnectors`.
  - `POST /v1/services/:offerId/preview` computes the bounded plan DAG, warnings, fingerprint, and
    deterministic metrics without persisting database state.
  - `POST /v1/services/:offerId/requests` creates the workspace-scoped operation and bounded plan
    revision in `READY`, preserving commercial quote/payment/approval gates.
- **Customer Web (`apps/web`)**:
  - Localized EN/FR service cards and detail views (`/[lang]/services`, `/[lang]/services/[offerId]`)
    built on Professional Blue `--qx-*` tokens.
  - Dynamic domain-specific request forms (`ServiceRequestForm`) driven by `contractMeta` allowlists
    and ceilings.
- **Control Console (`apps/control`)**:
  - `ServiceValidationForm` supports validating both `world-bank` and `brave-search` service packs,
    including `CAPABILITY_MISSING_CONSENT_SCOPE` checks.

## Verification

Run against an isolated disposable QA database:

```bash
pnpm typecheck
pnpm build
pnpm qa:business-packs
```
