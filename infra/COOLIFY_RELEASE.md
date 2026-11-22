# P16 — immutable Coolify release integration

**Source/configuration implementation, not deployment certification.** Supersedes historical
`COOLIFY.md`, `PREPRODUCTION.md`, `CONTROL_RELEASE.md` and the bootstrap Compose instructions
where they differ on release identity, routing, beta policy or startup. No resource was created,
recreated, deployed, restarted or migrated for P16. Stripe must remain absent/disabled.

## Access and inventory gate (currently BLOCKED)

The current session has no supported Coolify connector or configured Coolify credentials. Historical
UUIDs in `coolify/release.json` are references, **not proof of current inventory**. `control` has no
verified resource UUID. Do not create it blindly. Production is not certified by preproduction config.

An authorized operator supplies these through secret storage (never chat, Git or terminal output):
`QEYNOX_COOLIFY_BASE_URL` (HTTPS origin), `QEYNOX_COOLIFY_API_TOKEN` (read-only scope where supported),
`QEYNOX_COOLIFY_PROJECT_UUID`, `QEYNOX_COOLIFY_ENVIRONMENT` (verified environment name or UUID).
Run `pnpm release:inspect`. It uses **one scoped GET**, refuses redirects/unrecognized scope/schema,
redacts environment values and returns exit 3 / BLOCKED on missing access. It does not call global
inventory, write, deploy or restart endpoints. On versions omitting native DBs in this response,
inspect those resources separately in the read-only UI; absence is not permission to recreate them.

Before changing any settings, record current project/environment/server/destination, application and
stateful-resource UUIDs, current images/digests/labels, health, aliases/networks, routes, runtime/build
key **names**, volume bindings/backup references, migration ledger and pending jobs. Keep snapshots
and secret values in restricted infrastructure storage, not the PR. Scope must match the intended
preproduction environment. Do not inspect or alter `iasser`.

## Files and commands

| File/command | Purpose |
| --- | --- |
| `coolify/release.json` | All four app settings + recorded dependency identities/ports/retention requirements; desired schema, not a Coolify POST payload |
| `compose.release.yml` | Equivalent app-only immutable-image topology, explicit private/edge networks, no volumes/host ports; do not run alongside native apps |
| `release/{web,api,worker,control}.env.example` | Role contracts, safe private origins, intentionally blank credentials |
| `release/contract.mjs` | Shared fail-closed configuration validation; diagnostic codes never echo values |
| `pnpm release:render <sha> <version>` | Offline desired settings with exact SHA and build/runtime values; no mutation |
| `pnpm release:check <role>` | Offline validation of supplied process environment, not a dotenv reader |
| `pnpm release:verify` | All-role configuration + dynamic migration-file discovery, **no network** |
| `pnpm release:verify --live` | Explicit read-only DB history + HTTP release metadata + bounded existing Hermes/Hatchet probes; never runs SQL migrations |
| `pnpm release:test` | Local release/relay/lifecycle safety tests |
| `release/migrations.env.example` + `DATABASE_RELEASE.md` | Separate operator-only current32 migration procedure |

Compose interpolation requires the verified existing `QEYNOX_PRIVATE_NETWORK`,
`QEYNOX_EDGE_NETWORK`, `QEYNOX_PUBLIC_HOST`, `QEYNOX_IMAGE_PREFIX`, four `QEYNOX_*_ENV_FILE` paths,
`QEYNOX_DEPLOYMENT_ENV`, SHA/version. No network/volume is provisioned by this topology. The existing
private network may be named `coolify`; **verify**, do not infer it from historical notes. An external
Docker network is not a firewall: certify no host port publishing, no public load-balancer domains,
no stale Traefik routers, and bounded runtime egress independently. Web needs private API and S3;
Control only needs private API; neither needs database/provider credentials.

## Immutable release selection and builds

1. Select the reviewed **main** merge commit as a full 40-character SHA and an immutable version.
   During review a branch commit can be tested, but do not deploy an unreviewed branch or `latest`.
2. Give **every** Docker build the same `QEYNOX_RELEASE_SHA` and `QEYNOX_RELEASE_VERSION` build args.
   Each Dockerfile stamps `.qeynox-release.json`, embeds OCI labels, and includes SHA/version in
   Turbo build hashing/Next deployment identity. Build from that actual checkout; labels alone do
   not cryptographically prove source provenance. Example for each of web/api/worker/control:

   ```sh
   # FUTURE operator build example only; does not deploy.
   docker build -f "infra/Dockerfile.$ROLE" \
     --build-arg QEYNOX_RELEASE_SHA="$RELEASE_SHA" \
     --build-arg QEYNOX_RELEASE_VERSION="$RELEASE_VERSION" \
     -t "$QEYNOX_IMAGE_PREFIX/$ROLE:$RELEASE_SHA" .
   ```

3. Native Coolify applications: reconcile existing resource settings **in place** using the rendered
   contract; pin `git_commit_sha` and Dockerfile/build args. Turn off push-triggered auto-deploy for
   a coordinated release. Do not send the local manifest as an undocumented API payload. A prebuilt
   image workflow instead pins all four immutable image digests/tags; do not mix workflows.
