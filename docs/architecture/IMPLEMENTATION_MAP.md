# QeyNox 2027 — source implementation map

**2026-11-22 P21 execution authority / revocation:** PgToolAuthorization's PostgreSQL checks are
preserved and extended with a final fresh mission admission (membership, revision, attempt-version
fence, capability/profile, consent/context binding, provider configuration, beta/reservation).
Inference is admitted once per existing durable reservation via command-id uniqueness; stale Worker
claim/completion/failure cannot overwrite a resumed epoch. Document and dependency context bindings
are revalidated; production Soul/Pilot advisory boundaries recheck member/profile/fact consent.
In-flight WRITE failures/ledger uncertainty propagate UNKNOWN_OUTCOME; earlier STARTED/UNKNOWN WRITEs
block new execution rather than silently replay. No new migration/global lease system, network under
DB locks, remote-undo claim or Stripe activation. **Basic typecheck and API/Worker builds pass; no
QA/tests/DB/live calls.** Full concurrency, crashes, slow admissions, financial/secret isolation and
legacy fixture provisioning remain P22. See [P21_VERIFICATION.md](../../infra/P21_VERIFICATION.md).


**2026-11-22 P20 existing Control beta operations:** EN/FR invitation management reuses existing
ADMINISTRATION issue/revoke/audit and tester/workspace/grant links. OPERATIONS adds bounded metadata
queues (outbox, document ingest/deletion, email), per-workspace/mission provider ledger and outstanding
holds, existing runtime/provider/storage diagnostics, migration manifest/history comparison, and
allowlisted mission/attempt failure codes instead of raw event/error payloads. Two confirmed,
reasoned, atomic-audited local actions only: OPEN incident escalation and due-now scheduling for a
future never-dispatched job whose mission/revision/attempt remains active. No blind retry, uncertain
email resend, terminal job reset, lease/cost guard bypass, second console or payment activation.
**Typecheck + scoped API/Control builds pass; no tests/QA/browser/DB/live calls.** SQL execution,
authorization/concurrency, private-data isolation, invitation handoff/redemption and real beta journeys
remain unverified P22 gates. See [P20_VERIFICATION.md](../../infra/P20_VERIFICATION.md).


**2026-11-22 P19 business-provider integration:** all eight A16 requirements inspected; shared actual
adapter resolution/status, manifest alias compatibility, catalogue/Pilot provider blockers, pack-safe
selection/input guidance, positive paid-search ceilings, per-call authority reload, returned-page
snippet citations/raw-response digests and whole provider deadlines are source implemented. Only
existing READ_ONLY WB/Brave tools, no business OAuth/write connector invented. **Typecheck passes
(6 tasks + release); tests/builds not run, real certification deferred to P22.** Provider configuration
is explicitly NOT live verification. No live call/config/credential mutation, deployment or migration.
See [P19_VERIFICATION.md](../../infra/P19_VERIFICATION.md) and
[BUSINESS_PROVIDERS_RELEASE.md](../../infra/BUSINESS_PROVIDERS_RELEASE.md).


**2026-11-22 P18 private storage integration:** shared API/Worker config, bounded S3 transport,
SSE/conditional PUT signing, HEAD-checked read grants, canonical-resource-authorized same-origin relay,
lease-aware maintenance batches and protected read-only storage/queue diagnostics are source
implemented. Offline policy bundle/runbook preserve private bucket/data/KMS and P10–P12 algorithms.
Minimal typecheck (6 tasks + release) and three scoped builds pass; **tests not run; real S3/P22
certification deferred**. No live storage/DB/policy mutation, deploy, restart, migration or public bucket.
See [P18_VERIFICATION.md](../../infra/P18_VERIFICATION.md) and
[STORAGE_RELEASE.md](../../infra/STORAGE_RELEASE.md).


**2026-11-22 P17 Hermes Vertex integration:** source-only read-only Hermes credential/config mounts,
hardened exact-model renderer, shared app settings, auth/model/toolset probe tightening, bounded
inference, classified/logged recovery facts and truthful estimated/unknown accounting are implemented.
Local contract tests and compilation pass; **real Vertex inference/IAM/refresh/isolation certification
is deferred to P22**. No credential change, deploy, restart, DB/migration or live provider call.
See [P17_VERIFICATION.md](../../infra/P17_VERIFICATION.md) and
[HERMES_VERTEX_LIVE_RUNBOOK.md](HERMES_VERTEX_LIVE_RUNBOOK.md).


**2026-11-22 P16 release integration:** role env/identity/startup/health contracts, private topology,
Control `/admin`, direct worker entrypoint/heartbeat, authenticated private-storage Web relay,
GET-only inventory, operator readiness and current32 migration/rollback configuration are source
implemented. Local release tests 7/7, typecheck and production source builds pass. **Not deployed
or runtime-certified**: Coolify credentials/live inventory, Docker image validation, populated DB
rehearsal and real private dependencies remain blocked/unverified. See
[P16_VERIFICATION.md](../../infra/P16_VERIFICATION.md).

