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

Reused the locally committed Graphify/UX mapping in `07236ac`; Graphify was not rerun. Confirmed no pre-existing `apps/web`, then added one Next.js 16.4.6 / React 19.3.1 / TypeScript application within the existing pnpm/Turbo workspace. Canonical Professional Blue tokens, responsive shell, EN/FR copy, outcome-first home, MyDash, recent missions, mission detail, session login/logout and contract-validated draft creation are implemented. Browser tokens are not exposed: the web server uses an HTTP-only SameSite cookie and the existing bearer/workspace API contract. No backend source changed.

Verification: `pnpm install --frozen-lockfile`, `pnpm --filter @qeynox/web typecheck`, `pnpm --filter @qeynox/web build` and `pnpm --filter @qeynox/web test:smoke` PASS (26 HTTP assertions). The smoke suite exercises built EN/FR pages, anonymous/session boundaries, genuine empty/loaded/denied/malformed API responses and absence of bearer tokens in HTML, using an isolated test-only HTTP fixture. No unrelated backend QA suite, production database, external runtime, push or deployment was run.

Limits: no browser/keyboard/contrast screenshot certification; approved-reference comparison BLOCKED because `docs/design/reference/concept-02-professional-blue.png` is absent. Login/logout/draft mutations against a real backend remain unverified. Capability catalogue availability is unknown, not assumed configured. Planning, quotes, execution, full Library discovery and artifact delivery UI remain outside this foundation; their API gaps remain in the UX plan. All existing runtime, public-identity and production certification gates remain unchanged.