4. Runtime SHA/version must match the image stamp exactly. Entrypoints reject skew, wrong beta
   policy, missing credentials, public dependency URLs, Stripe secrets and migration/bootstrap/QA
   bypass flags. Docker health checks compare live metadata/heartbeat to the stamp.
5. Mandatory runtime policy for **all four** apps:
   `NODE_ENV=production`, `QEYNOX_COMMERCE_MODE=BETA_FREE`,
   `QEYNOX_REGISTRATION_MODE=INVITE_ONLY`. No payment-enabling environment keys or Stripe credentials.
   API operator allowlist must identify reviewed existing admins, never bootstrap/change users here.

Use absolute `/workspace/infra/operator/...` catalogue paths in production (provided in templates);
apps execute in their own working directories. Entrypoint checks JSON file presence/parseability, not
semantic publication or offer configuration in the database.

Builds need no runtime secrets. Runtime env files must be stored outside Git with restricted
permissions; Coolify secret storage is preferred. `release:check` accepts an already supplied process
environment; Node 22 supports `node --env-file=/secure/role.env infra/release/config-check.mjs web`.
Never `cat` a real env file into a release report. Optional provider flags are off by default; enabling
one requires its credential and reviewed egress configuration. Native-tool/egress attestations default
**false** and must not be set true merely to clear a runtime blocker. The Resend provider, real key and
reviewed sender are required for invite-only email workflows. Do not set optional key groups partially.

## Private topology and startup health

| Resource | DNS/port and exposure | Required operator checks |
| --- | --- | --- |
| Web | public host -> 3000, private alias `qeynox-web`; `/health` | matching release JSON; authenticated relay; no S3/API secret in client bundle |
| Control | same host, **exact `/admin` OR `/admin/` prefix** -> 3001; private alias `qeynox-control` | preserve `/admin` (Next basePath); priority 300 over Web 10; no StripPrefix; `/admin/health` |
| API | `qeynox-api:4000`, **no public router/host port** | `/health` release JSON; authenticated role/workspace checks remain canonical |
| Worker | no HTTP/ingress port; outbound private API/Hatchet/Hermes/S3/DB | Docker heartbeat/image equality, actual SDK registration/task lifecycle independently |
| PostgreSQL | native recorded alias or `qeynox-postgres:5432`, private | scoped app DB role, auth/query + current32 ledger; backups/financial data retained |
| Redis | native recorded alias or `qeynox-redis:6379`, private | password, explicit `/0`, authenticated PING; keep AOF, noeviction and existing volume |
| S3 | `qeynox-storage:9000`, private | existing bucket/versions, least-privilege app credential, KMS/key retention, SSE and actual PUT/HEAD/GET |
| Hatchet | `qeynox-hatchet:8888` HTTP API, `:7077` gRPC, private; native separate DB | existing tenant/token/key volume; API probe + authenticated SDK registration; do not reset tenant |
| Hermes | `qeynox-hermes:8642/v1/`, private | API credential/model/provider config, native-tool isolation + egress; keep existing home/config |

`entrypoint.sh` runs configuration and bounded TCP dependency checks **before** `exec node` in the
correct app working directory. Web/Control/Worker also require the API health SHA/version to match.
Backend startup additionally authenticates PostgreSQL with read-only `SELECT 1` and Redis with bounded
`PING`. No schema or object-write check is implied; S3/provider permission/isolation checks remain
release gates. It never retries forever or migrates.
`/health` is deliberately liveness + release identity, **not** a universal readiness assertion. Existing
Hermes/Hatchet fail-closed runtime probes still determine whether execution can proceed.

Preproduction recorded Hatchet uses private insecure gRPC: explicitly set
`HATCHET_CLIENT_TLS_STRATEGY=none` (the SDK defaults to TLS). Production refuses `none`; a separately
reviewed private Hatchet gRPC TLS configuration/certificate mount is a **remaining production gate**.
The historical Hatchet manifest is preproduction-only, not an implicit TLS migration. The contract
requires private aliases; do not point it at public DNS to bypass reachability checks. Database URL
query overrides are rejected by the app release contract. If certified PostgreSQL TLS needs query
parameters, review/extend the app contract explicitly rather than weakening transport validation.

### Worker shutdown

Use Coolify init/tini, `SIGTERM` and a **300-second stop grace period**. Entrypoint uses direct Node
(`--import tsx`) instead of pnpm -> tsx child chains. Existing `runManagedWorker` owns signal handling,
background drains, Hatchet stop, run completion and handler removal; runtime teardown closes DB only
after drains. P16 adds an atomic 10-second event-loop heartbeat (stale after 60 seconds), removed on
teardown. It is explicitly not proof of Hatchet registration/dependency health. Verify actual SIGTERM
while a task/email lease is in flight in an isolated environment, including forced-timeout recovery,
before approving a live release. Never assume a 300-second timeout guarantees arbitrary task completion.

## Private S3 transfer cutover

