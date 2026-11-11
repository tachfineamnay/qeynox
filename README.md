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

Requires Node.js ≥22, pnpm 9.15.9 and a local disposable PostgreSQL server exposed via `QEYNOX_QA_DATABASE_URL` (the scripts create and drop their own QA database; never point this at production):

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm qa:task02        # migrations, schema parity, operator configuration lifecycle
pnpm qa:backend       # NestJS DI, auth/session, HTTP contracts, tenant isolation
pnpm qa:agent-runtime # Hatchet SDK contracts, worker progression, Soul/Pilot wiring (local fixtures)
pnpm qa:connectors    # connector activation, egress/auth/rate-limit gates, real World Bank read
pnpm qa:raas          # real sourced claim → human verification → cited DELIVERABLE + exports
```

Last consolidated baseline: `b51608b` (plus the local cleanup commit). The five isolated-QA suites total 3059 assertions and passed from a frozen lockfile, typecheck and production builds. `qa:connectors` and `qa:raas` make real read-only calls to the documented World Bank Indicators API; the Hermes model endpoint is a local deterministic QA fixture and no live model was called. Full evidence and blockers: `docs/architecture/PROGRESS.md` and `docs/architecture/IMPLEMENTATION_MAP.md`.

## Status

Source foundation with isolated-QA verification only. **NOT DEPLOYED / NOT PRODUCTION-READY.** External Hatchet dispatch/run observation, Hermes network/tool isolation, production object storage, provider licensing/freshness review and public identity hardening remain unverified deployment gates. No production data or external runtime credentials are configured in this repository.