**2026-11-17 Flow 2.0 Web release preparation:** Local Web typecheck/build, Flow fixture suites, updated HTTP smoke, browser event-motion checks and isolated Web image startup/fixture-exclusion checks passed; scope and exact limitations are recorded in [FLOW2_STATUS.md](../flow/FLOW2_STATUS.md). No merge, push or deployment was performed. External runtime, live customer journey, identity/storage/provider gates and independent production certification remain open.

**2026-11-15 targeted repair:** Agent findings require human review before SUPPORTED, including when structural policy checks alone would otherwise promote them. Local verification and outstanding mission 10 gates are recorded in PROGRESS.md. Existing links do not prove semantic attribution; Hermes is restarting/unhealthy in preproduction and the real end-to-end path remains unverified.

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
| Hermes model/agent runtime | engine/hermes | A02: wire contract parsed from upstream source (502 agent_incomplete, finish_reason error/cancelled/length, hermes extras, zero-usage, 401/429), timeout vs cancellation distinguished, redacted diagnostics; contract VERIFIED IN ISOLATION (57 assertions); REAL VERTEX INFERENCE BLOCKED (no credential) |
| Agent runtime execution (worker steps, progression, outbox dispatch, Soul/Pilot, versioned profiles) | orchestration, apps/worker, apps/api soul+pilot+agent-runtime | QA-VERIFIED in disposable DB with local deterministic fixtures; external Hatchet/Hermes runtimes NOT VERIFIED |
| ToolBroker and source registration | tools, application/agent-tools | CODED; configured-provider registry, permissions/consent/budget/rate-limit/egress gates and source snapshots QA-VERIFIED |
| World Bank read-only indicator adapter | tools/providers/world-bank | CODED; ACTIVATED IN ISOLATED QA WITH A REAL READ-ONLY HTTPS CALL THROUGH PINNED EGRESS; requires configuration + egress attestation |
| External connector framework (provider loader, egress/SSRF policy, rate limiting, MCP boundary) | tools/egress, tools/providers/configured, tools/rate-limit, tools/mcp | QA-VERIFIED; egress now resolves once, rejects private/reserved/metadata answers, pins the validated IP and refuses redirects; only the reviewed World Bank provider is enabled |
| Claim verification and provenance | application/claims, persistence/claims-schema | CODED; evidence-digest linkage, freshness/contradiction policy and capability binding QA-VERIFIED with a live World Bank source |
| RaaS result versions, private S3 exports | application/result-document, artifacts, s3 | CODED; cited assembly/review/delivery/JSON+HTML exports QA-VERIFIED; private uploads/signed expiry/tenant isolation/reconciliation QA-VERIFIED AGAINST ISOLATED MINIO **AT THE RECORDED BASELINE ONLY — live MinIO UNVERIFIED since the 2026-11-22 matrix (no S3 service; `qa:storage` reports BLOCKED exit 3)**; production bucket NOT configured |
| Artifact reconciliation and provider egress hardening | application/artifacts, application/s3, tools/egress | CODED; real MinIO PENDING_UPLOAD recovery and live pinned World Bank egress QA-VERIFIED at the recorded baseline only; deployment firewall/runbook NOT VERIFIED; `qa:storage` exit contract (0 PASS / 3 BLOCKED / 1 FAILED) regression-checked by `qa:storage-selftest` (2026-11-24) |
| End-to-end RaaS deliverable (objective → research → evidence → verification → reviewed result → export) | claims, result-document, delivery, artifacts, worker QA pipeline | QA-VERIFIED: real World Bank read, human review, DELIVERABLE version with citations; no fictitious data or success states |
| Customer service catalogue and ordering (A13) | contracts/service-catalogue, application/service-contracts, application/service-catalogue, api/services, web services pages, control configuration | SOURCE CODED + QA-VERIFIED IN DISPOSABLE LOCAL POSTGRESQL (2026-11-19): catalogue joins ACTIVE offers with real capability availability; typed form → operation + bounded plan; quote/acceptance flow unchanged; fail-closed without a registered contract |
| Licensed web search adapter, Brave (A15 increment 1) | tools/providers/brave-search, tools/providers/configured, infra/operator/a15-web-research.json | SOURCE CODED + QA-VERIFIED IN DISPOSABLE LOCAL POSTGRESQL (2026-11-20): reviewed READ_ONLY adapter (`web@1`), typed contracts, pinned egress, consent `web:search`, fail-closed triple gate, broker/ledger provenance; NO live provider call verified (no Brave subscription token; sandbox TLS BLOCKED) — registry stays INACTIVE pending an operator deployment and one recorded live read |
| Documents, files and tenant-safe knowledge (A17) | contracts/documents, application/documents + embeddings, api/documents, web /[lang]/documents + mission attach card, persistence migration 0022 | SOURCE CODED + QA-VERIFIED IN DISPOSABLE LOCAL POSTGRESQL (2026-11-19): upload with SHA-256 re-verification, extraction PDF/DOCX/text (no fabrication), tenant-scoped FTS with citations, optional embeddings (HYBRID degrades to FTS), mission attach/detach, retention expiry + purge, revoke cascade. NOT verified: real S3 (in-memory QA double only), live embeddings (none configured), production (migration 0022 not applied) P10 (2026-11-21): attached AVAILABLE documents reach Hermes as bounded excerpts (`documents:excerpts` profile key + `context:read` consent + ACTIVE members), grounded `[Dn]` citations recorded as provenance-only evidence and `documentSources`; local QA only, not live-Hermes verified |
| Connector hub and workspace account connections (A14) | contracts/connections, application/connection-providers + connection-vault + connections, api/connections, web /[lang]/connections, persistence migration 0021 | SOURCE CODED + QA-VERIFIED IN DISPOSABLE LOCAL POSTGRESQL (2026-11-19): OAuth PKCE lifecycle, sealed credential vault, scope-derived capabilities, audit trail, EN/FR UI; NO live OAuth provider verified; registry stays BLOCKED pending operator OAuth client |
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
4. No operator-triggered identity emails (self-service verification/recovery/invitation delivery exists as of A19, env-configured), rate limits at gateway, MFA, session storage in client mechanisms for public launch.
5. The documented World Bank adapter was activated against its live public API in isolated QA; provider licensing/attribution review and a citation-freshness SLA remain operator responsibilities. No second research provider was added: no documented, licensed and provisioned endpoint was available, and inventing one is prohibited.
6. No configured eight business skills/profiles; names not invented.
7. Pricing, tax and payment service provider not decided; any paid operation remains PAYMENT_REQUIRED.
8. Budget policy configuration exists, but no production client policy is configured; execution still fails closed rather than running unbounded.
9. Document vault (A17) data plane is implemented but NOT certified: no production bucket/S3, no embeddings provider configured (FTS-only), migration 0022 never applied to production, no browser-verified customer journey. Ingestion/retrieval are separate from business verification by construction; citations always reference uploaded documents with their SHA-256.
10. No production artifact bucket configured or certified: private uploads, signed expiry, tenant isolation and PENDING_UPLOAD reconciliation were verified against isolated MinIO (plus the fail-closed unconfigured path). No PDF/audio exports, no paid commercial delivery and no real SaaS user interface yet.
11. No backups, production migration, provider/tool test calls or Coolify deployment performed; migration verification was limited to a disposable QA database.

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
not-configured EmailTransport (503 NOT_CONFIGURED, audited, no e-mail claimed or sent). (Superseded by A19: a real env-selected Resend transport ships; customer self-service flows deliver when deployment secrets are set; operator-triggered sends stay blocked.)

