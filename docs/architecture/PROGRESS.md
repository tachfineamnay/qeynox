# QeyNox 2027 — Backend source wave 10–20

One commit per prompt was requested and created on feat/qeynox-2027-foundations. Main remains outside the execution scope. Rows 10–20 record the original source wave; later TASK and consolidation entries record the isolated-QA evidence now available and supersede their runtime-status wording where verified.

| Prompt | Source result | Runtime status |
|---|---|---|
| 10 | Sessions, workspace memberships, authentication guard | UNTESTED |
| 11 | Plan seals, step handoffs and next-step dispatch | UNTESTED |
| 12 | Hermes tool proposals mediated through ToolBroker | NATIVE TOOL ISOLATION BLOCKED |
| 13 | Connector manifests, World Bank indicator source adapter | NO LIVE PROVIDERS |
| 14 | Claim verification and source attribution | UNTESTED |
| 15 | ResultDocument versions, S3 artifact port, JSON/HTML | STORAGE NOT CONFIGURED |
| 16 | Versioned RaaS offers, quotes and free/paid gating | PAYMENTS UNCONFIGURED |
| 17 | Budget reservations, cost ledger, loop controls | RATES UNCONFIGURED |
| 18 | Business read models and authenticated polling API | UNTESTED |
| 19 | Incident records, operator actions, approval expiration | RUN OBSERVATION UNSUPPORTED |
| 20 | Source-level integration and immutable runtime selection | UNTESTED |
| TASK 02 | Migration runner, schema parity fixes, operator configuration services, isolated-QA verification | QA-VERIFIED IN DISPOSABLE DB |
| TASK 01 | Dependency install/lockfile, NestJS DI repairs, production build, isolated-QA backend HTTP certification | QA-VERIFIED (28 ASSERTIONS) |
| TASK 03 | Hatchet SDK contracts, dispatch/run-ID/cancellation/observation adapters, Hermes isolation gate + native-tool rejection, multi-step worker workflow, Soul/Pilot API wiring | QA-VERIFIED WITH LOCAL FIXTURES (62 ASSERTIONS); EXTERNAL HATCHET/HERMES RUNTIMES NOT VERIFIED |
| TASK 04 | Configured-provider ToolRegistry, egress/SSRF policy, provider rate limits, source snapshots, MCP/HTTP boundaries, World Bank real read-only activation | QA-VERIFIED (48 ASSERTIONS) WITH LIVE WORLD BANK READ; NO SECOND PROVIDER ADDED |
| TASK 05 | Evidence-backed claim verification, cited result assembly, human review, immutable delivery version, JSON/HTML exports | QA-VERIFIED (47 ASSERTIONS): REAL WORLD BANK READ → TRACEABLE DELIVERABLE WITH CITATIONS |
| CONSOLIDATION | Frozen install/typecheck/build + all five isolated-QA suites re-run; docs aligned; proven dead duplicate modules and dead DI wiring removed; historical commits and ADRs preserved | PASS: 3059 ASSERTIONS, NO RUNTIME/EXTERNAL CERTIFICATION CLAIMED |
| TASK 08A | Real isolated-MinIO artifact storage, private signed expiry, tenant isolation, safe PENDING_UPLOAD reconciliation, canonical JSON exports, pinned-DNS/private-address/redirect-hardened provider egress | QA-VERIFIED: 26 STORAGE + 47 EGRESS ASSERTIONS (REAL MINIO + LIVE PINNED WORLD BANK); PRODUCTION STORAGE/FIREWALL NOT VERIFIED |

NEXT SESSION HANDOFF: Do NOT add more product features before the requested separate verification phase. Dependencies are installed with a frozen lockfile, typecheck/build pass, and migrations, operator configuration, backend HTTP/DI, agent-runtime contracts, a controlled multi-step worker workflow, the reviewed World Bank connector, one evidence-backed RaaS deliverable and real MinIO artifact storage/downloads/reconciliation were verified only in disposable QA resources (the World Bank checks were real read-only public API calls through pinned egress; the Hermes endpoint was a local deterministic fixture). Still required: review auth/service wiring for pre-production, apply migrations to a controlled pre-production database, launch and certify real Hatchet dispatch/run observation and Hermes network/tool isolation, configure and certify production object storage, review provider licensing/freshness terms, then execute real sourced end-to-end RaaS work with customer-auditable policy. No customer data or production activity until these gates are passed.

