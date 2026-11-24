# QeyNox 2027

QeyNox expands a person's business intelligence and capabilities through governed AI-assisted services. A user states an intention, selects a capability, receives a documented result and can return to or revise the operation at any time. **Results as a Service** (RaaS) means a verifiable deliverable, not a promise of a successful business outcome.

## Architecture

- QeyNox Core: canonical business state, consent, plans, attempts, evidence, results and policies (PostgreSQL).
- Hatchet: durable execution only, behind OrchestratorPort.
- Hermes Agent (Nous Research): initial agent runtime, behind EnginePort, replaceable.
- ToolBroker: explicit, scoped and auditable connector invocation; never free-form access.
- Soul: consent-aware, conversational context and preferences.
- QeyNox Pilot: business-level routing, approvals and continuation; not a workflow engine.
- Eight configurable business capability slots, not eight hard-coded invented businesses.
- MyDash / Quiet Authority: approved interface direction, intentionally out of scope in this branch.

Source: docs/architecture/ and the QeyNox product requirements. The historical iasser repository is **read-only reference material**, not a source of product rules.

## Repository layout

- `apps/api` — NestJS HTTP API (auth, operations, claims, results/commercial, operator/configuration, Soul/Pilot).
- `apps/worker` — Hatchet worker handler, step progression, outbox dispatcher and the isolated-QA scripts.
- `packages/{domain,application,persistence,contracts,roles,tools,engine,orchestration}` — business core and runtime ports.
- `docs/architecture` — ADRs, architecture, implementation map and progress ledger.
- `infra` — source deployment templates only (not verified).

## Verification (isolated QA only)

Requires Node.js ≥22, pnpm 9.15.9 and a local disposable PostgreSQL server exposed via `QEYNOX_QA_DATABASE_URL` (the scripts create and drop their own QA database; never point this at production). `qa:storage` additionally needs an isolated S3-compatible MinIO service via `QEYNOX_QA_S3_ENDPOINT`, `QEYNOX_QA_S3_ACCESS_KEY` and `QEYNOX_QA_S3_SECRET_KEY`; when a prerequisite is absent it reports BLOCKED and **exits 3** instead of faking a result — exit 0 is reserved for completed assertions and exit 1 for real failures (`qa:storage-selftest` regression-checks this contract without any S3 service).

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm qa:task02        # migrations, schema parity, operator configuration lifecycle
pnpm qa:backend       # NestJS DI, auth/session, HTTP contracts, tenant isolation
pnpm qa:agent-runtime # Hatchet SDK contracts, worker progression, Soul/Pilot wiring (local fixtures)
pnpm qa:connectors    # connector activation, egress/auth/rate-limit gates, real World Bank read
pnpm qa:raas          # real sourced claim → human verification → cited DELIVERABLE + exports
pnpm qa:egress        # private/reserved DNS rejection, connection pinning, redirect refusal, live pinned World Bank call
pnpm qa:storage       # real MinIO uploads, SHA-256 integrity, private/signed/expiry, tenant isolation, PENDING_UPLOAD recovery (BLOCKED exit 3 without QEYNOX_QA_S3_*)
pnpm qa:storage-selftest  # exit-code contract of qa:storage (0 PASS / 3 BLOCKED / 1 FAILED); PASS leg needs real QEYNOX_QA_S3_* + QEYNOX_QA_DATABASE_URL
pnpm qa:platform-authorization  # global platform administration authorization invariants + HTTP wiring (no database)
pnpm qa:platform-admin          # platform administration HTTP e2e against an isolated PostgreSQL database (BLOCKED without QEYNOX_QA_DATABASE_URL)
pnpm qa:platform-users          # platform user administration: permissions, pagination, revocation, isolation (part C needs QEYNOX_QA_DATABASE_URL)
pnpm qa:platform-organizations  # workspaces/organisations: memberships, invitations, roles, switching (needs QEYNOX_QA_DATABASE_URL)
```

Global platform administration (internal `PLATFORM_ADMIN`/`SUPPORT`/`OPERATIONS`/`AUDITOR` roles,
strictly separate from workspace `OWNER`/`ADMIN`/`MEMBER`) is documented in
`docs/architecture/PLATFORM_ADMINISTRATION.md`. The first administrator is granted only by the
explicit, audited bootstrap CLI: `QEYNOX_PLATFORM_BOOTSTRAP_ALLOW=true pnpm admin:bootstrap -- --email … --role … --confirm --reason …`.

A disposable MinIO can be started locally with generated credentials (never reuse production secrets), then pass the same values as `QEYNOX_QA_S3_*` for `qa:storage`.

Last consolidated baseline: `b51608b` plus the cleanup/08A commits. The five core isolated-QA suites total 3059 assertions; the focused storage and egress integration suites exercised a real isolated MinIO bucket (26 assertions) and a real pinned read-only World Bank request (47 assertions) **at that recorded baseline only**. Since the 2026-11-22 validation matrix, every `qa:storage` run without an operator-supplied S3 service reports BLOCKED (exit 3 since 2026-11-24; it printed BLOCKED but wrongly exited 0 before that) — the live storage leg is **currently UNVERIFIED**, and the suite now carries 27 assertions (the added namespace-refusal assertion has not yet been exercised against live MinIO). `qa:connectors` and `qa:raas` also make real read-only calls to the documented World Bank Indicators API; the Hermes model endpoint is a local deterministic QA fixture and no live model was called. Full evidence and blockers: `docs/architecture/PROGRESS.md` and `docs/architecture/IMPLEMENTATION_MAP.md`.

## Status

Source foundation with isolated-QA verification only. **NOT DEPLOYED / NOT PRODUCTION-READY.** Isolated MinIO storage (private uploads, signed expiry, tenant isolation, reconciliation) was verified against an isolated MinIO at the recorded baseline (see `docs/architecture/evidence`); no S3 service has been available in the QA environment since the 2026-11-22 matrix, so live storage infrastructure is **UNVERIFIED as of 2026-11-24** and no production object-storage bucket is configured or certified. External Hatchet dispatch/run observation, Hermes network/tool isolation, deployment egress firewall, provider licensing/freshness review and public identity hardening remain unverified deployment gates. No production data or external runtime credentials are configured in this repository.


## Incremental database releases

`pnpm db:release` defaults to read-only preflight, discovers the full migration release and supports
explicit `--mode dry-run` / guarded `--mode apply` on populated databases. Target parameters are required;
apply also requires a reviewed plan digest, backup/restore attestation and stopped writers. See
[the database release runbook](infra/DATABASE_RELEASE.md) for commands, resume and recovery.
Migrations are never an automatic application startup step. The old fixed-range SQL generator is retired.
