# ADR-021 — Hermes → Vertex AI / Gemini inference contract (A02)

- Status: Accepted (source verified, live inference BLOCKED)
- Date: 2026-11-19
- Supersedes the "no native vertex provider" note in `FAST_LIVE_QEYNOX.yaml`
- Scope: `packages/engine`, `apps/api`, `apps/worker`, `infra`

## Context

`FAST_LIVE_QEYNOX.yaml` recorded on 2026-11-16 that Hermes app 0.20.0 had "no native `vertex`
provider" and that Vertex would require a custom OpenAI-compatible endpoint plus OAuth2. Reading
the current upstream source (`NousResearch/hermes-agent`, `agent/vertex_adapter.py`,
`hermes_cli/config_defaults.py`, `hermes_cli/auth.py`) shows this is no longer true:

- `vertex` (aliases `google-vertex`, `vertex-ai`, `gcp-vertex`, `vertexai`) is a **first-class
  provider id**, listed in `_RUNTIME_FIRST_PROVIDER_IDS`.
- Authentication is **OAuth2 from a service-account JSON or ADC**, not an API key:
  `VERTEX_CREDENTIALS_PATH` (wins) or `GOOGLE_APPLICATION_CREDENTIALS`, plus `VERTEX_PROJECT_ID`
  and `VERTEX_REGION` (env over `config.yaml` `vertex:` section; region defaults to `global`,
  which Gemini 3.x preview models require).
- Hermes calls Vertex's OpenAI-compatible endpoint, so QeyNox's existing chat-completions wire is
  the correct one. **No second inference gateway is needed or built.**

The adapter also had real defects against the documented contract, verified in
`gateway/platforms/api_server*.py`:

| # | Observed behaviour in upstream source | Previous adapter behaviour | Consequence |
| --- | --- | --- | --- |
| 1 | Hard agent failure → **HTTP 502**, `code:"agent_incomplete"` | generic `INVALID_STATE` | failure was indistinguishable from a malformed answer |
| 2 | Soft partial/failed/cancelled → **200** with `finish_reason` `length`/`error`/`cancelled` and a `hermes{completed,partial,failed,error,error_code}` object | ignored the `hermes` object | a cancelled or failed turn could be recorded as agent output |
| 3 | `usage` is present but **all zeros** when nothing was observed | zeros propagated as real tokens | the ledger claimed provider-metered `0` tokens |
| 4 | 401 is `gateway_auth_error`/`gateway_auth_failed` | reported as `INVALID_STATE` | a credential problem looked like a contract violation |
| 5 | 429 `rate_limit_exceeded` + `Retry-After` | reported as `INVALID_STATE` | a retryable condition was treated as a defect |
| 6 | Timeout and cancellation were one message | both mapped to "interrupted or timed out" | operators could not tell a slow provider from a caller cancel |
| 7 | `X-Hermes-Completed`/`-Partial`/`-Error` headers carry the same facts | ignored | the only structured failure signal on an unparsable body was lost |

## Decision

1. **Provider ownership stays in Hermes.** QeyNox never holds the Vertex service-account key,
   never mints Google tokens and never calls Google directly. It sets `HERMES_MODEL` (and an
   optional `HERMES_PROVIDER` hint for diagnostics) and sends `model` in the request.
2. **The wire contract is parsed explicitly** in `packages/engine/src/hermes-contract.ts` (pure,
   unit-tested): disposition precedence is `failed`/`finish_reason:"error"` → provider failure,
   then `cancelled` → cancelled, then `length`/`partial` → incomplete, then the narrow legacy
   provider-failure text patterns, else an answer. A failure flag always beats answer text, so an
   error can never be reported as a completed result.
3. **Zero usage is not zero tokens.** `normalizeUsage` withholds an all-zero block, so the budget
   ledger records `ESTIMATED`/`unknown` instead of claiming provider measurement.
4. **Cancellation is client-side only** and is reported as such. The API server exposes no stop
   route for non-streaming chat completions; only `/v1/runs/{id}/stop` interrupts run-mode turns.
   We therefore do not claim server-side cancellation.
5. **Diagnostics are redacted and evidence-based** (`packages/engine/src/hermes-diagnostics.ts`):
   `/health`, `/v1/models` and `/v1/toolsets` are read, and native-tool isolation is reported as
   *evidenced* only when every API-server toolset is `enabled:false`. An unreadable inventory is
   `UNKNOWN`, never `true`.
6. **Two separate gates.** The isolated contract suite (`pnpm qa:hermes-contract`) proves the
   wire/security contract against a deterministic fixture and can never prove inference. The
   mandatory positive test (`pnpm qa:hermes-live`) requires operator-supplied endpoint and
   credentials and returns **BLOCKED (exit 3)** when they are absent — never PASS.
7. **Native tool confinement is unchanged**: any `tool_calls`/`function_call` response is `DENIED`,
   because such a call cannot be ToolBroker-mediated.

## Consequences

- `HermesAdapter` accepts `privateOrigin`, `provider`, `vertexRegion` and an `onDiagnostic` sink.
  The private origin was already supported by the worker but was **not** passed by the API module;
  it now is, so an internal HTTP endpoint can be authorized explicitly in both processes.
- Timeouts raise `UNAVAILABLE` (retryable), cancellation raises `UNAVAILABLE` with
  `hermesFailure:CANCELLED`, wrong credentials raise `NOT_CONFIGURED`, and malformed or partial
  bodies raise `INVALID_STATE`. No failure path returns an `EngineOutcome`.
- `apps/worker/scripts/hermes-diagnose.ts` (`pnpm hermes:diagnose`) prints deployment facts and
  exits 3 while any prerequisite or isolation evidence is missing. It never sets an attestation.

## What is verified, and what is not

VERIFIED IN ISOLATION (no model, no network):

- `pnpm qa:hermes-contract` — 57 assertions over every documented response shape, the isolation
  gate, timeout vs cancellation, redaction and classification precedence.
- `pnpm qa:hermes-live-selftest` — 15 assertions proving the live procedure's exit codes
  (BLOCKED / PASS / isolation-gap) and that the API key never reaches the output.

NOT VERIFIED — BLOCKED:

- **Real inference through Hermes to Vertex/Gemini has not been performed in this environment.**
  There is no Vertex service-account credential and no reachable Hermes deployment here.
  `pnpm qa:hermes-live` exits **BLOCKED (3)** and that is the correct result, not a pass.
- Native-tool isolation at the deployment is an operator attestation backed by the `/v1/toolsets`
  inventory; the network-level containment it claims still requires deployment review.
- Server-side cancellation remains unobservable for this wire.

## Operator procedure (see docs/architecture/HERMES_VERTEX_LIVE_RUNBOOK.md)

Short form, inside the private network:

1. Configure `config.yaml` `vertex:` + `VERTEX_CREDENTIALS_PATH`, set `model.provider: vertex`,
   and apply `platform_toolsets.api_server: []`.
2. `pnpm hermes:diagnose` → must exit 0 (no enabled toolset, authenticated, model advertised).
3. `QEYNOX_QA_HERMES_URL=... QEYNOX_QA_HERMES_KEY=... pnpm qa:hermes-live` → must print
   `PASS: real inference verified`.
4. Only then set `QEYNOX_RUNTIME_VERIFIED_LIVE=true` with
   `QEYNOX_RUNTIME_VERIFICATION_EVIDENCE=<the recorded run id + date>` (A01 gate).

## Non-goals

No Vertex credential was created, no attestation was set without evidence, and the Hermes API
server is still never exposed publicly.