GLOBAL: ISOLATED QA VERIFIED (MIGRATIONS + CONFIGURATION + BACKEND HTTP/DI + AGENT-RUNTIME CONTRACTS + WORLD BANK CONNECTOR + EVIDENCE-BACKED DELIVERABLE + REAL MINIO STORAGE/RECONCILIATION + PINNED EGRESS; CONSOLIDATION AUDIT PASS) / EXTERNAL HATCHET + HERMES RUNTIMES AND PRODUCTION STORAGE NOT VERIFIED / NOT DEPLOYED / NOT PRODUCTION-READY.

## Frontend foundation — 2026-11-13

### Subsequent mission workspace increment — 2026-11-13

Extended the existing mission page with operation/summary state, recorded step counts, paginated activity, full timeline (kind/date only; raw event payloads are not exposed), independent section errors, visible-page read-only refresh and Pilot next-action/overview. Added one nested result-document reader for findings, evidence status, citations, unresolved claims and limitations, plus existing JSON/HTML exports and expiring grant renewal. Soul displays consent-filtered context and offers explicit purpose-scoped grants, real-ID text fact save, confirmed local delete/revoke. Stop requests re-read the current operation version and never claim runtime cancellation. No backend source/endpoints, dependencies, Graphify rebuild or global audit.

Verification: frontend `typecheck` and production `build` PASS; expanded HTTP suite PASS with 50 assertions (test-first baseline failed on missing mission progress). Browser QA with an isolated fixture confirmed login, mission/result navigation and JSON/HTML export grant controls; screenshots at 1440×900, 1024×768 and 390×844 are in ignored `.tmp/mission-evidence/`. Mobile result and French mission/tablet views had no measured horizontal overflow. These are QA fixture images, never customer proof. A test run collided with the interactive preview port; the preview was stopped and automated smoke runs now select an ephemeral port.

Actual local integration at that time: BLOCKED — no configured QEYNOX_API_URL, QEYNOX_QA_DATABASE_URL or apps/web/.env.local, and no listener on loopback port 4000. No real backend mutation, external runtime or production data was exercised. Soul and stop mutations were contract-wired/typechecked only. No production certification, push or deployment performed. Approved screenshot comparison remains BLOCKED (reference PNG absent); no formal contrast/screen-reader certification claimed. **Superseded by the live integration verification recorded below.**

Remaining API gaps: customer goal/plan/attempt/approval detail and commercial readiness reads, consent metadata listing (returned consent IDs are used explicitly), artifact inventory, and document reassembly after evidence reassessment. No approval/delivery/start/redo controls are inferred from counts or raw events. Pre-execution Soul/Pilot conversations remain unavailable without real scope/attempt IDs. Export errors may require operator reconciliation after unknown outcomes; no blind retry is automated. Existing deployment gates remain unchanged.

Reused the locally committed Graphify/UX mapping in `07236ac`; Graphify was not rerun. Confirmed no pre-existing `apps/web`, then added one Next.js 16.4.6 / React 19.3.1 / TypeScript application within the existing pnpm/Turbo workspace. Canonical Professional Blue tokens, responsive shell, EN/FR copy, outcome-first home, MyDash, recent missions, mission detail, session login/logout and contract-validated draft creation are implemented. Browser tokens are not exposed: the web server uses an HTTP-only SameSite cookie and the existing bearer/workspace API contract. No backend source changed.

