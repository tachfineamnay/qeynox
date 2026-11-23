# P24 — QeyNox Coolify Release Readiness Report

**Date:** 2026-11-22 (UTC) · **Branch:** `arena/f8892abe-qeynox` · **No deployment, no migration, no service/volume change was performed.**

## FINAL VERDICT: BLOCKED

The repository-side release engineering for the candidate is complete and internally consistent, but
deployment readiness **cannot be certified from this session**: required infrastructure access is
absent (Coolify credentials, Docker/registry access, live database, live network topology), the
rollback images cannot be verified or created without that access, and the populated-DB restore
rehearsal for the 32-migration upgrade remains unexecuted. Per mission rules, missing access ⇒
**BLOCKED** — not READY_TO_DEPLOY.

What *is* READY offline is listed as PASS below; what blocks deployment is listed as BLOCKED with
the exact unblocking action.

---

## 1. Verified source SHA

| Field | Value |
| --- | --- |
| Candidate SHA | `3ed17878505c7216bd5201f8314a80818b054ad2` (merge of PR #56) |
| Expected SHA match | ✅ `git rev-parse HEAD` = expected; working tree clean |
| Branch | `arena/f8892abe-qeynox` |
| Release version used for offline render | `0.1.0-beta.1` (immutable, operator may choose another valid tag) |
| Build identity contract | Same 40-char SHA + version stamped into all four images (`stamp.mjs` fails the build without both; OCI labels `org.opencontainers.image.revision/version`) |

## 2. Checks executed at this exact SHA (this session)

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | **PASS** (exit 0) | — |
| `pnpm typecheck` (incl. `typecheck:release`) | **PASS** (exit 0) | — |
| `pnpm build` (4 Turbo tasks) | **PASS** (exit 0) | — |
| `pnpm release:test` | **PASS** 7/7 (worker shutdown drain, fail-closed secrets/private endpoints, …) | — |
| `pnpm --filter @qeynox/persistence test:release-safety` | **PASS** (0 fail) | `.cache/p24/release-safety.log` |
| `pnpm release:render 3ed1787… 0.1.0-beta.1` | **PASS** — 4-app same-SHA manifest rendered | `.cache/p24/rendered-manifest.json` |
| `pnpm release:inspect` | **BLOCKED (designed, exit 3)** — missing 4 Coolify creds (names §6) | JSON `{"status":"BLOCKED",…}` |
| `pnpm release:verify` (offline) | **BLOCKED at config gate** (no env in sandbox); `discoveredMigrations: 32` ✅ | — |
| `pnpm release:verify --live` | **BLOCKED at config gate** (probes never reached; read-only by design) | — |
| `pnpm release:check web` | **BLOCKED, fail-closed**, diagnostics = names/codes only, never values | — |
| `pnpm qa:task02` | **PASS** — 5,022 assertions | `.cache/p24/qa-task02.log` |
| `pnpm qa:backend` | **PASS** — 28 assertions | `.cache/p24/qa-backend.log` |
| `pnpm qa:agent-runtime` | **PASS** — 65 assertions | `.cache/p24/qa-agent-runtime.log` |
| `pnpm qa:worker-lifecycle` | **PASS** — 5/5 tests | `.cache/p24/qa-worker-lifecycle.log` |
| `pnpm qa:registration` | **PASS** — 149 assertions (invite-only flows) | `.cache/p24/qa-registration.log` |
| `pnpm qa:payment-freeze` | **PASS** — 369 assertions, **zero Stripe network calls** | `.cache/p24/qa-payment-freeze.log` |
| `pnpm qa:connectors` | **BLOCKED (environment)** — requires live `api.worldbank.org`; sandbox egress blocked (`curl: SSL_ERROR_SYSCALL`, github=200). Not a source regression. | `.cache/p24/qa-connectors.log` |
| `pnpm qa:raas` | **BLOCKED (environment)** — same live World Bank egress requirement | `.cache/p24/qa-raas.log` |

QA runs used a disposable local PostgreSQL 16.2 (`.cache/pg-data`, `127.0.0.1:5433`, trust auth,
superuser `qeynox_qa_admin`); each suite created and dropped its own `qeynox_qa_*` database.
**No production database was touched; no migration was run.**

## 3. Coolify inventory — BLOCKED (access absent)

`pnpm release:inspect` (single scoped GET, GET-only, redacting) returned exit 3 / BLOCKED because
these are **absent from this session** (names only):

1. `QEYNOX_COOLIFY_BASE_URL`
2. `QEYNOX_COOLIFY_API_TOKEN`
3. `QEYNOX_COOLIFY_PROJECT_UUID`
4. `QEYNOX_COOLIFY_ENVIRONMENT`

Also absent: Docker socket / Docker CLI, container registry access, and any Coolify connector —
so running containers, image tags/digests, networks, volumes and native DBs **cannot be inspected
from here at all**. No inventory claims are made below the line.

**Historical references only (NOT current inventory, never proof):** `infra/coolify/release.json`
records project `gm3bynlnlsrkikanyzvxfew7`, environment `preproduction` (`girv53ul8pmfikflpxf9j2re`),
server `l7k1ng0ir694dr1ftyipqnby`, and application UUIDs web `gu5pde4uim045cfyhbzvatyn`,
api `d8owo32umum050d4w7k2wvzp`, worker `urabqgudjsqnycnicygon1vv`; **control has `null` UUID**
(never create blindly — discover first). Do not inspect or alter `iasser`.

**Operator capture list (before any change):** current project/environment/server/destination;
all application + stateful-resource UUIDs; current images/digests/OCI labels per app incl. Worker;
health status; aliases/networks; Traefik routes/labels; runtime/build key **names**; volume
bindings/backup refs; migration ledger + pending jobs. Store snapshots in restricted infra storage.

## 4. Four-app image and rollback matrix

### 4a. Candidate (offline-rendered, all four identical identity)

| App | Resource | Image tag contract | SHA/version | Health | Stop |
| --- | --- | --- | --- | --- | --- |
| Web | `qeynox-web` :3000, public | `$QEYNOX_IMAGE_PREFIX/web:<sha>` | `3ed1787…` / `0.1.0-beta.1` | `docker-release-json` `/health` | SIGTERM, 300 s |
| API | `qeynox-api` :4000, **no public router** | `…/api:<sha>` | same | `docker-release-json` `/health` | SIGTERM, 300 s |
| Worker | `qeynox-worker`, **no HTTP port** | `…/worker:<sha>` | same | `docker-heartbeat` (Dockerfile HEALTHCHECK) | SIGTERM, 300 s |
| Control | `qeynox-control` :3001, `/admin` priority 300 | `…/control:<sha>` | same | `docker-release-json` `/admin/health` | SIGTERM, 300 s |

All four Dockerfiles: pinned base `node:22-bookworm-slim@sha256:e9f565d3…`, `STOPSIGNAL SIGTERM`,
`USER node`, `HEALTHCHECK` 30 s/5 s timeout/120 s start-period/3 retries → `infra/release/health.mjs`,
entrypoint `exec` direct Node (no pnpm/tsx child chain), runtime policy `NODE_ENV=production`,
`QEYNOX_COMMERCE_MODE=BETA_FREE`, `QEYNOX_REGISTRATION_MODE=INVITE_ONLY` enforced.

### 4b. Running / rollback images — BLOCKED

| Requirement | Status | Why / unblock |
| --- | --- | --- |
| Identify deployed revisions (4 apps) | **BLOCKED** | Needs Coolify creds (§3) or Docker/registry access |
| Preserve running images before change | **BLOCKED** | Cannot read current digests/tags/labels |
| Verify previous four immutable rollback digests retained | **BLOCKED** | Never assume an old image is recoverable — must be read from registry/Coolify |
| Create missing verified rollback images | **BLOCKED** | Needs Docker/registry + the exact previous reviewed SHA; recipe below |
| Confirm old-code ↔ DB-ledger compatibility for rollback | **BLOCKED** | Needs live ledger read (`pnpm db:release --mode preflight` against target) |

Rollback-image recipe (future operator, does not deploy): build the previous reviewed SHA with the
same four build args, verify OCI labels + `.qeynox-release.json` stamp, push to the private registry,
record the digest; roll back **all four as one unit**; never pair old images with new SHA/version
env; if the old Web requires the former public S3 proxy, keep maintenance mode instead of
reopening public S3 (incompatibility is documented in `infra/COOLIFY_RELEASE.md`).

## 5. Worker health / heartbeat / SIGTERM / dependency contracts — source-verified

| Mechanism | Source evidence | Boundary |
| --- | --- | --- |
| Heartbeat | `apps/worker/src/health.ts`: atomic write of `/tmp/qeynox-worker-health.json` every **10 s**, removed on teardown; stale after **60 s** | Explicitly **process/event-loop liveness only** — not Hatchet/Hermes/mission readiness |
| Container healthcheck | `infra/Dockerfile.worker` → `health.mjs worker`: heartbeat mtime ≤ 60 s **and** sha/version == image stamp | Image/environment equality, not task correctness |
| SIGTERM handling | `packages/orchestration/src/worker-lifecycle.ts` `runManagedWorker`: SIGTERM/SIGINT → background drain → SDK stop → await running → handler removal; DB closes only after drains | Durable execution remains Hatchet's responsibility |
| Stop grace | `release.json` + `compose.release.yml`: `stop_grace_period_seconds: 300`, `init: true`, `stop_signal: SIGTERM` | 300 s does not guarantee arbitrary task completion |
| Startup contract | `entrypoint.sh` → `check.mjs`: image stamp, fail-closed `diagnostics()`, service-catalog parse, bounded TCP reachability (12×2 s), Postgres `SELECT 1`, Redis `PING`, API health SHA/version match for web/control/worker; exits `runtimeVerified: false` | Never migrates, never retries forever |
| Release tests | `release:test` #6 “worker shutdown drains background before SDK and removes signal handlers”, #7 “all backend required secrets and private endpoints fail closed” | **PASS (7/7)** |

**Still a manual gate (not claimed):** live SIGTERM while a task/email lease is in flight in an
isolated environment, incl. forced-timeout recovery, and actual SDK registration/task lifecycle.

## 6. Configuration verification (no secrets exposed)

- Validation contract `infra/release/contract.mjs` verified fail-closed for all four roles:
  required keys, exact policies, private-endpoint shapes (API `http://qeynox-api:4000`,
  Hermes `http://qeynox-hermes:8642/v1/`, Hatchet `qeynox-hatchet:8888` + host port `qeynox-hatchet:7077`,
  Postgres/Redis native aliases with password, S3 `qeynox-storage:9000`), `resend` invitation transport,
  `AES256` SSE, Stripe-secret rejection, Vertex-credential Hermes-only rule, forbidden runtime
  override flags, egress attestation default **false** (`PROVIDER_EGRESS_NOT_ATTESTED` until
  `QEYNOX_NETWORK_POLICY_ATTESTED=true` + host allowlist — **left false, not attested here**).
- Role env examples cover **100 %** of required keys (script-checked: missing = none for web/api/worker/control).
- Repo contains only `.env.example` files — no real env files, no secrets read or printed.

### Missing credentials / config by NAME (presence unverifiable in this session)

**A. Coolify access (4):** `QEYNOX_COOLIFY_BASE_URL`, `QEYNOX_COOLIFY_API_TOKEN`,
`QEYNOX_COOLIFY_PROJECT_UUID`, `QEYNOX_COOLIFY_ENVIRONMENT`.

**B. Runtime secrets (per role, from the contract):**
- all roles: `NODE_ENV`, `QEYNOX_DEPLOYMENT_ENV`, `QEYNOX_RELEASE_SHA`, `QEYNOX_RELEASE_VERSION`
  (non-secret), plus `QEYNOX_PUBLIC_URL`
- web: `QEYNOX_API_URL`, `QEYNOX_API_PRIVATE_ORIGIN`, `QEYNOX_STORAGE_RELAY_KEY` (32-byte base64),
  `QEYNOX_ARTIFACT_ENDPOINT`, `QEYNOX_ARTIFACT_BUCKET`
- control: `QEYNOX_PLATFORM_API_URL`, `QEYNOX_PLATFORM_API_PRIVATE_ORIGIN`
- api/worker: `DATABASE_URL`, `QEYNOX_REDIS_URL`, `HATCHET_CLIENT_TOKEN`, `HATCHET_CLIENT_API_URL`,
  `HATCHET_CLIENT_HOST_PORT`, `HATCHET_CLIENT_TLS_STRATEGY`, `HERMES_API_BASE_URL`,
  `HERMES_PRIVATE_ORIGIN`, `HERMES_API_KEY`, `HERMES_MODEL`, `QEYNOX_ARTIFACT_ENDPOINT/BUCKET/REGION/
  ACCESS_KEY/SECRET_KEY`, `QEYNOX_SERVICE_CATALOG_PATH`, `QEYNOX_EMAIL_PROVIDER`,
  `QEYNOX_RESEND_API_KEY`, `QEYNOX_EMAIL_FROM`; api additionally `QEYNOX_OPERATOR_USER_IDS`
- conditional (names only, if enabled): `QEYNOX_BRAVE_SEARCH_API_KEY` + `QEYNOX_EGRESS_ALLOWED_HOSTS`
  (+ attestation), `QEYNOX_CHATWOOT_BASE_URL/API_TOKEN/ACCOUNT_ID/INBOX_ID/LIVE_VERIFIED`,
  Google Workspace OAuth trio + `QEYNOX_CONNECTION_CREDENTIAL_KEY`, embeddings
  `QEYNOX_EMBEDDINGS_ENDPOINT/API_KEY/MODEL/ALLOWED_HOSTS`, operator Vertex config
  `QEYNOX_HERMES_VERTEX_PROJECT/REGION/MODEL` + `QEYNOX_VERTEX_CREDENTIAL_FILE`
- migration job (separate operator runner): `DATABASE_URL` with direct DB access

**C. Compose-workflow interpolation (if used):** `QEYNOX_PRIVATE_NETWORK`, `QEYNOX_EDGE_NETWORK`,
`QEYNOX_PUBLIC_HOST`, `QEYNOX_IMAGE_PREFIX`, `QEYNOX_WEB/API/WORKER/CONTROL_ENV_FILE`.

### Invariants (all PASS)

| Invariant | Enforcement evidence |
| --- | --- |
| `QEYNOX_COMMERCE_MODE=BETA_FREE` | `REQUIRED_POLICY` in contract; pinned in render + compose + all 4 env examples + control app JSON; `release:test` rejects `PAID` |
| `QEYNOX_REGISTRATION_MODE=INVITE_ONLY` | same chain; `qa:registration` 149 PASS (invite redemption) |
| No Stripe transaction | `FORBIDDEN_CREDENTIAL` on Stripe keys; `qa:payment-freeze` **369 PASS — zero Stripe network calls** (outbound intercepted, positive control proved detection) |

## 7. The 32-migration upgrade — prepared, rehearsal BLOCKED

| Item | Status |
| --- | --- |
| 32 migration files `0001…0032` present; dynamic discovery reports **32** | **PASS** |
| `pnpm db:release` safety model (read-only preflight/dry-run; apply requires `--plan-sha256` + backup ref + SHA-256 + `--confirm-backup-restored` + `--confirm-writes-stopped` + `QEYNOX_ALLOW_DATABASE_UPGRADE=true`; target identity must match URL and observed DB; plan-drift refusal; advisory lock) | **PASS (source + `test:release-safety`)** |
| Live preflight/dry-run against the real target | **BLOCKED** — no DB credentials/access |
| Backup (`pg_dump` + SHA-256) and **restore rehearsal** on isolated copy | **BLOCKED** — needs production DB + isolated restore endpoint; rehearsal has **never been executed** (P15 noted, unchanged here); `qa-migration-rehearsal.ts` additionally needs disposable Docker |
| Populated-ledger upgrade rehearsal | **BLOCKED** — same reason |

## 8. Exact steps for an authorized release (nothing below was executed)

**Phase 0 — access & inventory.** Operator supplies the 4 Coolify names (§6A) through secret
storage (never chat/Git/terminal). Run `pnpm release:inspect` (exit 0 required). Capture the §3
record. Native DBs may need separate read-only UI inspection; absence ≠ permission to recreate.
Do not inspect or alter `iasser`.

**Phase 1 — rollback preservation (before any change).** Record current immutable digests + exact
build/runtime identity/policy of all four apps. Confirm the previous four rollback images actually
exist in the registry (never assume); build/verify any missing one from its exact previous reviewed
SHA (§4b recipe). Read the migration ledger (`db:release --mode preflight`) and assess old-code
compatibility for rollback. Record affected user/mission/financial counts.

**Phase 2 — candidate build.** Clean checkout of `3ed17878505c7216bd5201f8314a80818b054ad2`;
choose immutable `QEYNOX_RELEASE_VERSION` (e.g. `0.1.0-beta.1`); build all four with identical
`--build-arg QEYNOX_RELEASE_SHA` / `--build-arg QEYNOX_RELEASE_VERSION`; verify labels + stamped
`.qeynox-release.json`; disable push-triggered auto-deploy; do not mix prebuilt-image and
git-build workflows; do not deploy `latest` or an unreviewed branch.

**Phase 3 — configuration.** Fill role env files from `infra/release/*.env.example` (names §6B),
stored outside Git (Coolify secret storage preferred). Validate per role:
`node --env-file=/secure/role.env infra/release/config-check.mjs <role>` (or `pnpm release:check <role>`
with an exported environment). Keep native-tool isolation / egress attestations **false** unless
actually certified. No Stripe keys, no migration/bootstrap/QA-override flags, no partial optional
key groups. Preproduction Hatchet uses `HATCHET_CLIENT_TLS_STRATEGY=none`; production refuses it
(separate TLS review remains a production gate).

**Phase 4 — migration (separate operator job, exact commands).** Maintenance window; drain/stop all
writers (API, workers, pollers, webhooks); then from the candidate checkout:

```sh
pnpm db:release --mode preflight --target-host "$RELEASE_HOST" --target-port "$RELEASE_PORT" \
  --target-database "$RELEASE_DB" --target-user "$RELEASE_USER"
pnpm db:release --mode dry-run   # same explicit target flags
# backup: pg_dump --format=custom → sha256sum → pg_restore --list (NOT a restore test)
# restore rehearsal into a NEW empty isolated DB, verify schema_migrations + financial counts,
# record BACKUP_REFERENCE + BACKUP_SHA256 + restore evidence  ← STILL UNEXECUTED, do first
pnpm db:release --mode preflight  # re-inspect; take REVIEWED_PLAN_SHA256 from this report
QEYNOX_ALLOW_DATABASE_UPGRADE=true pnpm db:release --mode apply \
  --target-host "$RELEASE_HOST" --target-port "$RELEASE_PORT" \
  --target-database "$RELEASE_DB" --target-user "$RELEASE_USER" \
  --plan-sha256 "$REVIEWED_PLAN_SHA256" \
  --backup-reference "$BACKUP_REFERENCE" --backup-sha256 "$BACKUP_SHA256" \
  --confirm-backup-restored --confirm-writes-stopped
# re-preflight: zero pending/mismatches/unknown; reopen only after approval
```

Never run migrations from any app entrypoint/health check/restart hook/deploy webhook.

**Phase 5 — rollout order.** Keep ingress closed during mixed-release transition. Start **API
first**, then **Worker → Web → Control** (same SHA/version everywhere). Reconcile dependency
settings in place only — never recreate Postgres/Redis/S3/Hatchet/Hermes, never overwrite volumes,
never `compose down -v`. Validate: image labels, `/health` release JSON on web/api/control, worker
heartbeat freshness + image equality, authenticated dependency probes.

**Phase 6 — verification.** `pnpm release:verify --live` (read-only) must return
`AUTOMATED_CHECKS_PASSED_MANUAL_GATES_REMAIN` — never “production ready”. Manual gates:
① current Coolify scope/resources + running immutable image labels (incl. Worker);
② authenticated Redis PING, private S3 ops, volume/KMS/backup retention;
③ worker live shutdown/leases/recovery + isolated populated-DB migration rehearsal;
④ actual Hermes native-tool confinement + egress firewall;
⑤ backup/rollback authorization + preserved financial history.

**Phase 7 — reopen traffic.** Validate `/admin` isolation and priority 300, invites/login/logout,
private file transfers (web `/storage-transfer` relay; no public S3/Hermes proxy), runtime probes,
retained financial history. Do not enable Stripe during any validation.

**Rollback/abort triggers:** missing credentials, mixed SHA/version, stale heartbeat, ledger drift,
pending migrations, failed runtime/isolation checks, unhealthy dependencies, failed restore evidence
→ BLOCKED; investigate sanitized codes, do not restart-loop. Roll back all four apps as one reviewed
unit; DB rollback = assessed compatibility or separately authorized DBA plan — never down-migrate,
never restore over live financial history.

## 9. PASS / FAIL / BLOCKED summary matrix

| # | Gate | Status |
| --- | --- | --- |
| 1 | Source SHA = expected `3ed1787…`, clean tree | **PASS** |
| 2 | Frozen install / typecheck / build | **PASS** |
| 3 | `release:test` (7) + persistence `test:release-safety` | **PASS** |
| 4 | Same-SHA 4-app manifest render + policy pinning | **PASS** |
| 5 | Worker heartbeat/SIGTERM/300 s grace/entrypoint contracts (source + unit tests) | **PASS** (live rehearsal = manual gate) |
| 6 | Fail-closed per-role config contract; examples complete | **PASS** |
| 7 | 32 migrations discovered; `db:release` guards | **PASS** |
| 8 | Invariants: BETA_FREE / INVITE_ONLY / no Stripe | **PASS** (`qa:payment-freeze` 369, `qa:registration` 149) |
| 9 | AGENTS suites: task02 / backend / agent-runtime | **PASS** (5,022 + 28 + 65) |
| 10 | AGENTS suites: worker-lifecycle | **PASS** (5/5) |
| 11 | Coolify live inventory (4 creds) | **BLOCKED** — access absent |
| 12 | Running image digests/tags (4 apps) | **BLOCKED** — no Coolify/Docker/registry |
| 13 | Previous-four rollback images verified/preserved | **BLOCKED** — cannot verify; never assume |
| 14 | control resource UUID discovery (avoid duplicate creation) | **BLOCKED** — recorded `null` |
| 15 | Live runtime secret presence (all roles) + Hermes/Vertex/Hatchet/PG/Redis/S3/Resend/Brave/Chatwoot live config | **BLOCKED** — no env/access; names §6 |
| 16 | Live private-topology certification (no host ports/public routers; egress) | **BLOCKED** — needs infra inspection; attestations left **false** |
| 17 | Live `db:release` preflight/dry-run vs real target | **BLOCKED** — no DB access |
| 18 | Backup + **restore rehearsal** + populated-DB upgrade rehearsal | **BLOCKED** — never executed; needs DB + Docker |
| 19 | `qa:connectors`, `qa:raas` (live World Bank call) | **BLOCKED (environment)** — egress to `api.worldbank.org` unavailable in sandbox; not a source defect |
| 20 | `qa:storage` / `qa:hermes-live` (not run) | **BLOCKED (expected)** — need live S3 / Hermes credentials |
| 21 | Any FAIL found in source requiring correction | **NONE** — no source changes → no commit/PR |

**Verdict: BLOCKED** for deployment. Unblocking = operator supplies §6A credentials + registry/
Docker access for §4b, executes Phase 4 rehearsal, and clears the five manual gates of Phase 6.
No deployment, migration, restart, service/database recreation or volume change was performed.
