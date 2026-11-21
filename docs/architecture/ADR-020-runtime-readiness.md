# ADR-020 — Runtime readiness: four-state model (A01)

- Status: Accepted
- Date: 2026-11-19
- Scope: `packages/application`, `apps/api`, `apps/worker`, `apps/web`, `apps/control`

## Context

Configuration records existing in the database were being reported as execution availability. A
capability slot could appear "available" while the agent engine (Hermes) had never been invoked
against a live endpoint, while its native-tool isolation and egress attestations were absent, while
no verification policy was active for the capability, or while the workspace budget was missing.
The interface therefore sometimes offered a launch that the backend would refuse.

Two facts had been conflated:

1. **Configuration present** — operator configuration records exist (capability, profile, provider,
   verification policy, budget, offer, order).
2. **Operational** — the runtime has actually been verified live: the engine was invoked
   successfully with evidence recorded, isolations/egress attestations are present, and the
   orchestrator is reachable.

A QA fixture that parses a documented Hermes wire response proves the *contract*, never the
*deployment*.

## Decision

Execution availability is a four-state value, in `packages/application/src/runtime-readiness.ts`:

| State | Meaning | Executable |
| --- | --- | --- |
| `BLOCKED` | At least one hard prerequisite is missing or unattested. | Never |
| `UNVERIFIED` | Prerequisites are present, but live runtime verification is absent. | Never |
| `CONFIGURED` | Configuration records present, runtime not yet evaluated. | Never |
| `OPERATIONAL` | Prerequisites present **and** live verification recorded. | Yes |

Computation (`computeOperationalState`) is monotone:

```
!configured || missing > 0  -> BLOCKED
!attested                   -> BLOCKED
!verifiedLive               -> UNVERIFIED
otherwise                   -> OPERATIONAL
```

`RuntimeReadiness` gains `overallState` and `canExecute`; `canExecute` is `true` only for
`OPERATIONAL`. Each `RuntimeComponent` gains `state`, `verifiedLive`, `attested` and `evidence`.

Verification is never inferred from a configuration flag. ~~`apiRuntimeReadiness` requires
`QEYNOX_RUNTIME_VERIFIED_LIVE=true` **and** evidence (`QEYNOX_RUNTIME_VERIFICATION_EVIDENCE`) before
reporting `OPERATIONAL`~~ — superseded by the A21.07 amendment below: an operator boolean plus a free
string was itself a flag, and the worker defaulted the evidence to `"live-probe"`. The engine still
requires `HERMES_NATIVE_TOOLS_ISOLATED=true` and `QEYNOX_NETWORK_POLICY_ATTESTED=true` as
preconditions.

## A21.07 amendment — verification by bounded live probes (2026-11-21)

- **Evidence source.** Each process (API, worker) runs its own `RuntimeProbeMonitor`
  (`packages/application/src/runtime-probes.ts`). `QEYNOX_RUNTIME_VERIFIED_LIVE` and
  `QEYNOX_RUNTIME_VERIFICATION_EVIDENCE` are no longer read; no default evidence exists.
- **Two components, two records.** Hermes (`probeHermes`: `/health` reports `hermes-agent` + version,
  the key is accepted, `/v1/toolsets` exposes no enabled toolset, the model is advertised) and Hatchet
  (`probeHatchet`: `/api/ready`, `/api/v1/version`, `/api/v1/tenants/{sub}` answers for the token's own
  tenant, engine gRPC accepts a TCP connection) are probed, stored and evaluated independently. One
  failing never alters the other's evidence.
- **Evidence record** (`RuntimeProbeEvidence`): component, unique `probe:<component>:<uuid>` reference,
  probed endpoint origin, verified identity `{endpoint, deployment, version}` (success only),
  outcome + failure class + scrubbed detail, startedAt/observedAt/expiresAt, duration, and an internal
  configuration fingerprint (endpoint + credential digest) that is never serialized.
- **Verification states** per component: `NOT_CONFIGURED`, `NOT_PROBED`, `VERIFIED`, `FAILED`, `STALE`
  (at/after `expiresAt`, or observed in the future), `TARGET_CHANGED` (endpoint or credential changed).
  Mapping: missing config or attestation → `BLOCKED`; `FAILED` → `BLOCKED` (`*_UNAVAILABLE`);
  `NOT_PROBED`/`STALE`/`TARGET_CHANGED` → `UNVERIFIED` (`*_UNVERIFIED`); `VERIFIED` + attested →
  `OPERATIONAL`. `canExecute` requires **both** components `OPERATIONAL`.
