# P17 — Hermes Vertex integration verification (2026-11-22)

Branch: `arena/fe89c774-qeynox`. Starting HEAD and fetched `origin/main` both
`79187dff6fc371d836d708f07445582ceda28560` (P16 merged). `AGENTS.md` and the existing
`docs/architecture/HERMES_VERTEX_LIVE_RUNBOOK.md` were read before implementation.

**Verdict: source/configuration integration implemented and locally checked. Real inference,
Vertex authentication and isolation certification remain DEFERRED TO P22. No deploy/live changes.**

## Implemented boundaries and gaps

1. **Private endpoint:** existing `qeynox-hermes:8642/v1/` / exact private-origin authorization reused;
   no public API/dashboard route or published host port added.
2. **Hermes-only credentials:** mandatory private regular-file read-only SA mount outside persistent
   home, with `create_host_path:false`; no SA/env/provider tokens added to API/Worker/Web/Control.
   App release diagnostics reject Google/Vertex credential paths, provider API keys, inline SA JSON
   and private-key material. Common secret filenames excluded from Git/Docker contexts.
3. **Model/provider:** offline renderer reuses hardened config template, requires explicit project,
   region and `google/gemini-*` model, renders Vertex default plus exact discoverable model route.
   Gateway + agent read the same home config mount; the old volume/file is retained underneath it.
4. **Discovery/auth:** exact model required; valid-key inventory is accompanied by a random wrong-key
   rejection challenge. Accept-all-keys servers cannot prove auth. Inventory is not Google access proof.
5. **Native tools:** explicit API toolsets empty, MCP empty, fallback chain empty, direct arbitrary
   model passthrough/multiplexing disabled in desired configuration. Malformed/missing/empty inventories
   cannot be misread as isolation. No attestation defaults were turned on.
6. **ToolBroker:** existing proposal-only adapter and scoped broker permissions/consent/approval/budget/
   authorization/egress/idempotency path retained. Native function/tool-call output refused.
7. **Bounds/classification:** inference deadline 250..120000ms; cancellation vs timer distinct;
   response <=2MiB; bounded whole discovery deadline; provider IAM/quota/model/config failures distinct
   from gateway auth/transport/malformed errors. No auto-retry or provider fallback.
8. **Readiness:** existing independent fresh per-process Hermes/Hatchet monitor retained. Provider and
   timeout now join model/key/endpoint evidence fingerprint. Unknown model discovery cannot pass.
9. **Accounting:** zero/unknown token usage never becomes metered-zero; invalid or inconsistent counts
   withheld, storage integer bounds enforced. Existing successful cost settlement remains the reviewed
   conservative per-call ceiling with ESTIMATED origin; uncertain calls remain UNKNOWN/reserved. No
   Gemini price guessed, no financial schema/history/payment policy change.
10. **Observability:** API/Worker share settings loader and emit structured facts without prompt/answer/
    remote-error bodies. Persisted worker failure events add allowlisted engine failure/recovery codes
    while preserving original domain error codes and Hatchet lifecycle. Recovery is a recommendation,
    not blind retry permission or proof a provider call was cancelled.

Hermes local Docker health checks dependency imports, regular-file permissions, service-account parse,
matching generated config and local liveness **inside Hermes only**. This does not mint OAuth tokens,
call Google, infer, or prove actual confinement. Image/dependency/mount behavior needs P22 validation.

## Local verification

- Frozen pnpm 9.15.9 dependency installation: PASS; lockfile unchanged.
- `pnpm qa:hermes-contract`: PASS **57 assertions**, existing isolated wire fixture; not inference.
- `pnpm qa:hermes-vertex-contract`: PASS **7 tests**, deterministic local HTTP fixtures/offline config:
  auth rejection/enforcement, model discovery, strict toolset shape, independent failure/recovery,
  provider-change invalidation, total deadline, bounded body/native-call refusal, classified failures,
  log redaction, usage normalization, offline rendering and Hermes-only credential/mount contracts.
- `pnpm qa:runtime-readiness`: PASS **70 + 27 assertions**, existing pure readiness/negative fixtures.
- `pnpm release:test`: PASS **7 tests**, P16 local regression guards.
- `pnpm typecheck`: PASS **6 tasks** (engine source/new tests included) plus release-tool typecheck.
- `pnpm --filter @qeynox/api --filter @qeynox/worker build`: PASS **2 targeted TypeScript builds**.
  Full Next/image/backend QA campaign not requested or claimed.
- Desired Hermes YAML parsed using installed `yaml`; extracted Python health command syntax-compiled.
  No health command executed, credential file opened or Google package imported by these checks.
- Offline renderer with missing settings: expected BLOCKED / exit 1, names only the three required
  non-secret routing keys; no network/credential fallback.
- Migration SQL and pnpm lockfile unchanged; `git diff --check` clean.

Initial typechecking caught an implicit unknown tool element type and the downstream onboarding reason
union needing the new INVALID_MODEL/INVALID_ENDPOINT reasons; both were fixed before passing checks.
No test/assertion/readiness rule was removed or weakened. Unit/fixture tests never set live evidence.

## Upstream contract review

Read-only GitHub source review of `NousResearch/hermes-agent` tag `v2026.8.3`, reference
`7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2` (same tag already used by the existing manifest):
- `website/docs/guides/google-vertex.md` / `agent/vertex_adapter.py`: service-account path precedence,
  OAuth refresh ownership, `google/` model prefix, global Gemini 3 region, project/region config/env.
- `gateway/config.py`: gateway reads `HERMES_HOME/config.yaml`; `HERMES_CONFIG` alone is insufficient.
- `gateway/platforms/api_server.py`: model route aliases, authenticated model/toolset inventory,
  explicit toolset enabled state, native tool surface and default direct-model passthrough behavior.
- `docker/entrypoint.sh` / `docker/stage2-hook.sh`: retain existing s6 entrypoint/capabilities/volume;
  no untested entrypoint replacement or UID guess added.

Source URLs are under
`https://github.com/NousResearch/hermes-agent/tree/7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2`.
This is upstream **source evidence**, not confirmation that the current live image/config matches it.

## Not executed / remaining P22 gates

- No live Coolify inspection/mutation, deploy, restart, credential change, service-account read/upload,
  OAuth mint/refresh, Google/Vertex API request, inference or `qa:hermes-live`.
- No Docker executable available: image startup, google-auth/requests availability, s6/read-only mount
  behavior, real UID/mode, private DNS/firewall/stale public-router removal remain unverified.
- No real model/IAM/region/quota/latency/usage correctness or isolation/egress evidence fabricated.
  Inspect existing home env/gateway/profile/managed overrides before any separately authorized rollout.
- No database connection, migration, production/customer/financial data action, payment activation,
  `iasser` operation, merge, workflow architecture change or new scheduling mechanism.
- P22 must certify actual private model inference and all independent security/accounting/recovery
  gates. A green local test/typecheck is not OPERATIONAL Vertex evidence.

Operator procedure and rollback boundaries: [Hermes Vertex runbook](../docs/architecture/HERMES_VERTEX_LIVE_RUNBOOK.md).
