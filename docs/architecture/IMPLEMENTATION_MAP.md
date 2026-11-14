# QeyNox 2027 — source implementation map

Target Git branch: feat/qeynox-2027-foundations. Baseline: 9646976. Commits 10–20 each add a separate implementation lot. TASK 02 added the migration runner, operator configuration services and disposable-QA verification. TASK 01 certified dependency installation/lockfile, TypeScript, production builds, NestJS DI/HTTP wiring, Drizzle contracts and the pinned Hatchet SDK surface against an isolated QA database. TASK 03 verified the installed Hatchet SDK contract, implemented run-ID/cancellation/run-observation adapters, hardened Hermes fail-closed isolation and native-tool rejection, and ran a controlled multi-step worker workflow plus Soul/Pilot API wiring against local QA fixtures. TASK 04 added configured-provider ToolRegistry activation, egress/SSRF policy, provider rate limiting, source snapshots and MCP/HTTP boundaries, and exercised the World Bank adapter with a real read-only HTTPS call in isolated QA. TASK 05 completed evidence-backed claim verification, cited result assembly, human review/delivery and JSON/HTML exports, producing one traceable deliverable from a real World Bank read in isolated QA. A consolidation audit re-ran all five isolated-QA suites (3059 assertions), aligned the contract docs and removed proven dead duplicate modules without changing verified contracts. TASK 08A added real isolated-MinIO storage verification, safe PENDING_UPLOAD reconciliation and pinned-DNS/redirect-hardened provider egress (26 storage + 47 egress assertions). **Nothing is deployed and no production migration, customer data or unmediated provider call has occurred.**

| Responsibility | Code area | Status |
| --- | --- | --- |
| Customer mission workspace increment | apps/web/src/lib/mission*, apps/web/src/components/mission-controls.tsx, existing mission page and nested result reader | **LIVE FRONTEND↔BACKEND VERIFIED IN DISPOSABLE LOCAL QA (2026-11-13)**: real login/logout revocation, UI draft creation, summary/timeline/cursor-paginated activity, Pilot guidance/overview, Soul consent→fact→delete→revoke, result-document reader with JSON/HTML signed MinIO exports for a real World Bank-sourced deliverable, RUNNING stop request, EN/FR and 1440×900/1024×768/390×844 layouts. Reproducible pagination/label/empty-state defects fixed; remaining non-blocking findings recorded in PROGRESS.md. No new backend endpoint, live external runtime, payment or operator data exposure. |
| Professional Blue frontend foundation (EN/FR, outcome homepage, MyDash, session boundary, draft entry, recent missions and capability unavailability) | apps/web | FRONTEND TYPECHECK + PRODUCTION BUILD VERIFIED; 54 isolated HTTP smoke assertions; **LIVE BACKEND INTEGRATION + REAL-BROWSER EN/FR AND RESPONSIVE VERIFIED IN DISPOSABLE LOCAL QA (2026-11-13)**. Reference screenshot comparison BLOCKED (reference PNG absent); no formal accessibility/contrast/visual certification claimed. Customer capability catalogue, initial planning/cost readiness and full result discovery remain API gaps documented in docs/design/UX_IMPLEMENTATION_PLAN.md. |
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




## Independent preproduction resources (2026-11-13)

Nine resources now exist in Coolify project Qeynox, environment preproduction. See infra/PREPRODUCTION.md for UUIDs and actual runtime status. Production environment remains untouched. Three Dockerfiles, explicit private origins, shared Redis quota gate, empty-only migration CLI and inactive versioned connector declarations are source implemented; local verification is recorded in PROGRESS.md. Resource existence is not proof of DNS, connectivity or customer execution. Live Hatchet token/dispatch, Hermes model credentials/confinement, scoped S3 credentials/SSE, public TLS and identity hardening remain deployment gates.

Live preproduction foundation update: operator-unlocked SSH enabled capacity, volume and DNS verification; 11 business migrations applied to the empty Core database; PostgreSQL/Redis/storage/Hatchet Lite running healthy. SSE-S3 and bucket-scoped app credentials configured. All three Docker images built and local startup checked. Full deployed application/runtime connectivity remains a separate verification step; Hermes remains inactive pending provider and confinement. Production remains untouched.

Deployment compatibility: API/Web images include curl for Coolify's generated healthcheck after a reproduced deployment failure; no checks disabled. Optional AnythingLLM is prepared and inactive. Hatchet SDK real task dispatch/result and VPS ToolBroker World Bank read are now verified as technical probes. Real Hermes provider/confinement, customer execution and public access remain blocked.