NOT VERIFIED: the isolated-PostgreSQL users-management end-to-end flow (part C of
`pnpm qa:platform-users`) is BLOCKED without QEYNOX_QA_DATABASE_URL. No admin UI exists. No
production deployment, push or merge was performed.

## Workspaces & organisations (Mission 03)

Source implemented and verified end-to-end on an isolated PostgreSQL 16.6 database (87 assertions;
docs/architecture/WORKSPACES_ORGANIZATIONS.md). Uses identity_workspaces/identity_memberships only
(no second organisation entity); migrations 0014/0015 are additive. Provides paginated
organisation/member consultation, invitations of existing accounts (single-use
hashed token, delivery BLOCKED), role changes with before/after audit, revocation, explicit workspace
switch with session rotation, last-enabled-owner protection (role change, revocation and Mission 02
suspension), and session invalidation when the last active membership is removed. Cross-tenant access
and cross-user invitation acceptance are denied and audited.

VERIFIED: qa:platform-organizations PASS (87 assertions on disposable PostgreSQL); regressions
qa:platform-admin PASS (70) and qa:platform-users PASS (165) on the same isolated database.
NOT VERIFIED: production deployment, public identity hardening, workspace deletion; e-mail transport implemented in code (A19) but never exercised against a live provider — no key on this deployment, no mailbox confirmed
(deliberately out of scope). No push, merge or deployment.

## Soul pre-mission onboarding (Mission 05, code-only)

Source implemented: migration 0016 `soul_onboarding` (additive progress only), `SoulOnboardingService`
in `packages/roles/src/soul.ts`, `/v1/soul/onboarding/*` controller (operation-free pre-mission
contract; `/v1/soul/converse` untouched), web `/[lang]/soul` guided flow with explicit consent,
consented-context CRUD/revocation, pause/resume/skip/dismiss and direct MyDash access, first objective
handed to the existing mission creation endpoint, and platform-admin onboarding status (no private
content) in QeyNox Control user detail.

NOT VERIFIED: no tests, build, migration execution or UI certification was run (FAST MODE code only).
Deterministic guidance is intentional and labelled; no LLM execution is claimed before a mission
exists. Awaiting a later verification lot. No push, merge or deployment.

