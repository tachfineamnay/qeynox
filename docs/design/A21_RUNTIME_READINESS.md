# MISSION A21.07 — Truthful runtime readiness

Status: implemented on branch `arena/6b29158c-qeynox` (off `72521d7`) as a draft PR. Not merged, not deployed.

## Defect

Runtime readiness (ADR-020) claimed to require evidence. In practice it required two environment values:

- `QEYNOX_RUNTIME_VERIFIED_LIVE=true`, an operator boolean;
- `QEYNOX_RUNTIME_VERIFICATION_EVIDENCE`, a free string. The worker defaulted it to `"live-probe"`, so a
  boolean alone made the runtime "verified".

The same flag covered both Hermes and Hatchet. Nothing probed either one, nothing expired, and a restart
or an endpoint change kept the claim. The API also let a mission start without checking the runtime;
only the worker did, later.

## Decision

### Evidence comes only from bounded live probes run by the process itself

`RuntimeProbeMonitor` (`packages/application/src/runtime-probes.ts`) holds at most one evidence record
per component, in memory. Each process (API, worker) has its own monitor. Nothing is persisted or read
from the environment, so a restarted process starts `NOT_PROBED`.

| Component | Probe | Proves | Identity recorded |
| --- | --- | --- | --- |
| Hermes (`packages/engine/src/hermes-diagnostics.ts`) | `GET /health` (no credential), `GET /v1/models`, `GET /v1/toolsets` (bearer key) | reachable, reports `platform: hermes-agent` and a version, healthy, key accepted, no enabled toolset (native-tool isolation evidenced), configured model advertised | endpoint origin, `hermes-agent`, reported version |
| Hatchet (`packages/orchestration/src/hatchet-probe.ts`) | `GET /api/ready`, `GET /api/v1/version` (no credential), `GET /api/v1/tenants/{sub}` (bearer token), TCP connect to engine gRPC | API ready, version reported, token accepted **for the tenant it names** (`metadata.id === sub`), engine reachable | API origin, `tenant <id> (<slug>)`, reported version |

The Hatchet API and gRPC addresses come from the token claims (`server_url`, `grpc_broadcast_address`).
`HATCHET_CLIENT_API_URL` and `HATCHET_CLIENT_HOST_PORT` can override them, as in the SDK.

### Evidence record and verification states

`RuntimeProbeEvidence` contains:

- the component;
- a unique `probe:<component>:<uuid>` reference;
- the probed origin;
- the outcome, a failure class and a scrubbed, bounded detail;
- the identity (success only);
- `startedAt`, `observedAt`, `expiresAt` and the duration;
- an internal fingerprint of endpoint + credential digest, which is never serialized.

Evaluation (`evaluateRuntimeComponent`) is pure and runs on every read against the current
configuration and clock:

| Status | When | Component state | Plan-read blocker |
| --- | --- | --- | --- |
| `NOT_CONFIGURED` | a prerequisite is missing | BLOCKED | `*_NOT_CONFIGURED` |
| (attestation missing) | `HERMES_NATIVE_TOOLS_ISOLATED` / `QEYNOX_NETWORK_POLICY_ATTESTED` not `true` | BLOCKED | `ENGINE_NOT_ATTESTED` |
| `NOT_PROBED` | configured, no evidence in this process (or a "success" without identity) | UNVERIFIED | `*_UNVERIFIED` |
| `FAILED` | the latest probe of this exact target failed | BLOCKED | `*_UNAVAILABLE` |
| `STALE` | at or after `expiresAt`, or observed in the future | UNVERIFIED | `*_UNVERIFIED` (expired) |
| `TARGET_CHANGED` | endpoint or credential changed since the probe | UNVERIFIED | `*_UNVERIFIED` (configuration changed) |
| `VERIFIED` | fresh success of the current target, attested | OPERATIONAL | — |

`canExecute` requires **both** components to be OPERATIONAL; one never stands in for the other.

Failure classes: `TIMEOUT`, `UNREACHABLE`, `UNHEALTHY`, `AUTH_REJECTED`, `IDENTITY_MISMATCH`,
`ISOLATION_NOT_EVIDENCED`, `MODEL_NOT_ADVERTISED`, `INVALID_RESPONSE`, `PROBE_ERROR`.

### Bounds

- **`QEYNOX_RUNTIME_PROBE_TIMEOUT_MS`** (default 5000, clamped to 250..15000): the bound for one
  component. The monitor races the probe against its own deadline, so a probe that ignores its abort
  signal is still cut off.
- **`QEYNOX_RUNTIME_PROBE_FRESHNESS_SECONDS`** (default 120, clamped to 10..900): the evidence
  lifetime.
- **`QEYNOX_RUNTIME_PROBE_INTERVAL_SECONDS`** (default 30, clamped to 5..freshness/2): the background
  re-probe period. The timer is `unref`'d.
- **`QEYNOX_RUNTIME_PROBES=off`**: disables API background probing. Readiness then stays `NOT_PROBED`,
  which fails closed.
