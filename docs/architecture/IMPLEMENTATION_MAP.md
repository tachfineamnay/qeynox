# QeyNox 2027 — source implementation map

Target Git branch: feat/qeynox-2027-foundations. Baseline: 9646976. Commits 10–20 each add a separate implementation lot. TASK 02 added the migration runner, operator configuration services and disposable-QA verification. Typechecking and isolated-database QA have run; **nothing is deployed and no production migration, customer data or external provider call has occurred.**

| Responsibility | Code area | Status |
| --- | --- | --- |
| Product and architectural decisions | AGENTS.md, docs/architecture | CODED |
| Identity, workspace membership, bearer session | apps/api/src/auth, persistence/identity-schema | SOURCE CODED; integration NOT VERIFIED |
| Business operations and versioned plans | packages/domain, application/planning/execution/revisions | SOURCE CODED |
| Database mapping and outbox | persistence/schema, migrations 0001–0011 | CODED; migrations APPLIED IN DISPOSABLE QA DB, schema parity verified |
| Operator configuration lifecycle (capabilities, profiles, Soul, Pilot, tools, verification policies, budget policies, offers) | application/configuration, contracts/configuration, migration 0011, API operator configuration | CODED; lifecycle QA-VERIFIED in disposable PostgreSQL; operator allowlist unset by default (fail closed) |
| Hatchet step worker and durable dispatch | orchestration/hatchet/outbox, apps/worker | PARTIAL; external run identity NOT VERIFIED |
| Hermes model/agent runtime | engine/hermes | SOURCE CODED; native tool isolation BLOCKED |
| ToolBroker and source registration | tools, application/agent-tools | SOURCE CODED; no production connectors enabled |
| World Bank read-only indicator adapter | tools/providers/world-bank | CODED, unconfigured; requires egress policy |
| Claim verification and provenance | application/claims, persistence/claims-schema | CODED, no verified live source |
| RaaS result versions, private S3 exports | application/result-document, artifacts, s3 | CODED; storage not configured |
| Offer/quote/acceptance and payment port | application/commerce/payments | CODED; paid execution BLOCKED |
| Agent cost ceilings and usage | application/budgets | CODED; pricing/rate cards unconfigured |
| Operation and activity feeds | application/read-models, API activity | CODED, polling only, no SSE |
| Recovery and operator actions | application/recovery, API operator | CODED; runtime run observation unsupported |
| Runtime replacement contracts | engine runtime-manifest, application/engine-selection | CODED; future engines not implemented |
| Consent and local deletion request | roles/soul, application/context-policy | CODED; third-party deletion NOT CONFIRMED |

## Open decisions and real operational blockers

1. TypeScript typecheck passes and migrations apply cleanly in a disposable QA database. Hatchet/Hermes SDK runtime compatibility remains UNKNOWN; production certification is still required.
2. Hatchet run-reference mapping and cancellation/recovery APIs are NOT VERIFIED; do not enable production operation dispatch.
3. Hermes native shell/browser/MCP/tools and outbound network egress require genuine network/sandbox containment. An env flag alone is not proof.
4. No identity emails, rate limits at gateway, MFA, session storage in client or account recovery mechanisms for public launch.
5. No external source providers configured, provider licensing verified or citation freshness SLA.
6. No configured eight business skills/profiles; names not invented.
7. Pricing, tax and payment service provider not decided; any paid operation remains PAYMENT_REQUIRED.
8. Budget policy configuration exists, but no production client policy is configured; execution still fails closed rather than running unbounded.
9. No artifact bucket configured, no commercial delivery, no PDF/audio exports, no real SaaS user interface yet.
10. No backups, production migration, provider/tool test calls or Coolify deployment performed; migration verification was limited to a disposable QA database.

This tree is intended as a *source-code foundation* for a dedicated certification and integration phase. It is not a finished or certified product.