## Customer support — external Chatwoot engine (Mission 06, code-only)

Source implemented: server-only Chatwoot REST adapter, `/v1/support/*` customer endpoints,
`/v1/platform/support/*` platform endpoints restricted by the existing SUPPORT permission,
mapping-only migration 0017, MyDash support entry, `/[lang]/support` history/reply screens and the
QeyNox Control Support inbox (list, status, priority, history, reply, status update, audit).
NOT_CONFIGURED is the default when Chatwoot variables are absent or the operator has not completed the
live-verification procedure (`QEYNOX_CHATWOOT_LIVE_VERIFIED`, see
[CHATWOOT_SUPPORT.md](CHATWOOT_SUPPORT.md)); no token reaches the browser and no support message is
stored in PostgreSQL. Chatwoot webhooks are not needed for this read-live design (any future webhook
must be secret-verified before writes). A10 (2026-11-19) added the source_id reconciliation design
(durable `support_intents`, tenant-scoped idempotency, orphan/duplicate fail-closed) and its fixture /
disposable-PostgreSQL suites; migration 0020. No live Chatwoot integration is claimed; the capability
fails closed until the documented live-verification procedure is executed. No Coolify resource created;
no push/merge/deployment (draft PR only).

## Operations desk — read-only supervision (Mission 07, code-only)

Source implemented: `/v1/platform/operations/*` read-only routes (list/summary/incidents/health/
releases/resources/detail), OPERATIONS-permission gated and audited on denial; QeyNox Control pages
`/admin/{lang}/operations` (missions by status, incidents/actions), `/operations/[id]` (summary,
runtime, executions, attempts, event history, recovery), `/operations/health` (measured checks +
optional read-only Coolify inventory), `/operations/releases` (version/commit/date when exposed,
last check, migrations, 24 h anomalies). Missing/inaccessible data is UNAVAILABLE; no metrics are
invented. No mutation, redeploy or Docker command exists. NOT VERIFIED: no tests, build, migration
execution or provisioning was run. No Coolify resource created; no push/merge/deployment.

## Public website & SEO (Mission 08, code-only)

Implemented in apps/web (Next.js kept; no Astro): marketing home, how-it-works, manifesto, contact and
legal/notice, legal/privacy, legal/terms, legal/cookies in EN/FR, with Professional Blue styling,
server-side rendering, unique metadata, canonical/hreflang, Open Graph, sitemap.xml, robots.txt and
semantic HTML. No client-side marketing JavaScript, no fabricated proof, prices or legal identity.
Legal data to complete is flagged in docs/product/PUBLIC_LEGAL_CHECKLIST.md and on the pages. MyDash
and qeynox.io routing unchanged. NOT VERIFIED: no build, typecheck, crawl or visual audit was run.
No push, merge or deployment.

## Release preparation — Control /admin (Mission 09, code-only)

infra/Dockerfile.control (pinned Node/pnpm, filtered Control build, port 3001, health /admin/en),
declarative infra/coolify/qeynox-control.application.json (prepared, not created), release and
reverse-proxy documentation (infra/CONTROL_RELEASE.md), populated-database additive migration
procedure 0012–0017 (infra/MIGRATIONS_0012_0017_PREPRODUCTION.md), Control basePath /admin
consolidation (routes under /[lang]; one PathPrefix proxy rule; assets under /admin/_next), lockfile
apps/control importer, static import/syntax checks across modules 04–09. BLOCKED before deployment:
candidate branch not pushed, no Docker/typecheck/build, no Coolify/proxy/migration execution.
No push, merge or deployment.

## Independent release audit (2026-11-14)

**NO-GO**: the candidate is not certified for main. The current evidence and remaining blockers supersede any broader implication of earlier mission status entries; see [FINAL_REPAIR_CERTIFICATION_2026-11-14.md](FINAL_REPAIR_CERTIFICATION_2026-11-14.md).

## Final closeout continuation (2026-11-14)

The latest targeted tests and outstanding release gates are recorded in [FINAL_CLOSEOUT_2026-11-14.md](FINAL_CLOSEOUT_2026-11-14.md). MAIN and PREPRODUCTION remain **NO-GO**; Chatwoot carries the verified A10 reconciliation design but remains intentionally NOT_CONFIGURED pending the documented live-verification procedure.

## Commerce payment freeze (Mission A21.01)