Final phase-2 verification is recorded in PREPRODUCTION_VERIFICATION.md: ten separate resources; API/Web/worker plus five foundation resources running healthy at code SHA 541a60d; Hermes/RAG inactive. Actual authenticated MyDash, Core/Redis/encrypted S3, worker Hatchet listener, real Hatchet diagnostic dispatch/result, VPS isolated ToolBroker World Bank and independent restart persistence verified. Customer Hermes execution, configured business capabilities, public identity/TLS, external backups and independent production certification remain unverified. No production environment deployment or SaaS publication.

Public ingress update (2026-11-13): PUBLIC_ACCESS_VERIFICATION.md supersedes the prior DNS/TLS/public-download blocker. Native Web domain qeynox.io, trusted automatic TLS, actual public login→MyDash→private API→existing DRAFT mission and HTTPS signed S3 uploads/downloads verified. No business-code rebuild; images remain 541a60d. S3 is routed only by its bucket path with unchanged SigV4 Host/path and download sandbox/attachment headers. Core/Redis ports remain unpublished; Hermes/RAG inactive. Identity hardening, external backup/KMS/security review, agent confinement and independent production certification remain gates.

## Global platform administration (Mission 01)

Source implemented and authorization-verified without a database (107 assertions; docs/architecture/PLATFORM_ADMINISTRATION.md). Authority-changing mutations are transactional with their audit row; last-administrator revocation is locking and race-safe; the audit table is append-only by trigger.
Platform roles PLATFORM_ADMIN/SUPPORT/OPERATIONS/AUDITOR and permissions ADMINISTRATION/SUPPORT/OPERATIONS/CONSULTATION
are strictly disjoint from workspace OWNER/ADMIN/MEMBER; separate platform_admin_sessions namespace, migration 0012,
fail-closed global guard, explicit CLI bootstrap, audited assignment API, last-administrator protection and read-only
support/operations diagnostics. The platform repository port reads no workspace membership.

NOT VERIFIED: isolated-PostgreSQL HTTP e2e (`pnpm qa:platform-admin`) is BLOCKED without QEYNOX_QA_DATABASE_URL;
no admin web UI exists; platform login still depends on the unhardened public-identity gate (no ingress rate limit,
MFA, e-mail verification or account recovery). No production deployment, push or merge was performed.

## Platform user administration (Mission 02)

Source implemented and authorization/pagination/revocation/isolation verified without a database
(107 assertions; docs/architecture/USERS_MANAGEMENT.md). Suspension and revocation share one
enabled-administrator rule under a PostgreSQL advisory transaction lock; both session namespaces are
revoked atomically; platform sessions/roles are disclosed only to ADMINISTRATION. Reuses identity_users/credentials/sessions and
the Mission 01 platform sessions/audit; suspension is reversible via disabled_at, session revocation
marks revoked_at, and no delete operation exists. Migration 0013 adds additive indexes only.
Invitations, e-mail verification and account recovery stay explicitly BLOCKED behind a
not-configured EmailTransport (503 NOT_CONFIGURED, audited, no e-mail claimed or sent).

NOT VERIFIED: the isolated-PostgreSQL users-management end-to-end flow (part C of
`pnpm qa:platform-users`) is BLOCKED without QEYNOX_QA_DATABASE_URL. No admin UI exists. No
production deployment, push or merge was performed.

## Workspaces & organisations (Mission 03)

Source implemented and verified end-to-end on an isolated PostgreSQL 16.6 database (87 assertions;
docs/architecture/WORKSPACES_ORGANIZATIONS.md). Uses identity_workspaces/identity_memberships only
(no second organisation entity); migrations 0014/0015 are additive. Provides paginated
organisation/member consultation, invitations of existing accounts without fake e-mail (single-use
hashed token, delivery BLOCKED), role changes with before/after audit, revocation, explicit workspace
switch with session rotation, last-enabled-owner protection (role change, revocation and Mission 02
suspension), and session invalidation when the last active membership is removed. Cross-tenant access
and cross-user invitation acceptance are denied and audited.

VERIFIED: qa:platform-organizations PASS (87 assertions on disposable PostgreSQL); regressions
qa:platform-admin PASS (70) and qa:platform-users PASS (165) on the same isolated database.
NOT VERIFIED: production deployment, public identity hardening, e-mail transport, workspace deletion
(deliberately out of scope). No push, merge or deployment.