Verification: `pnpm install --frozen-lockfile`, `pnpm --filter @qeynox/web typecheck`, `pnpm --filter @qeynox/web build` and `pnpm --filter @qeynox/web test:smoke` PASS (26 HTTP assertions). The smoke suite exercises built EN/FR pages, anonymous/session boundaries, genuine empty/loaded/denied/malformed API responses and absence of bearer tokens in HTML, using an isolated test-only HTTP fixture. No unrelated backend QA suite, production database, external runtime, push or deployment was run.

Limits: no browser/keyboard/contrast screenshot certification; approved-reference comparison BLOCKED because `docs/design/reference/concept-02-professional-blue.png` is absent. Login/logout/draft mutations against a real backend were unverified at that point (superseded by the live integration verification below). Capability catalogue availability is unknown, not assumed configured. Planning, quotes, execution, full Library discovery and artifact delivery UI remain outside this foundation; their API gaps remain in the UX plan. All existing runtime, public-identity and production certification gates remain unchanged.

### Live frontend↔backend integration verification — 2026-11-13 (codex/mission-workspace, bd71b80 + fixes)

Verified the existing `apps/web` customer UI end-to-end against the existing NestJS API in a disposable local QA environment only: Docker `postgres:16.6` database `qeynox_web_qa`, real isolated MinIO artifact store, the real API (`apps/api`) on loopback and the production Next.js build (`apps/web`). No production or customer data, no external Hatchet/Hermes runtime, no paid service, no deployment.

Real workflows passing: real login and logout revocation; mission draft creation from the UI form; mission detail with live summary, full timeline, cursor-paginated activity (including a 56-event pagination fixture), Pilot next-action/overview; Soul consent grant → text fact save → read → confirmed delete → revoke; result-document reader for a real World Bank-sourced DELIVERABLE document (1 supported finding, real citation URI, limitation/unresolved states) with JSON/HTML exports and signed MinIO downloads; the RUNNING stop-request control (recorded `INTERRUPT_REQUESTED`, no claimed cancellation); EN and FR routes; desktop 1440×900, tablet 1024×768 and mobile 390×844 layouts with no horizontal overflow; zero browser console exceptions; no bearer token in page HTML or browser storage.

Evidence: 73/75 live API assertions PASS (the 2 failures are the same non-UI-blocking backend input-hygiene defect listed below); 44/44 live response-shape probes and 19/19 rendered-page probes validated against the exact frontend Zod schemas; 41 real-browser screenshots from Chrome via CDP. The seeded deliverable used one real read-only World Bank call mediated by ToolBroker plus real application services; it is disposable QA test infrastructure, never customer evidence or a product fallback.

Reproducible integration defects fixed (frontend only; no screen redesign, Professional Blue tokens/components unchanged): activity "next page" is only offered when a full page is returned (no dead link to an empty page); document and finding status badges are localized in EN/FR (no raw `DELIVERABLE`/`SUPPORTED` enum labels); explicit "none recorded" empty states for limitations/unresolved/next actions; the one known English Pilot recorded-state reason is translated in FR and unknown API text is shown verbatim. Focused checks after the fix: `pnpm --filter @qeynox/web typecheck`, production `build`, smoke suite (54 HTTP assertions, now also asserting localized document labels in EN/FR) and post-fix real-browser verification PASS.

Remaining non-blocking findings (reported, not fixed because they are outside this frontend integration-defect scope): a server-revoked but locally unexpired session renders the 403 `DENIED` page state without an in-page re-authentication action (Account sign-out/sign-in is required; documented 403 ambiguity); direct API calls with a malformed path id or non-numeric `after` cursor return 500 `INTERNAL_ERROR` instead of 400 `INVALID_INPUT` (unreachable from the UI, backend input hygiene); mutation response-shape failures would be reported as `INVALID_INPUT` rather than an unknown outcome (latent; all live contracts currently validate); non-JSON upstream bodies collapse to `UNAVAILABLE` (live repro blocked by the isolated environment). Contract gaps unchanged: customer capability catalogue, consent metadata listing, plan/attempt/approval detail and commercial readiness reads, artifact inventory, document reassembly after evidence reassessment, and no WAITING_APPROVAL UI fixture. Approved reference screenshot comparison remains BLOCKED because the reference PNG is absent. No push, merge, deployment or production certification.



