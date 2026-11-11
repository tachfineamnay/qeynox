# QeyNox 2027 — source implementation map

Target Git branch: feat/qeynox-2027-foundations. Baseline: 9646976. Commits 10–20 each add a separate implementation lot. TASK 02 added the migration runner, operator configuration services and disposable-QA verification. TASK 01 certified dependency installation/lockfile, TypeScript, production builds, NestJS DI/HTTP wiring, Drizzle contracts and the pinned Hatchet SDK surface against an isolated QA database. TASK 03 verified the installed Hatchet SDK contract, implemented run-ID/cancellation/run-observation adapters, hardened Hermes fail-closed isolation and native-tool rejection, and ran a controlled multi-step worker workflow plus Soul/Pilot API wiring against local QA fixtures. TASK 04 added configured-provider ToolRegistry activation, egress/SSRF policy, provider rate limiting, source snapshots and MCP/HTTP boundaries, and exercised the World Bank adapter with a real read-only HTTPS call in isolated QA. TASK 05 completed evidence-backed claim verification, cited result assembly, human review/delivery and JSON/HTML exports, producing one traceable deliverable from a real World Bank read in isolated QA. A consolidation audit re-ran all five isolated-QA suites (3059 assertions), aligned the contract docs and removed proven dead duplicate modules without changing verified contracts. TASK 08A added real isolated-MinIO storage verification, safe PENDING_UPLOAD reconciliation and pinned-DNS/redirect-hardened provider egress (26 storage + 47 egress assertions). **Nothing is deployed and no production migration, customer data or unmediated provider call has occurred.**