The prior public `qeynox.io/<bucket>/` proxy must not remain. `services/storage.yml` now declares
`traefik.enable=false` and no public bucket routers. Hermes likewise has **no public API/dashboard
router**. Hatchet stays private. In Coolify also remove stale generated domains/router labels in place;
changing this repository alone cannot remove old running proxy configuration. Preserve all resource
UUIDs, volume names/bindings, buckets and keys. Do not `compose down -v`, recreate storage or reset KMS.

Both upload and download grants now stay behind the authenticated Web `/storage-transfer` relay:
- API still performs canonical session/workspace/document authorization and signs the exact object.
- Web encrypts the signed URL into a 120-second AES-GCM ticket, bound to session hash, workspace and
  GET/PUT method; private endpoint, bucket and workspace prefix are checked before/after encryption.
- The relay checks the live API session, accepts same-origin PUT only, refuses redirects, forwards
  neither browser credentials nor arbitrary headers to S3, and never rewrites the signed Host/path.
- Transfers are bounded at **10 MiB** before full buffering, with 30-second upstream timeout, no-store,
  attachment/nosniff/sandbox download headers; no open proxy, bucket listing or admin operations.
- Web needs only endpoint/bucket plus a unique **32-byte base64** `QEYNOX_STORAGE_RELAY_KEY`, never S3
  access keys. Rotation invalidates existing tickets. Suppress ticket query strings in edge access logs.
- Covers document vault PUT/GET and result artifact export/renew grants. It does not create anonymous
  public object access; read-only shared result pages retain their existing authorization semantics.

After a separately authorized deployment, validate upload -> complete -> download, result export/renew,
revoked session, cross-workspace/method, tampered/expired ticket and >10 MiB rejection in isolated QA.
Check direct public S3/Hermes/DB/Redis/Hatchet URLs are unreachable. Relay unit tests are not real S3
integration proof. Downloads over 10 MiB currently fail closed; larger streaming transfers need an
explicitly reviewed follow-up, not an unbounded public-storage exception.

## Current32 migration release and rollout order

**Never run migrations from an application entrypoint, health check, restart hook or deploy webhook.**
P15 `pnpm db:release` dynamically discovers ordered SQL (currently 32); SQL/ledger/checksums are unchanged
by P16. Follow [DATABASE_RELEASE.md](DATABASE_RELEASE.md) from the exact immutable candidate. The
`migrations.env.example` file belongs to a separate operator job with existing private DB access, not
API/Worker runtime. Supply explicit verified target host/port/database/user flags for preflight and
dry-run; the template intentionally does not guess them or grant apply authorization.

A future authorized rollout sequence:
1. Verify inventory, candidate, independent certification evidence, retained previous images/config,
   restorable DB backup, object versions/KMS, and affected financial/user/mission counts.
2. Rehearse populated upgrade on an isolated restored DB. P15's rehearsal remains **unexecuted** here.
3. Use a maintenance window, drain/stop all writers, back up/restore-test, inspect again and separately
   authorize the exact P15 apply with reviewed target/plan hash/backup attestations. No apply in P16.
4. Inspect dynamic ledger: zero unknown/mismatched/non-prefix/pending files for the candidate. Current32
   means discovered history, not a hardcoded `17` or an instruction to rewrite existing ledger rows.
5. Start matching API, then Worker/Web/Control; reconcile dependency configurations in place only when
   separately needed/authorized. Keep ingress closed during mixed-release transitions. Validate image
   labels and all health release metadata, worker heartbeat and actual runtime/lease checks.
6. Explicit `release:verify --live` performs bounded read-only checks; success says
   `AUTOMATED_CHECKS_PASSED_MANUAL_GATES_REMAIN`, never production-ready. Its union environment is
   operator-only; do not give every role every secret merely to run verification.
7. Verify `/admin` isolation/priority, invites/login/logout, private file transfers, runtime probes and
   retained financial history before reopening traffic. Do not enable Stripe during any validation.

## Rollback / abort

Missing credentials, mixed SHA/version, stale heartbeat, history drift, pending migrations, failed
runtime/isolation checks, unhealthy dependencies or failed restore evidence => **BLOCKED**. Do not
restart-loop through configuration mistakes; investigate sanitized codes and secured service logs.

Retain the previous four immutable app digests **and** exact matching build/runtime identity/policy
settings before changes. Roll back all affected apps as one reviewed unit; do not pair old images with
new SHA/version env or relax startup guards. Preserve beta modes and private routing. If the old Web
requires public S3, do not reopen that endpoint to make rollback work: keep maintenance mode and obtain
a compatible private-relay rollback/fix. Do not restore the former public Hermes dashboard.

Database rollback is **not** an automatic down migration. After an additive upgrade, assess old-code
compatibility against the actual ledger/data. If incompatible, keep writers/ingress stopped and invoke
the separately authorized DBA recovery/forward-fix plan. Never restore over live financial history,
truncate queues, reset migrations, delete volumes or replay emails/payments as a release convenience.
Backup restore requires explicit authorization and reconciliation with S3/provider state. No rollback,
deployment or production-readiness certification was performed in this task.