## 2026-11-13 — Independent Coolify preproduction preparation

Operator explicitly authorized creation, code corrections, compatible main push and preproduction-only deploys. Nine distinct resources created in project gm3bynlnlsrkikanyzvxfew7 / preproduction girv53ul8pmfikflpxf9j2re; production remains empty. Full UUID inventory, capacity evidence, configuration and blockers: infra/PREPRODUCTION.md.

Source corrections: 2cb31f4 Docker context exclusions and outbound network split reused selectively; explicit server-only private-origin authorization for Web/API and Hermes; three root-context non-root production Dockerfiles; atomic shared Redis provider quotas with unavailable-store failure; guarded initial-only preproduction migration CLI; disabled versioned integration declarations. No connector activation or Hermes isolation attestation.

Fresh local disposable verification: frozen install, typecheck, build; QA task02 2874, backend 28, runtime 62, connectors 48, RaaS 47; real MinIO storage 26 and pinned egress 47 assertions. Private-origin and shared Redis checks passed; Redis AOF survived independent restart. Empty-target migration applied 11 migrations with production runtime, then rejected a nonempty target. External Hatchet/Hermes customer execution, VPS DNS/connectivity, production storage SSE, domains/TLS and public identity remain unverified. Do not infer VPS success from local QA.

Phase-2 runtime evidence: SSH unlocked by operator; VPS CPU/RAM/disk measured directly. Core, Redis, Hatchet DB, S3 and Hatchet Lite healthy; 11 canonical-LF business migrations applied atomically only to verified-empty preproduction. Redis authenticated and AOF persisted through restart. Private S3 bucket AES256 SSE-S3 enabled with separate preproduction KMS secret and bucket-scoped app user. Three final Docker builds and local API/Web startup, Docker-DNS HTTP call, non-root execution, offline pnpm and API restart checks passed. Application deployment/live connections are still pending at this code commit; Hermes customer execution remains blocked. See infra/PREPRODUCTION.md.

Phase-2 compatibility finding: the initial API deployment at 2782736 was rejected by Coolify's generated curl/wget healthcheck despite successful Nest startup. Added curl to API/Web images, preserving platform health validation. Optional AnythingLLM resource now exists but is stopped. Actual Hatchet diagnostic task completed (21744469-4441-45af-a9f7-13e37d6b0d87); VPS ToolBroker/World Bank QA passed 48 assertions in a separate disposable database with a dedicated non-superuser QA role. This does not enable client Hermes execution. Full application deployment retest follows.

## Final phase-2 result — authoritative status
See docs/architecture/PREPRODUCTION_VERIFICATION.md. All ten requested resources exist individually: eight running healthy, Hermes and optional AnythingLLM deliberately stopped. API/Web/worker actual deployed image tags all match 541a60d0a9e1fffe9b3756b5918f225f3666d75f. Native persistent aliases fixed application UUID DNS assumptions. Authenticated MyDash returned 200 and displayed the real DRAFT mission after restarts. API and worker PostgreSQL/Redis/S3/Hatchet connections were tested on VPS; real Hatchet infrastructure task and isolated World Bank QA passed. Private encrypted technical mission exports signed 200 / anonymous 403; no fake business result. Independent API restart preserved the mission. Production stayed empty. Public DNS/TLS, real Hermes provider+confinement and production certification remain blocked.

## 2026-11-13 — qeynox.io and public signed HTTPS exports

Public verification is recorded in PUBLIC_ACCESS_VERIFICATION.md and supersedes the earlier missing-domain/public-download blockers. VPS eth0 and four DNS resolver/authoritative checks agree on 31.97.158.141. Native Coolify domain https://qeynox.io applied only to Web; valid Let's Encrypt/TLS1.3 certificate observed. Real rendered login form POST returned 303 to /fr/mydash; authenticated MyDash and the existing mission returned 200. Existing DRAFT mission persisted.

