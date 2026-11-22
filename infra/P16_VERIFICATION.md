# P16 verification — 2026-11-22

Scope: `arena/97c1cda6-qeynox`, based on main `b19efa55e53b5798086392f63a0cd9044d7c2c71`.
This report distinguishes **local source/configuration checks** from unperformed image/live checks.
See [COOLIFY_RELEASE.md](COOLIFY_RELEASE.md) for operator procedures and remaining gates.

## Implemented

- Web/API/Worker/Control immutable release SHA/version build args, image stamp/OCI labels,
  Turbo build env hashing, Next deployment identity, runtime/image skew refusal, health metadata.
- Shared complete required/optional/conditional env contracts, role examples and sanitized missing-key
  diagnostics; mandatory `BETA_FREE` / `INVITE_ONLY`, Stripe/startup migration/bootstrap bypass refusal.
- Bounded dependency TCP checks plus PostgreSQL SELECT 1/Redis authenticated PING at future startup; matching API SHA/version required for Web/Control/Worker startup;
  no automatic migrations. HTTP health is explicitly liveness, not runtime/DB credential proof.
- App-only release topology with private API/Worker, no database/public ports or stateful recreation;
  explicit network/identity contracts for preserved PostgreSQL, Redis, S3, Hatchet and Hermes.
- Exact `/admin` OR `/admin/` routing with higher priority/no stripping; Control health under basePath.
- Direct Node entrypoint with correct role working directory, SIGTERM/init/300-second drain config,
  existing managed worker lifecycle retained, atomic bounded worker liveness heartbeat.
- Private S3 document PUT/GET and artifact GET relay: encrypted expiring session/workspace/method-bound
  grants, live session check, private endpoint/bucket/prefix allowlist, redirect refusal, 10 MiB bounded
  buffering, same-origin upload and no-store/attachment download headers. No browser S3 credentials.
- Desired S3/Hermes/Hatchet service manifests have no public router. Persistent volume names, image pins,
  resource UUID references and financial/migration history retained. Current running routes are unknown.
- Scoped GET-only Coolify inventory, offline render/config checks, explicitly opted-in read-only live
  verifier, current32 operator migration template and coordinated readiness/rollback runbook.

## Executed local checks

| Check | Result / boundary |
| --- | --- |
| `pnpm install --frozen-lockfile` (pnpm 9.15.9) | PASS, lockfile unchanged |
| `pnpm release:test` | PASS **7/7**, no skipped/disabled tests: policy/identity/redaction, encrypted tickets/scope/method/session/tamper/expiry, chunked body bound, missing inventory credentials, private topology, worker drain order, backend credentials/private URLs |
| `pnpm --filter @qeynox/persistence test:release-safety` | PASS **6/6**, pure P15 guard tests; no DB connection/migration |
| `pnpm qa:worker-lifecycle` | PASS **5/5**, lifecycle contract tests; no real SDK/server shutdown claimed |
| `pnpm typecheck` | PASS **5 application tasks** + dedicated release-tool TypeScript check |
| `QEYNOX_RELEASE_SHA=<base SHA> QEYNOX_RELEASE_VERSION=p16-local-validation pnpm build` | PASS **4 production source build tasks**, local build identity only, not a deployable reviewed release attestation |
| YAML parse (installed `yaml` 2.9.1) | PASS for release/foundation Compose and storage/Hermes/Hatchet manifests; not Docker/Coolify schema/runtime proof |
| `pnpm release:inspect` without credentials | Expected **BLOCKED / exit 3**, names the four missing Coolify configuration keys; no network fallback |
| `pnpm release:verify` without deployment environment | Expected **BLOCKED / exit 1**, dynamically discovered **32 migrations**, sanitized required-key codes; no DB/network access |
| `git diff --check` | PASS |

During implementation, the release-tool typecheck caught optional release metadata access and was
fixed before the final passing run. An initial direct migration-test command used the wrong file
location and found no tests; the actual `test:release-safety` script above was then run successfully.
No QA assertion/validation was weakened or disabled to obtain these results.

## BLOCKED / not performed

- **Current live Coolify inventory:** connector reports unsupported; no configured Coolify credentials.
  Recorded historical UUIDs are not verified current state. No Control creation/reconciliation done.
- **Docker build/image smoke/health entrypoint:** Docker executable unavailable. Source build/typecheck
  and YAML parse do not prove image startup, proxy routing, signal delivery or volume preservation.
- **Real private dependencies:** no authenticated live PostgreSQL/Redis/S3/Hatchet/Hermes access;
  no `release:verify --live`, real object upload/download, task registration, native-tool confinement,
  firewall/egress, provider/invitation delivery or forced-shutdown recovery certification.
- **Current32 populated migration rehearsal:** P15 external rehearsal remains unexecuted. No live
  migration preflight/apply, backup, restore, SQL/ledger edit, schema push or DB connection occurred.
- **Full backend/provider QA campaign:** not run; disposable QA DB/provider prerequisites absent.
- **Production transport/security:** historical Hatchet is preproduction private insecure gRPC;
  production TLS configuration and legacy MinIO security review remain separate gates.
- **No deployment, resource restart, live config mutation, migration, rollback or merge.**

## Preservation and release restrictions

Changes are source/config only. No stateful resource creation/deletion, financial-history change,
Stripe activation, secret disclosure or `iasser` operation. SQL migration bytes and pnpm lockfile
remain unchanged. A future operator must verify resource/network/volume identities and retain backups,
old four-app image digests and matching config before any separately authorized rollout. Remove stale
live public routers in place only with explicit deployment authorization; repository edits alone do
not secure already running infrastructure. A clean local build is **not** a production-ready verdict.