| Responsibility | Code area | Status |
| --- | --- | --- |
| Server-authoritative commerce mode (`QEYNOX_COMMERCE_MODE`: `PAYMENTS_DISABLED` default, `BETA_FREE`; no paid mode) | packages/application/src/commerce-mode.ts, apps/api/src/commerce/commerce.module.ts | **VERIFIED IN DISPOSABLE QA (2026-11-21)**: `qa:payment-freeze` 21 groups / 369 assertions. A paid value refuses API boot. |
| Payment mutation freeze (checkout, capture, refund, reconcile, webhook → 503 `PAYMENTS_FROZEN`; Stripe keys inert) | apps/api/src/commerce/payments.controller.ts, `FrozenPaymentGateway`, `FrozenPaymentProvider`, packages/domain/src/errors.ts, apps/api/src/transport/domain-exception.filter.ts | **VERIFIED IN DISPOSABLE QA**, in-process and over real `AppModule` HTTP, for both modes × Stripe test keys present/absent. Zero non-loopback network attempts (positive control proved detection). Historical commerce tables deep-equal before and after. |
| Frozen payment read model and UI availability (`commerce` block, `GET /v1/commerce/availability`, readiness `PAYMENTS_FROZEN`, read-only payment panel) | packages/application/src/plan-read.ts, apps/web/src/components/payment-panel.tsx, apps/web/src/lib/plan.ts, apps/web/src/lib/mission-copy.ts | API side verified in QA. Web typecheck and build PASS. **Browser rendering NOT VERIFIED** (server-rendered HTML asserted by web `test:smoke`: 199 PASS). |
| Dormant A08 Stripe lifecycle (preserved, unreachable from the API) | packages/application/src/stripe-payments.ts, packages/application/src/payment-service.ts | Unchanged. `qa:stripe-payments` 108 PASS. Live Stripe NOT VERIFIED (by design, no call is possible while frozen). |

Operator follow-ups (not performed by the agent):
- Disable the Stripe webhook endpoint for the duration of the freeze.
- Reconcile any pre-freeze uncaptured authorizations before any future reactivation.
- Optionally set `QEYNOX_COMMERCE_MODE` explicitly per environment (the default is already frozen).

No push to main, no merge, no deployment, no migration.

## Invite-only beta access (Mission A21.02)