Only Web, storage, API and worker were restarted, without application rebuild. Bucket-only Traefik routing on the same host preserves SigV4 Host/path; API/worker now load QEYNOX_ARTIFACT_ENDPOINT=https://qeynox.io. Actual encrypted HTTPS uploads/HEAD/downloads passed from both processes. Existing JSON/HTML exports signed 200 and correct hashes; anonymous and expired signatures 403. Download attachment, sandbox/no-store/nosniff/no-referrer protections are present. S3 console/admin and internal API were not published. DB/Redis host port bindings remain empty. Hermes/AnythingLLM still exited, production still empty, other projects untouched. Application images remain 541a60d. This is not independent production/public-identity certification.

## 2026-11-13 — Global platform administration foundation (Mission 01)

Added a strictly separated internal administration layer over the existing identity core: migration
0012 (platform assignments, sessions, audit; 0001–0011 untouched), platform role/permission model,
separate session namespace, fail-closed global guard with mandatory per-route access policy, explicit
CLI bootstrap, audited assignment/revocation API, last-administrator protection and read-only
support/operations diagnostics. Design and permission matrix: docs/architecture/PLATFORM_ADMINISTRATION.md.

Reuse: AuthService.verifyCredentials (same scrypt/lockout path) and identity credentials; no
credential or session code duplicated, and the platform port never reads workspace memberships.

Verification: API typecheck and production tsc build PASS; qa:platform-authorization PASS
(107 assertions — real service/guard against in-memory ports plus real NestJS HTTP wiring with an
unreachable database). Hardened after adversarial review: assignment/revocation commit atomically with
session revocation and audit, last-admin revocation locks and re-counts inside the transaction,
append-only audit trigger, fail-closed guard for declared policies without the platform marker, and
best-effort denial auditing. qa:platform-admin (isolated PostgreSQL HTTP e2e) is BLOCKED in this
environment: no QEYNOX_QA_DATABASE_URL and no reachable Docker daemon. It reports BLOCKED and is not
claimed as passing. No push, merge, deployment or production change was performed.

## 2026-11-14 — Platform user administration (Mission 02)

Added the platform user-administration API over the existing identity tables (no second
authentication system, no credential writes, no deletion): paginated directory with e-mail search and
status filter, user detail (registration date, workspaces/roles, status, session summary, activity),
session metadata, merged activity timeline, reversible suspend/reactivate with mandatory
justification and atomic audit, scoped session revocation, and any-of route policies
(ADMINISTRATION/SUPPORT/…/CONSULTATION) extending the Mission 01 guard. Migration 0013 adds four
additive indexes only; 0001–0012 are untouched. Invitations, e-mail verification and account recovery
are explicitly blocked (503 NOT_CONFIGURED) behind a not-configured EmailTransport port: no message is
sent and no account state changes.

Verification: API typecheck and tsc build PASS; qa:platform-users PASS (107 assertions — parts A/B real
service/guard/controller metadata and HTTP wiring; part C isolated-PostgreSQL e2e BLOCKED without
QEYNOX_QA_DATABASE_URL); qa:platform-authorization regression PASS (107 assertions). Hardened after
adversarial review: suspension and revocation share one enabled-administrator rule under a PostgreSQL
advisory transaction lock (no lockout path), both session namespaces are revoked atomically on
suspension/session revocation, platform sessions and roles are disclosed only to ADMINISTRATION, the
account timeline is restricted to lifecycle actions, and workspace counts only ACTIVE memberships. No push, merge or
deployment; no production data touched.

## 2026-11-14 — Workspaces & organisations (Mission 03)

Extended the existing identity_workspaces/identity_memberships into a full organisation API: paginated
organisation/member consultation with roles and lifecycle dates, invitation of existing identity
accounts without any fake e-mail delivery (single-use hashed acceptance token, delivery explicitly
BLOCKED), role changes, access revocation, explicit multi-workspace switching with session rotation,
last-enabled-owner protection (including refusal to suspend the last enabled workspace owner), and
session revocation when a member loses their last active membership. Migrations 0014 (lifecycle
columns/indexes) and 0015 (invitation tokens) are additive; 0001–0013 untouched. No second
organisation entity, no deletion.

