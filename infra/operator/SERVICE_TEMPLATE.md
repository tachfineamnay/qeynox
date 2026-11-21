# Reusable RaaS service template

A QeyNox business service is six operator configuration records plus two deployment switches.
This template is the pattern behind `a03-economic-research.json`; it is deliberately provider-shaped
so a second service copies the structure, never the data.

## The six records

| # | Domain | What it decides | What it must never do |
| --- | --- | --- | --- |
| 1 | `TOOL` | which reviewed connector is ACTIVE and at what tightened rate limit | invent a provider or widen a reviewed adapter |
| 2 | `BUSINESS_CAPABILITY` | the slot, its scope, `allowedTools`, and the plan ceilings | allow a tool no configuration enables |
| 3 | `AGENT_PROFILE` | how the agent is instructed, its output/iteration budget | permit browsing or an unmediated provider call |
| 4 | `VERIFICATION_POLICY` | which providers may support a claim, freshness, human review | set `humanReviewRequired:false` for agent findings |
| 5 | `RAAS_OFFER` | what the customer buys, its scope and exclusions | offer a capability it does not list |
| 6 | `BUDGET_POLICY` | money, engine calls, tool calls, duration, concurrency | set a ceiling that cannot finish one plan |

Plus two switches that are NOT configuration records:

- `QEYNOX_WORLD_BANK_ENABLED=true` — the deployment admits the reviewed adapter.
- `QEYNOX_NETWORK_POLICY_ATTESTED=true` + `QEYNOX_EGRESS_ALLOWED_HOSTS=api.worldbank.org` — attested
  egress. Neither is set by any script in this repository.

## Order matters

`TOOL` → `BUSINESS_CAPABILITY` → `AGENT_PROFILE` → `VERIFICATION_POLICY` → `RAAS_OFFER` →
`BUDGET_POLICY`. Each later record validates against the earlier ones, so applying them out of order
fails closed with a named reason.

## Validation before activation

```
pnpm --filter @qeynox/worker qa:a03-service     # configuration + request + plan validation
```

The validator reports every finding with a stable code and a remedy. It never repairs by guessing:
a repair is an operator edit to the JSON above.

Blockers it catches (each of these existed in `mission10-economic-research.json`):

| Code | Meaning |
| --- | --- |
| `TOOL_NOT_ENABLED` | the capability requires a tool no ACTIVE configuration exposes |
| `PROVIDER_NOT_CONFIGURED` | no ACTIVE configuration for the expected connector |
| `POLICY_MISSING` / `POLICY_NOT_EFFECTIVE` | no usable verification policy, or it has not started |
| `POLICY_PROVIDER_MISMATCH` | the policy approves a provider the capability does not use |
| `POLICY_PROVIDER_DISABLED` | the policy approves a provider that is not enabled |
| `OFFER_CAPABILITY_MISSING` | the offer does not cover the capability |
| `OFFER_FREE_UNAUTHORIZED` | zero price without `isExplicitlyFree` |
| `BUDGET_NO_ENGINE_RATE` | no `hermes` rate, so engine calls cannot be reserved |
| `BUDGET_BELOW_ONE_CALL` | the money ceiling cannot pay for a single engine call |
| `BUDGET_EXHAUSTS_MID_PLAN` | the ceiling buys fewer calls than the profile iteration ceiling |
| `BUDGET_RATE_UNKNOWN_TOOL` | the rate card prices a tool that is not enabled |

Warnings never block: `POLICY_SKIPS_HUMAN_REVIEW`, `POLICY_MAX_AGE_IMPLAUSIBLE`.

## The request contract

The service accepts an explicit objective, country, indicator and constraints — never a free prompt
that the model turns into a provider call:

```json
{
  "objective": "Assess how GDP per capita evolved in Morocco across the last three published years",
  "country": "MAR",
  "indicator": "NY.GDP.PCAP.CD",
  "constraints": {
    "mostRecent": 3,
    "minObservationYear": 2020,
    "compareIndicators": ["NY.GDP.MKTP.KD.ZG"],
    "includeInterpretation": true,
    "note": "Decision needed before the 2026 planning cycle"
  }
}
```

Validation rejects: an objective shorter than 20 characters, a malformed country/indicator code, a
value outside the operator allowlist, more than two comparisons, and any constraint that the
capability's own ceilings cannot satisfy.

## Eight shipped business capability packs (Mission A16)

Operators can activate individual packs (`infra/operator/packs/01-research.json` .. `08-content.json`)
or the full eight-slot suite (`infra/operator/a16-business-packs.json`):

| Slot | Pack | Contract Key | Reviewed Tool | Blocked External Connectors Disclosed |
| --- | --- | --- | --- | --- |
| 1 | `research` | `research-pack@1` | `world-bank:indicator@1` | none |
| 2 | `strategy` | `strategy-pack@1` | `brave-search:web@1` (`web:search`) | `google-workspace` |
| 3 | `marketing` | `marketing-pack@1` | `brave-search:web@1` (`web:search`) | `meta`, `ga4`, `linkedin` |
| 4 | `seo` | `seo-pack@1` | `brave-search:web@1` (`web:search`) | `search-console`, `ga4` |
| 5 | `sales` | `sales-pack@1` | `brave-search:web@1` (`web:search`) | `linkedin`, `google-workspace` |
| 6 | `operations` | `operations-pack@1` | `brave-search:web@1` (`web:search`) | `google-workspace`, `github` |
| 7 | `financial-analysis` | `financial-analysis-pack@1` | `world-bank:indicator@1` | `stripe` |
| 8 | `content` | `content-pack@1` | `brave-search:web@1` (`web:search`) | `wordpress-woocommerce`, `linkedin` |

Capability names, profile titles/instructions, RaaS offer labels, and service `displayName`,
`specialization`, allowlists, and numeric bounds are operator-editable without code changes.
Verify all eight packs end-to-end with:

```
pnpm qa:business-packs
```

## What "operational" means for this service

| Layer | Evidence |
| --- | --- |
| configuration | validator returns `valid: true` with no BLOCKER |
| provider | one real World Bank read through ToolBroker, digest recorded |
| evidence | source + evidence + snapshot rows with retrieval timestamps |
| review | an authorized human decision, never an automatic promotion |
| result | DELIVERABLE document with citations and a reversible history |

A service missing any of these is reported by state (`BLOCKED` / `UNVERIFIED` / `CONFIGURED`), never
by a friendly label.