- **Concurrent probes** of one component share one in-flight probe.
- **Stale connections:** after a runtime restart, a pooled keep-alive socket fails on first use
  (`UND_ERR_SOCKET`). That says nothing about the deployment, so the idempotent GET is retried once
  inside the same deadline. QA found this; without the retry a restarted runtime looked unreachable for
  a full interval.

### No credential leakage

- Probes send the Hermes key only to `/v1/*` and the Hatchet token only to the tenant endpoint.
- Recorded details carry status codes and network codes, never remote free text. Every recorded string
  is scrubbed of the configured secret values; details also pass through `redactSecrets`.
- Identity fields are scrubbed of exact secrets only, because the heuristic would erase a tenant UUID.
- Endpoints are recorded as origins, so URL credentials are dropped.
- The fingerprint is a truncated SHA-256 of a SHA-256 credential digest. It is never serialized.

### Gates

- **API:** `OperationExecutionService` now **requires** a runtime source (no default). `start` calls
  `runtimeExecutionBlocker` first, before any beta allowance, attempt or outbox row is written:
  - `NOT_CONFIGURED` (503) when a component is unproven;
  - `UNAVAILABLE` (502) when a probe failed.
- **Worker:** before each step it runs `runtimeExecutionBlocker(await monitor.freshReadiness())`. That
  re-probes, bounded, anything not VERIFIED, then calls `selectOperational`. The Hermes engine
  registration reads `verifiedLive`/`evidence` from the monitor at selection time.
- **QA opt-out:** `QEYNOX_QA_ALLOW_UNVERIFIED` is now ignored when `NODE_ENV=production`.

### API and customer surfaces

- **`GET /v1/operations/:id/readiness`:**
  - `prerequisites.engine` and `prerequisites.orchestrator` gain
    `verification: {status, failure, checkedAt, expiresAt}`;
  - blockers are per component;
  - `operationalState` is UNVERIFIED only when the runtime `*_UNVERIFIED` blockers are the only ones.
- **`GET /v1/workspaces/current/beta-access/journey`:** `runtime` gains `engine` and `orchestrator`
  summaries.
- **`GET /v1/platform/capabilities`** (operators): the full `verification` record per component
  (status, evidence reference, endpoint, identity, outcome, failure, detail, observedAt, expiresAt).
- **Web** (`apps/web/src/lib/runtime-copy.ts`):
  - the beta card and the mission prerequisites list show one row per component, in EN/FR words
    ("Verified by a live check · checked … · valid until …", "Unavailable: the last live check failed
    (it did not answer in time)", "Not yet verified by a live check");
  - `data-verification` attributes are present;
  - status is never shown by colour only;
  - a missing or malformed summary is shown as `NOT_PROBED`, never as verified;
  - a prerequisite row is ✓ only when `verifiedLive === true` and the status is `VERIFIED`.
- **Control** (Settings → Runtime): a badge plus a key/value list per component, and a note that
  verification comes from live probes and cannot be declared.

## Verification

- **`pnpm qa:runtime-verification`** (new, `apps/api/scripts/qa-runtime-verification.ts`): 15 groups,
  146 assertions.
  - Setup: real sockets against local Hermes/Hatchet fixtures (`qa-runtime-fixtures.ts`), real
    PostgreSQL, the real HTTP API.
  - Probe states covered: missing evidence, Hermes-only, Hatchet-only, both, stale (injected clock),
    timeout (250 ms, the other component unaffected), process restart, runtime restart with a new
    version, gRPC down, configuration change per component, the failure matrix, in-flight sharing,
    `freshReadiness`, and the ignored operator boolean.
  - Launch gate covered: nothing consumed when refused; HTTP 503/502/201; journey summaries; operator
    evidence; boot-time background probing; and no credential in 49 readiness/HTTP payloads plus 12 raw
    evidence snapshots.
- **`pnpm qa:runtime-readiness`:** 70 + 27 (was 38 + 19). It adds pure evaluation of every status, plus
  the monitor deadline, error and scrubbing behaviour with stub probes.
- **Beta suites:** `qa:beta-access`, `qa:beta-execution` and `qa:beta-journey` now get a verified runtime
  from the same fixtures through the API's own monitor (`startVerifiedRuntime`), instead of the removed
  flag. Their assertions are unchanged; the journey gains two.
- **Screenshots:** `docs/design/screenshots/a21-07/`, covering MyDash beta card states VERIFIED, FAILED
  and NOT_PROBED in EN/FR at 390 and 1440 px, with no horizontal overflow.

## Honest boundary

- No real Hermes or Hatchet deployment was contacted; the fixtures implement the documented endpoints.
- No worker ran a step against the new gate; its components (`freshReadiness`,
  `runtimeExecutionBlocker`) are tested directly.
- The control settings page was typechecked and built, not screenshotted.
- `PlatformOperationsService.health` still reports only PostgreSQL. It makes no runtime claim, and
  runtime probe checks were not added there.
- Native-tool isolation is evidenced by `/v1/toolsets`. Egress containment remains an operator
  attestation (`QEYNOX_NETWORK_POLICY_ATTESTED`) that no probe can prove.
