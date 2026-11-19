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

Verification is never inferred from a configuration flag. `apiRuntimeReadiness` requires
`QEYNOX_RUNTIME_VERIFIED_LIVE=true` **and** evidence (`QEYNOX_RUNTIME_VERIFICATION_EVIDENCE`) before
reporting `OPERATIONAL`; the engine additionally requires `HERMES_NATIVE_TOOLS_ISOLATED=true` and
`QEYNOX_NETWORK_POLICY_ATTESTED=true`.

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
  The worker honours `QEYNOX_QA_ALLOW_UNVERIFIED=true` only as an explicit, non-production QA opt-in.
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