| Responsibility | Code area | Status |
| --- | --- | --- |
| Durable, workspace-scoped beta grants (INVITED → ACTIVE → EXPIRED / REVOKED; expiry, mission quota, concurrent limit, provider-spend cap; append-only ledger) | packages/persistence/migrations/0026_beta_access.sql, packages/persistence/src/beta-access-schema.ts, packages/persistence/src/beta-access-store.ts | **VERIFIED IN DISPOSABLE QA (2026-11-21)** on real PostgreSQL 14.1: `qa:beta-access` 11 groups / 126 assertions. Migration is additive; Drizzle↔SQL parity holds for the three new tables (the remaining `qa:task02` parity failures are pre-existing in 0024/0025). |
| Operator grant / revoke / read (PLATFORM_ADMIN only for mutations, ADMINISTRATION or SUPPORT for reads; self-grant forbidden for a workspace the operator created or holds any membership in; every success and denial in `platform_admin_audit`) | packages/application/src/beta-access.ts (`PlatformBetaAccessService`), apps/api/src/platform/platform-beta-access.controller.ts (`/v1/platform/beta-grants`) | **VERIFIED IN DISPOSABLE QA** over real `AppModule` HTTP: anonymous, workspace sessions, SUPPORT/AUDITOR/OPERATIONS mutations, self-grants and invalid grants refused and audited; no row written. |
| Workspace activation and status (OWNER/ADMIN of the same workspace; single-use hashed token; issuer cannot activate; other workspaces get 404) | `WorkspaceBetaAccessService`, apps/api/src/workspaces/beta-access.controller.ts (`/v1/workspaces/current/beta-access`) | **VERIFIED IN DISPOSABLE QA**. Invitation delivery is manual: there is no e-mail send (reported as `delivery.email = BLOCKED`). |
| Mandatory server-side gate on every launch (start, retry, redo) and every provider-spend reservation; fail closed | packages/application/src/execution.ts, interruption.ts, controls.ts, budgets.ts, plan-read.ts (readiness blocker) | **VERIFIED IN DISPOSABLE QA**: no grant / invited / expired / revoked → 403 `BETA_ACCESS_REQUIRED`; quota / concurrency / spend cap → 429 `BETA_LIMIT_REACHED`; exact limits under parallel launches and reservations; DB CHECKs backstop quota and cap. A mutant without the START gate fails the suite. |
| Control `/beta` list, grant form, detail with usage and ledger, revoke | apps/control/src/app/[lang]/beta/**, components/beta-grant-form.tsx, lib/actions.ts | Typecheck and build PASS. **Browser rendering NOT VERIFIED.** |
| Web mission copy for beta blockers (EN/FR) | apps/web/src/lib/mission-copy.ts, components/mission-flow.tsx | Typecheck, build, `test:smoke` 199 and `test:flow2` 35 PASS. **Browser rendering NOT VERIFIED.** |

Operator follow-ups (not performed by the agent):
- Apply migration 0026 to a target environment only through the normal release procedure.
- Once deployed, **no workspace can launch until an operator grants it and the workspace activates the grant**: issue grants before enabling customer traffic.
- Hand invitation tokens over through an out-of-band channel (no e-mail is sent).

No push to main, no merge, no deployment; the migration was applied only to disposable databases.

## Free beta execution authorization (Mission A21.03)

| Responsibility | Code area | Status |
| --- | --- | --- |
| Distinct, non-financial beta authorization bound to workspace, operation, revision, quote, acceptance, order, scope hash, offer version, terms and the ACTIVE grant; list price recorded unchanged; amount due now pinned to 0 | packages/persistence/migrations/0027_beta_execution_authorization.sql, packages/persistence/src/beta-execution-schema.ts | **VERIFIED IN DISPOSABLE QA (2026-11-21)** on real PostgreSQL 14.1: `qa:beta-execution` 13 groups / 440 assertions. Migration is additive (no existing table changed); Drizzle↔SQL parity holds for `raas_beta_authorizations` (relaxed `qa:task02` 4637 assertions; the remaining parity failures are pre-existing in 0024/0025). The DB refuses `amount_due_now_minor <> 0`. |
| Acceptance creates `BETA_AUTHORIZED` orders for priced quotes in `BETA_FREE` with an ACTIVE grant; free offers stay `AUTHORIZED`; otherwise `PAYMENT_REQUIRED`; idempotent, race-safe; explicit conversion of an earlier `PAYMENT_REQUIRED` order | packages/application/src/commerce.ts (`accept`, `authorizeBeta`, `view`), apps/api/src/commerce/commerce.controller.ts (`POST /v1/operations/:id/commercial/beta-authorization`) | **VERIFIED IN DISPOSABLE QA**: all 8 A16 packs at published prices; same-key replays converge; racing keys and competing quotes → one order, one authorization, losers `CONFLICT`; conversion only with a grant, refused for free orders and orders with payment history. |
| Re-evaluation at start, retry, redo and delivery (mode, grant status and expiry, revision, every binding, not yet delivered); fail closed | packages/application/src/beta-execution.ts (`BetaExecutionAuthorizer`), execution.ts, interruption.ts, controls.ts, delivery.ts | **VERIFIED IN DISPOSABLE QA**: revoked, expired, revision change, tampered scope or price, `PAYMENTS_DISABLED` → refused with `BETA_ACCESS_REQUIRED` / `BETA_AUTHORIZATION_<denial>`; a later grant does not revive an authorization. Mutation checks (delivery bypass, retry re-check removed, grant status ignored) each make the suite fail. |
| Result delivery without Stripe: `BETA_DELIVERED` order, authorization marked DELIVERED, `RESULT_DELIVERED` names `FREE_BETA`; human `RESULT_REVIEW` still required | packages/application/src/delivery.ts | **VERIFIED IN DISPOSABLE QA** for all 8 packs (6 priced → `BETA_DELIVERED`, 2 free → `DELIVERED`), one over HTTP; zero payment, payment-event and refund rows; no order PAID or CAPTURED. |
| Read models: commercial `betaAuthorization` and `betaAuthorizationAvailable`; payment view never payment-authorizes a beta order; readiness blockers `BETA_AUTHORIZATION_INVALID` / `BETA_AUTHORIZATION_AVAILABLE`, `executionAuthorization.basis`, `prerequisites.betaAuthorization`; webhook can never change a beta order | packages/application/src/commerce.ts, plan-read.ts, payment-service.ts | **VERIFIED IN DISPOSABLE QA** (commercial, payment and readiness views asserted per pack and per denial). The webhook guard is covered by source review and by `qa:payment-freeze` (webhook still frozen); it is **not** exercised by a delivered webhook because payments stay frozen. |
| Web: free-beta block (list price, due now 0, invalidity reason), conversion button, payment panel hidden for beta orders, EN/FR copy | apps/web/src/app/[lang]/missions/[id]/page.tsx, components/mission-flow.tsx, components/payment-panel.tsx, lib/plan.ts, lib/plan-actions.ts, lib/mission-copy.ts, lib/flow-copy.ts, lib/copy.ts, components/ui.tsx | Typecheck, build, `test:smoke` 218 and `test:flow2` 35 PASS. **Browser rendering NOT VERIFIED.** |

Operator follow-ups (not performed by the agent):
- Apply migration 0027 only through the normal release procedure.
- Set `QEYNOX_COMMERCE_MODE=BETA_FREE` only when beta testers should run priced packs at no charge; under `PAYMENTS_DISABLED` existing beta authorizations are suspended.
- Revoking a grant stops every order it authorized; a new grant does not revive them (the tester accepts a fresh quote or converts a `PAYMENT_REQUIRED` order).

No push to main, no merge, no deployment; the migration was applied only to disposable databases.

## Free beta customer UX (Mission A21.04)

| Responsibility | Code area | Status |
| --- | --- | --- |
| Server-composed customer journey: commerce mode + workspace grant + runtime readiness → one state, allowance, expiry, constant pricing facts (no card, 0 due, 100% waiver only in `BETA_FREE`, `waiverApplies` = A21.03 acceptance rule); read-only, session- and tenant-scoped | packages/application/src/beta-journey.ts, apps/api/src/workspaces/beta-access.controller.ts (`GET /v1/workspaces/current/beta-access/journey`), workspaces.module.ts, workspaces.tokens.ts | **VERIFIED IN DISPOSABLE QA (2026-11-21)** on real PostgreSQL 14.1: `qa:beta-journey` 7 groups / 128 assertions. Every state comes from real records; NOT_CONFIGURED is verified by a second boot in `PAYMENTS_DISABLED`; no rows are written by the read. |
| Web journey reader with literal guards (a card request or a charge is rejected), EN/FR copy, shared beta offer summary / price tag / state notice / MyDash account card, invitation activation | apps/web/src/lib/beta.ts, lib/beta-copy.ts, lib/beta-actions.ts, components/beta-offer.tsx, components/beta-activate-form.tsx, app/globals.css | Typecheck, build, `test:smoke` 329 PASS (all states EN/FR, unreadable and malformed journeys). |
| Surfaces: catalogue, service detail, mission creation, MyDash, quote acceptance, launch; payment panel and payment prompts replaced in beta flows | apps/web/src/app/[lang]/services/page.tsx, services/[offerId]/page.tsx, components/workspace.tsx, app/[lang]/missions/[id]/page.tsx, lib/service-copy.ts | `test:smoke` + `test:flow2` 35 PASS. **Browser rendering verified against the labelled smoke fixture API only**: 73 headless-Chromium captures at 390/1024/1440, EN and FR, no horizontal overflow (`docs/design/screenshots/a21-04/`). Reference comparison **BLOCKED** (reference PNG absent). |

Operator follow-ups (not performed by the agent):
- No migration; the route ships with the API.
- Invitation tokens are still delivered out of band; customers redeem them on MyDash (OWNER/ADMIN only).

No push to main, no merge, no deployment.

## Truthful runtime readiness (Mission A21.07)

| Responsibility | Code area | Status |
| --- | --- | --- |
| Hermes probe: `/health` identity + version, key accepted (401/403 → AUTH_REJECTED), `/v1/toolsets` isolation, model advertised; abortable; stale-connection retry | packages/engine/src/hermes-diagnostics.ts | **VERIFIED IN DISPOSABLE QA** (`qa:runtime-verification`, local Hermes-contract fixture) |
| Hatchet probe: endpoints from token claims (or overrides), `/api/ready`, `/api/v1/version`, `/api/v1/tenants/{sub}` must answer for that tenant, gRPC TCP reachability | packages/orchestration/src/hatchet-probe.ts | **VERIFIED IN DISPOSABLE QA** (local Hatchet-contract fixture) |
| Evidence model + pure evaluation: NOT_CONFIGURED / NOT_PROBED / VERIFIED / FAILED / STALE / TARGET_CHANGED per component; both required for `canExecute`; launch blocker codes; customer summary; no default evidence | packages/application/src/runtime-readiness.ts | **VERIFIED IN QA** (`qa:runtime-readiness` 70 + 27) |
| `RuntimeProbeMonitor`: per-process in-memory evidence, clamped policy (timeout / freshness / interval), monitor-enforced deadline, in-flight sharing, `freshReadiness`, secret scrubbing, configuration fingerprint | packages/application/src/runtime-probes.ts | **VERIFIED IN DISPOSABLE QA** |
| API: process monitor + boot lifecycle (`QEYNOX_RUNTIME_PROBES=off` disables); env flags `QEYNOX_RUNTIME_VERIFIED_LIVE` / `_EVIDENCE` no longer read | apps/api/src/operations/runtime-readiness.ts, app.module.ts | **VERIFIED IN DISPOSABLE QA** (HTTP, boot probing) |
| Launch gate: `OperationExecutionService` requires a runtime source; `start` refused before any allowance/attempt/outbox write (503 NOT_CONFIGURED / 502 UNAVAILABLE) | packages/application/src/execution.ts, apps/api/src/operations/operations.provider.ts | **VERIFIED IN DISPOSABLE QA** (unit + HTTP) |
| Readiness and journey: per-component blockers (`*_UNVERIFIED`, `*_UNAVAILABLE`), `verification` summaries; operator capabilities carry the full record | packages/application/src/plan-read.ts, beta-journey.ts, platform-catalogue.ts | **VERIFIED IN DISPOSABLE QA** |
| Worker: own monitor, `freshReadiness()` gate before `selectOperational`; QA opt-out ignored under `NODE_ENV=production` | apps/worker/src/runtime.ts, main.ts | **TYPECHECKED + gate components tested**; no worker step ran against the gate |
| Web: per-component runtime rows (beta card, mission prerequisites), EN/FR copy, malformed/absent → NOT_PROBED | apps/web/src/lib/runtime-copy.ts, components/beta-offer.tsx, app/[lang]/missions/[id]/page.tsx | **VERIFIED IN SMOKE/FLOW2 (fixture API) + SCREENSHOTS** (`docs/design/screenshots/a21-07/`) |
| Control: per-component verification (status, evidence ref, identity, endpoint, observed/expires, failure) | apps/control/src/app/[lang]/settings/page.tsx, lib/types.ts, lib/copy.ts | **TYPECHECKED + BUILT**; not screenshotted |
| Real Hermes / Hatchet deployments | — | **NOT VERIFIED**: no deployment contacted |

Operator follow-ups (not performed by the agent):
- Remove `QEYNOX_RUNTIME_VERIFIED_LIVE` / `QEYNOX_RUNTIME_VERIFICATION_EVIDENCE` from deployed environments (now ignored).
- Make sure the API and worker can reach Hermes `/health` + `/v1/*` and the Hatchet REST API + gRPC from their own networks.
- Optionally tune `QEYNOX_RUNTIME_PROBE_*`.

No push to main, no merge, no deployment.

## Authenticated e-mail verification resend (Mission A21.06)

| Responsibility | Code area | Status |
| --- | --- | --- |
| Session-only `POST /v1/identity/verification/resend`; no body bound; recipient derived from the session user; suspended → DENIED; outcomes ACCEPTED / NOT_CONFIGURED (no token) / DELIVERY_FAILED / ALREADY_VERIFIED | apps/api/src/auth/identity.controller.ts; packages/application/src/identity-lifecycle.ts (`resendVerificationForUser`) | **VERIFIED IN DISPOSABLE QA** (`qa:verification-resend`, real HTTP, local Resend-contract fixture) |
| Dedicated `verify-resend` throttle, 5 per 15 min per user id, consumed only when a send is attempted; 429 `BUDGET_EXHAUSTED` | apps/api/src/auth/identity-lifecycle.service.ts | **VERIFIED IN DISPOSABLE QA** |
| Web action posts to the authenticated route with no body; zod-validated outcome → 5 distinct EN/FR states (+ UNKNOWN on malformed responses); `data-resend-state` | apps/web/src/lib/actions.ts, lib/verification-resend.ts, components/forms.tsx | **VERIFIED IN SMOKE (fixture API, real server action over HTTP) + BROWSER SCREENSHOTS** |
| Real Resend delivery | packages/application/src/email-transports.ts (unchanged) | **NOT VERIFIED** — fixture only; requires operator credentials |

## Registration policy and invite-only registration (Mission A21.05)

| Responsibility | Code area | Status |
| --- | --- | --- |
| One server-side registration policy: `QEYNOX_REGISTRATION_MODE` = CLOSED (default) / INVITE_ONLY / OPEN, unsupported values fail closed, deprecated `QEYNOX_ALLOW_REGISTRATION=true` alias for OPEN only when the mode is unset; resolved per call | packages/application/src/registration.ts (`resolveRegistrationPolicy`, `registrationAdmission`) | **VERIFIED IN DISPOSABLE QA** (`qa:registration` group 1) |
| Enforcement on `POST /v1/auth/register` and the public `GET /v1/auth/registration-policy`; `INVITATION_INVALID` → 403 | apps/api/src/auth/auth.service.ts, auth.controller.ts, transport/domain-exception.filter.ts, packages/domain/src/errors.ts | **VERIFIED IN DISPOSABLE QA** (agreement matrix, 9 configurations) |
| Registration invitations (migration 0028, additive): e-mail-bound, SHA-256 token digest, 7-day TTL, beta terms; operator issue / list / revoke with audit, no self-invitation, no invitation for an existing account | packages/persistence/migrations/0028_registration_invitations.sql, src/registration-schema.ts, src/registration-store.ts; apps/api/src/platform/platform-registration-invitations.controller.ts | **VERIFIED IN DISPOSABLE QA** |
| Atomic signup: account + workspace + OWNER + optional redemption → ACTIVE beta grant + ledger; a duplicate never consumes the invitation; race-safe | packages/persistence/src/registration-store.ts (`register`) | **VERIFIED IN DISPOSABLE QA** (groups 7–9) |
| Web register page renders only the API policy (OPEN / INVITE_ONLY form, CLOSED, unavailable, not configured), invitation link pre-fill, no-referrer, EN/FR copy; `QEYNOX_REGISTRATION_ENABLED` removed | apps/web/src/app/[lang]/account/register/page.tsx, lib/registration.ts, lib/registration-copy.ts, components/forms.tsx, lib/actions.ts | **VERIFIED IN SMOKE (fixture API) + SCREENSHOTS** |

Operator follow-ups (not performed by the agent):
- Set `QEYNOX_REGISTRATION_MODE=INVITE_ONLY` for the beta, or leave the default CLOSED.
- Remove `QEYNOX_REGISTRATION_ENABLED` and `QEYNOX_ALLOW_REGISTRATION` from deployed environments.
- Apply migration 0028 only through the normal release procedure.
- Invitations are delivered manually (`registrationPath` is returned once). An operator console screen and an e-mail adapter remain open.

No push to main, no merge, no deployment; the migration was applied only to disposable databases.