Verification on a disposable PostgreSQL 16.6 instance: qa:platform-organizations PASS (87 assertions:
two organisations, cross-tenant refusal, invitations/decline/reissue/token acceptance, last-owner
guards, workspace switching and invalidated sessions, audit, preserved rows). Regressions re-run on the
same isolated database: qa:platform-admin PASS (70), qa:platform-users PASS (165). Sandbox note: the
harness cannot complete DROP DATABASE (checkpoint signal denied), so teardown logged a warning and the
disposable server was stopped and deleted manually; assertions ran against the real database.
No push, merge or deployment.

## 2026-11-14 — Soul onboarding (Mission 05, code-only)

Added the pre-mission Soul onboarding flow required before any mission exists. It lives in the existing
`apps/api/src/soul` module, `packages/roles/src/soul.ts`, the existing consents/user_contexts tables and
`apps/web`: no second onboarding and no MyDash rework. Migration 0016 adds one progress table per
user/workspace (status, step, locale, consent reference, dates; no answer content). The existing
`/v1/soul/converse` contract (operationId + attemptId) is untouched and never called pre-mission;
onboarding has its own operation-free routes under `/v1/soul/onboarding` (view, start, answer, skip,
consent, pause, resume, dismiss, complete) plus `GET /v1/soul/consents` and `DELETE /v1/soul/context` for
context consultation, edition, deletion and consent revocation. Answers are only written as
user_context facts after the explicit consent step; a refused/revoked consent blocks memorisation.
Guidance is deterministic and explicitly labelled (`deterministic: true`, `aiAvailable: false`,
reason PRE_MISSION_CONTRACT): no fake LLM conversation is produced. The web route `/[lang]/soul`
offers one useful question at a time (activity, objectives, language, needs, preferences), skip/pause/
resume/dismiss, direct MyDash access and the consented-context panel; first login redirects there
while onboarding is NOT_STARTED/IN_PROGRESS/PAUSED. The first objective is completed through the
existing mission creation contract (`POST /v1/operations`) and redirects to the existing mission page.
Platform administration now receives per-workspace onboarding status/step/dates only (no private
content), displayed in QeyNox Control user detail.

NOT VERIFIED (per Mission 04–09 FAST MODE: code only): no typecheck, build, migration run, QA suite,
screenshot or certification was executed for this lot. No push, merge or deployment.

## 2026-11-14 — Customer support via Chatwoot (Mission 06, code-only)

Chatwoot is integrated as the external support engine; no CRM, no second messaging system and no
message duplication in PostgreSQL. Migration 0017 adds only the account ↔ Chatwoot contact/
conversation mapping (`support_chatwoot_links`); conversations, messages, status, priority and
history are read live from the Chatwoot REST API by a server-only adapter
(`apps/api/src/support/chatwoot.client.ts`). Missing `QEYNOX_CHATWOOT_*` server variables leave the
integration NOT_CONFIGURED: API status endpoints return the explicit reason (variable names only,
never values), customer pages show a blocked state instead of a form, and no request can pretend a
message was delivered. The Chatwoot API token never reaches a browser. Customer routes
(`/v1/support/*`, workspace session) are scoped by the authenticated user + active workspace through
the mapping; a user cannot read or reply to another user's conversation. `/[lang]/support` and the
MyDash "Contact support" entry reuse the existing web shell; reply/history/status/priority are shown
live. The platform Support inbox lives in QeyNox Control (`/admin/{lang}/support`, nav visible only
with the existing SUPPORT permission); replies and status changes are audited. Chatwoot webhooks are
not required by this design (no message is persisted or state-synced); any future webhook must verify
a shared secret before writing. No Coolify resource was created or started.

NOT VERIFIED (FAST MODE): no typecheck, build, migration run, Chatwoot provisioning or certification
was executed. No push, merge or deployment.