- **Bounds.** `QEYNOX_RUNTIME_PROBE_TIMEOUT_MS` (5000, 250..15000) per component, enforced by the
  monitor even if a probe ignores its abort signal; `QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS` (120,
  10..900); `QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS` (30, 5..freshness/2). Concurrent probes of one
  component share one in-flight probe. A stale pooled connection is retried once inside the deadline.
- **Restart.** Evidence is in memory only, so a restarted process starts `NOT_PROBED` and must probe.
- **Gates.** `OperationExecutionService` now *requires* a runtime source and refuses `start` before
  any beta allowance, attempt or outbox row is written (`NOT_CONFIGURED` → 503 when unproven,
  `UNAVAILABLE` → 502 when a probe failed). The worker re-checks with `freshReadiness()` before each
  step. `QEYNOX_QA_ALLOW_UNVERIFIED` is honoured only in an explicitly isolated QA run (P08, below).
- **Exposure.** Customers (`/readiness` prerequisites, beta journey) get only
  `{status, failure, checkedAt, expiresAt}` per component; operators (`/v1/platform/capabilities`)
  get the full verification record. No credential appears in either (tested).
- **Verification.** `pnpm qa:runtime-verification` (real sockets, PostgreSQL and HTTP against local
  Hermes/Hatchet fixtures) and the extended `pnpm qa:runtime-readiness`.

## Consequences

- `capabilityAvailability` now reads active `verificationPolicies` per capability. Missing policy is
  a hard `BLOCKED` prerequisite, not a warning.
- `CapabilityCatalogueService.snapshot()` computes `available` from `operationalState === 'OPERATIONAL'`
  instead of `providerReady && profileReady`. The legacy fields (`providerReady`, `profileReady`,
  `missingProviders`) are retained; `policyReady`, `missingPolicies`, `operationalState` and
  `isExecutable` are added.
- `PlanReadService.readiness()` adds `prerequisites.policy` and
  `prerequisites.executionAuthorization`, the blockers `POLICY_NOT_CONFIGURED`, `ENGINE_UNVERIFIED`,
  `ORCHESTRATOR_UNVERIFIED` and `ENGINE_NOT_ATTESTED`, and gates `canStart` on `OPERATIONAL` rather
  than "no blockers".
- `ExecutionEngineSelection.selectOperational()` refuses a runtime without `verifiedLive` **and**
  evidence. The worker uses it for tenant execution; `select()` remains for isolated QA fixtures.
  The worker honours `QEYNOX_QA_ALLOW_UNVERIFIED=true` only inside an explicitly isolated QA run
  (P08, `apps/worker/src/qa-runtime-bypass.ts`). All of these must hold:
  - `QEYNOX_QA_ENVIRONMENT=isolated`;
  - `NODE_ENV` unset, `test` or `development`, and no `QEYNOX_DEPLOYMENT_ENV`;
  - the connected `DATABASE_URL` is a loopback `qeynox_qa_*` database, and `QEYNOX_QA_DATABASE_URL` is a
    loopback URL;
  - Hermes, if configured, is a loopback double;
  - no `HATCHET_CLIENT_TOKEN` is set.

  Otherwise the bypass is refused (warned once, by condition name only) and the gate applies.
  Staging, preproduction and production workers can never run on an unverified runtime.
- The catalogue reads the runtime of the process that owns the configuration: the API injects
  `apiRuntimeReadiness` into `CapabilityCatalogueService` and `PlatformCatalogueService` forwards its
  runtime source to the catalogue.

## Verification

`pnpm qa:runtime-readiness` runs both suites (`packages/application/scripts/`):

- positive: 38 assertions — `OPERATIONAL` only with configuration + attestations + live verification;
- negative: 19 assertions — config-only (`UNVERIFIED`), missing attestation, missing engine env,
  missing orchestrator, missing policy/profile/provider, `failClosedRuntime`, and QA-contract
  success remaining `UNVERIFIED`.

Cross-surface suites re-run unchanged: `node apps/web/scripts/smoke.mjs` (91 assertions),
`node apps/web/scripts/flow2-mission-qa.mjs` (35, plus 8 RUNNING and 6 RESULT variants),
`infra/tests/control-origin.ts`, `infra/tests/private-origins.ts`.

## Non-goals

No credential, deployment or provider configuration was changed. No live Hermes/Hatchet endpoint was
contacted. `OPERATIONAL` is reported only where the deployment already carries the verification
evidence.