| Responsibility | Code area | Status |
| --- | --- | --- |
| Product and architectural decisions | AGENTS.md, docs/architecture | CODED |
| Identity, workspace membership, bearer session | apps/api/src/auth, persistence/identity-schema | SOURCE CODED; integration NOT VERIFIED |
| Business operations and versioned plans | packages/domain, application/planning/execution/revisions | SOURCE CODED |
| Database mapping and outbox | persistence/schema, migrations 0001–0011 | CODED; migrations APPLIED IN DISPOSABLE QA DB, schema parity verified |
| Operator configuration lifecycle (capabilities, profiles, Soul, Pilot, tools, verification policies, budget policies, offers) | application/configuration, contracts/configuration, migration 0011, API operator configuration | CODED; lifecycle QA-VERIFIED in disposable PostgreSQL; operator allowlist unset by default (fail closed) |
| Hatchet step worker and durable dispatch | orchestration/hatchet/outbox, apps/worker | CODED; installed-SDK dispatch/run-ID/cancellation/observation adapters QA-CONTRACT-VERIFIED; live server dispatch NOT VERIFIED |
| Hermes model/agent runtime | engine/hermes | CODED; fail-closed isolation+egress attestation, native-tool-call rejection; real network isolation NOT VERIFIED |
| Agent runtime execution (worker steps, progression, outbox dispatch, Soul/Pilot, versioned profiles) | orchestration, apps/worker, apps/api soul+pilot+agent-runtime | QA-VERIFIED in disposable DB with local deterministic fixtures; external Hatchet/Hermes runtimes NOT VERIFIED |
| ToolBroker and source registration | tools, application/agent-tools | CODED; configured-provider registry, permissions/consent/budget/rate-limit/egress gates and source snapshots QA-VERIFIED |
| World Bank read-only indicator adapter | tools/providers/world-bank | CODED; ACTIVATED IN ISOLATED QA WITH A REAL READ-ONLY HTTPS CALL THROUGH PINNED EGRESS; requires configuration + egress attestation |
| External connector framework (provider loader, egress/SSRF policy, rate limiting, MCP boundary) | tools/egress, tools/providers/configured, tools/rate-limit, tools/mcp | QA-VERIFIED; egress now resolves once, rejects private/reserved/metadata answers, pins the validated IP and refuses redirects; only the reviewed World Bank provider is enabled |
| Claim verification and provenance | application/claims, persistence/claims-schema | CODED; evidence-digest linkage, freshness/contradiction policy and capability binding QA-VERIFIED with a live World Bank source |
| RaaS result versions, private S3 exports | application/result-document, artifacts, s3 | CODED; cited assembly/review/delivery/JSON+HTML exports QA-VERIFIED; private uploads/signed expiry/tenant isolation/reconciliation QA-VERIFIED AGAINST ISOLATED MINIO; production bucket NOT configured |
| Artifact reconciliation and provider egress hardening | application/artifacts, application/s3, tools/egress | CODED; real MinIO PENDING_UPLOAD recovery and live pinned World Bank egress QA-VERIFIED; deployment firewall/runbook NOT VERIFIED |
| End-to-end RaaS deliverable (objective → research → evidence → verification → reviewed result → export) | claims, result-document, delivery, artifacts, worker QA pipeline | QA-VERIFIED: real World Bank read, human review, DELIVERABLE version with citations; no fictitious data or success states |
| Offer/quote/acceptance and payment port | application/commerce/payments | CODED; paid execution BLOCKED |
| Agent cost ceilings and usage | application/budgets | CODED; pricing/rate cards unconfigured |
| Operation and activity feeds | application/read-models, API activity | CODED, polling only, no SSE |
| Recovery and operator actions | application/recovery, API operator | CODED; run observation uses the installed Hatchet SDK when a token is configured, otherwise UNSUPPORTED |
| Runtime replacement contracts | engine runtime-manifest, application/engine-selection | CODED; future engines not implemented |
| Consent and local deletion request | roles/soul, application/context-policy | CODED; third-party deletion NOT CONFIRMED |
| Backend certification (install/lockfile, typecheck, production build, NestJS DI, HTTP auth/validation, Drizzle contracts, pinned Hatchet SDK surface) | apps/api, apps/worker, packages/*, apps/api/scripts | VERIFIED IN ISOLATED QA; Hatchet/Hermes runtime integration still NOT VERIFIED |

## Open decisions and real operational blockers

1. TypeScript typecheck passes, migrations apply and agent-runtime contracts are exercised in a disposable QA database. Installed Hatchet/Hermes integration contracts are verified by typing and local fixtures; live external runtime compatibility remains UNVERIFIED; production certification is still required.
2. Installed Hatchet SDK contracts for run-ID mapping, cancellation and run detail are implemented and contract-verified, but no Hatchet server/token was available: live dispatch, cancellation and observation are NOT VERIFIED; do not enable production operation dispatch.
3. Hermes requires real native-tool and egress containment. The adapter fails closed without both operator attestations and rejects native tool-call responses, but flags are not proof: deployment isolation remains BLOCKED and NOT VERIFIED.
4. No identity emails, rate limits at gateway, MFA, session storage in client or account recovery mechanisms for public launch.
5. The documented World Bank adapter was activated against its live public API in isolated QA; provider licensing/attribution review and a citation-freshness SLA remain operator responsibilities. No second research provider was added: no documented, licensed and provisioned endpoint was available, and inventing one is prohibited.
6. No configured eight business skills/profiles; names not invented.
7. Pricing, tax and payment service provider not decided; any paid operation remains PAYMENT_REQUIRED.
8. Budget policy configuration exists, but no production client policy is configured; execution still fails closed rather than running unbounded.
9. No production artifact bucket configured or certified: private uploads, signed expiry, tenant isolation and PENDING_UPLOAD reconciliation were verified against isolated MinIO (plus the fail-closed unconfigured path). No PDF/audio exports, no paid commercial delivery and no real SaaS user interface yet.
10. No backups, production migration, provider/tool test calls or Coolify deployment performed; migration verification was limited to a disposable QA database.

This tree is intended as a *source-code foundation* for a dedicated certification and integration phase. It is not a finished or certified product.



