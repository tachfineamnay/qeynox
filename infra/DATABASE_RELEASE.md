# P15 — Operator-controlled incremental database release

Use **`pnpm db:release`**, from the exact reviewed release checkout/image. It reuses
`packages/persistence/src/migrate.ts`; there is no second SQL generator or runner.
All ordered `NNNN_name.sql` files are discovered dynamically (32 at the time P15 was written).
Historical migration bytes and ledger rows must never be edited to make an upgrade pass.
This procedure supports both a truly empty schema and a populated schema with a valid prefix ledger.

**Never add this command to API/worker startup, Docker CMD, health checks, restart hooks or an
unattended deployment job.** An operator authorizes each execution. This document is not permission
to touch a live database. No live migration, backup or restore was performed for P15.

## Safety model

- Preflight and dry-run use a repeatable-read **READ ONLY** transaction; they do not create the
  ledger, execute migration SQL, seed configuration or change business rows. Dry-run is an inspection
  of the plan, **not a claim that pending SQL/locks/permissions/backfills were exercised**.
- Reports include requested host/port/database/user, observed database/user/server address/port,
  every applied/pending filename and checksum, checksum mismatches, unknown history, non-prefix
  history, and a `planSha256`. The output never includes `DATABASE_URL` or its password.
- A schema containing business tables without a nonempty ledger is blocked: no inferred baseline,
  no stamping existing tables as migrated. Missing files, checksum drift and holes also block apply.
- Apply requires explicit target parameters matching the URL, matching observed DB/user, the reviewed
  plan digest, an independent authorization environment variable, a backup reference + SHA-256,
  restore-test confirmation, and confirmation that writers are stopped.
- Apply reloads the manifest and ledger **under the same advisory lock and DB session** used to execute
  the pending files. If the target/schema/ledger/manifest changed since inspection, approval is stale.
- The shared engine validates the entire ledger **before any CREATE or pending SQL**. Each file and
  its ledger insert commit together in a separate transaction. Completed files survive a later failure;
  the failing file rolls back. No automatic retry, down-migration, reset, seeding or data deletion.
- Operator commands fail fast if another migration session holds the advisory lock; DDL lock wait is
  bounded at 5 seconds, each apply statement at 10 minutes (inspection: 30 seconds). Cancellation or
  lost connectivity requires inspection before retry. These timeouts are not a proof of low downtime.
- The checked-out SQL is trusted reviewed release code, **not a sandbox**. A future destructive SQL
  migration requires separate review and data-migration planning. A ledger does not prove schema
  parity or business-data correctness. The existing 32 SQL files are unchanged by P15.

## 1. Prepare the release and exact target

1. Obtain operator approval, a maintenance window, and the immutable candidate commit/image.
   Keep the previous application image and the full candidate migration directory available.
2. Confirm the endpoint using infrastructure inventory, **not a guessed database name**. Use a direct
   PostgreSQL connection/session pool, not transaction-pooling PgBouncer (session advisory locks).
3. Supply `DATABASE_URL` securely from the runner's secret store. Do not put passwords in shell
   history, PRs, logs or reports. The CLI refuses URL query parameters that could override routing or
   identity; only `sslmode`, `sslrootcert`, `sslcert`, `sslkey` are accepted. Configure certificate
   verification for remote targets. Never disable TLS verification to pass this procedure.
4. Independently confirm `SELECT current_database(), current_user, inet_server_addr(), inet_server_port();`
   with the intended credentials. DNS/proxy changes can change the observed server and invalidate a plan.

In the examples below, `$RELEASE_HOST`, `$RELEASE_PORT`, `$RELEASE_DB`, `$RELEASE_USER` are explicit
inventory values, **not defaults**; export them through the operator shell. `DATABASE_URL` must refer
to those exact values, including its username. Nonmatching values fail before a socket is opened.
The observed physical server endpoint also forms part of the reviewed plan digest.

```sh
pnpm db:release --mode preflight \
  --target-host "$RELEASE_HOST" --target-port "$RELEASE_PORT" \
  --target-database "$RELEASE_DB" --target-user "$RELEASE_USER"

pnpm db:release --mode dry-run \
  --target-host "$RELEASE_HOST" --target-port "$RELEASE_PORT" \
  --target-database "$RELEASE_DB" --target-user "$RELEASE_USER"
```

Default mode is `preflight`. Both inspect only. Save their JSON output in the access-controlled release
record. Inspect applied/pending lists and **all** mismatches/blockers; do not extract a digest and
blindly approve it. A blocked preflight exits nonzero, while retaining its diagnostic report.

## 2. Stop writers; take and verify the backup

Stop API, workers, pollers, webhook consumers and other writers; drain in-flight work and account for
provider webhooks queued during maintenance. An advisory migration lock does not stop application
writes. `--confirm-writes-stopped` is an operator attestation, not an automatic maintenance switch.

Use PostgreSQL client tools compatible with the server version. Configure libpq `PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, TLS, and a protected `PGPASSFILE` for the **same independently verified target**.
Do not assume libpq variables and `DATABASE_URL` select the same database: check both identities.
Do not print credentials. Store encrypted archives outside the repository with restricted access.

```sh
umask 077
# BACKUP_FILE names a new private archive on approved backup storage.
pg_dump --format=custom --file "$BACKUP_FILE"
sha256sum "$BACKUP_FILE"   # record as BACKUP_SHA256; do not fake/guess it
pg_restore --list "$BACKUP_FILE" > "$BACKUP_TOC_FILE"
```

`pg_restore --list` is **not** a restore test. With a separately verified isolated restore endpoint
and a **new empty database**, restore the archive (no in-place `--clean`, no overwriting live data):

```sh
# First independently verify libpq host/port point to the isolated restore environment.
createdb "$RESTORE_DATABASE"
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  --dbname "$RESTORE_DATABASE" "$BACKUP_FILE"
```

A logical archive does not contain cluster roles: separately preserve roles/grants, deployment
configuration and restore permissions according to the DBA policy. The owner/privilege flags above
are for the isolated validation copy; recovery must restore/reconcile required ownership and grants.
Database backups do not back up S3 objects, provider state or encryption keys: retain the matching
object-store versions and keys under the approved retention policy.

On the restored copy verify the full `schema_migrations` names/checksums, representative user and
workspace IDs, mission payloads/history, orders, payments, refunds and payment-event records. Compare
counts and appropriate financial totals with the source at the stopped-writer snapshot. Record the
backup object reference, SHA-256, source identity, snapshot time and successful restore-test evidence.
Never run payment processing, workers or outgoing notifications against a restored QA copy.

The CLI only records/validates the syntax of the reference/digest and explicit attestations. It cannot
verify that an external archive exists, belongs to this target, was restored or that all writers stopped.
These remain operator responsibilities; false confirmation defeats the safeguards.

## 3. Inspect again and explicitly apply

After the backup and while writes remain stopped, run preflight again. Review its exact target,
manifest, complete ledger and pending files; set `REVIEWED_PLAN_SHA256` from that report. Set
`BACKUP_REFERENCE` to a non-secret release/backup identifier and `BACKUP_SHA256` to the verified archive
digest. Do not pass a signed secret backup URL as a reference; the reference appears in the report.

```sh
QEYNOX_ALLOW_DATABASE_UPGRADE=true pnpm db:release --mode apply \
  --target-host "$RELEASE_HOST" --target-port "$RELEASE_PORT" \
  --target-database "$RELEASE_DB" --target-user "$RELEASE_USER" \
  --plan-sha256 "$REVIEWED_PLAN_SHA256" \
  --backup-reference "$BACKUP_REFERENCE" --backup-sha256 "$BACKUP_SHA256" \
  --confirm-backup-restored --confirm-writes-stopped
```

This is the same explicit command for initializing an empty target, upgrading a populated one or
resuming; it never assumes that a target named `qeynox` is safe. Do not leave the authorization variable
permanently enabled in application configuration. No `--force`, checksum override, automatic baseline
or skip-failed-file flag exists.

Compatibility: `packages/persistence/scripts/migrate-preproduction.ts` delegates to the same command
and additionally requires `QEYNOX_DEPLOYMENT_ENV=preproduction`. Its former empty-only variables no
longer authorize writes. The older `migrate` command remains for explicitly isolated QA use; do not
use it for an operator release. The fixed-range Python generator is retired and exits without SQL.

## 4. Verify before reopening writes

1. Save progress events and final report. Run preflight again: zero pending, mismatches, unknown files
   and ordering blockers; names/checksums must match the complete discovered release.
2. Compare protected rows/counts/financial totals against the pre-upgrade record. Newly added tables
   and columns are expected; lost users, workspaces, missions or payment history are **not** acceptable.
3. Perform release-specific schema/data checks and a controlled read-only application smoke. This CLI
   does not automatically run QA, activate connectors, initialize operator configuration or deliver missions.
4. Only after approval, start compatible application components, reopen writes, reconcile queued
   provider events idempotently and monitor failures. Do not run old code against a new schema without
   a reviewed compatibility decision.

## 5. Failure, resume and recovery

- **Before first apply:** identity mismatch, absent confirmation, stale plan, checksum drift, unknown
  applied file, missing ledger or lock refusal -> no migration SQL executed. Investigate, do not override.
- **During a file:** that file's SQL and ledger insert roll back together; earlier files remain committed.
  Keep writers stopped. Preserve logs, inspect the ledger and fix an environmental problem, not historical
  migration bytes. If SQL itself is defective, stop for a reviewed release/recovery decision.
- **Connection lost/process killed/COMMIT response lost:** the last console event is not authoritative.
  Reconnect and inspect; PostgreSQL decides whether that file and its ledger row committed. Do not
  replay raw SQL or manually insert/delete ledger rows.
- **Operator-controlled resume:** re-run preflight, review the new applied/pending lists, verify backup
  suitability and stopped writers, and approve its **new** plan digest. Reissue the apply command.
  Already committed files are skipped after checksum validation. An old digest deliberately refuses
  to resume a changed ledger. A fully applied release is a no-op only with a fresh matching approval.
- **Recovery/rollback:** restore the verified pre-release archive into a new isolated database first;
  verify rows/checksums/financial invariants, restore grants/configuration, then perform an independently
  authorized connection cutover with the compatible previous image. Retain the failed DB read-only for
  diagnosis. Never DROP tables/columns, edit migration files or reset a ledger as a rollback method.
  If writes were reopened, a pre-release restore loses later data: require a DBA-led PITR/reconciliation
  plan including payments/webhooks/object-store changes, not a blind old-dump restore.

## Local validation and rehearsal boundaries

Essential local checks:

```sh
pnpm --filter @qeynox/persistence test:release-safety
pnpm typecheck
pnpm build
```

`apps/api/scripts/qa-migration-rehearsal.ts` now discovers the current release, uses the same operator
preflight/dry-run/apply path, seeds identity/workspace/mission/financial records, verifies custom-format
dump/restore, compares retained data and tests an explicitly reapproved no-op resume. It requires the
existing strictly named disposable Docker target and an empty `qeynox_qa` database; its default baseline
includes the historical payments migration. `QEYNOX_QA_BASELINE_COUNT` can select an older supported
prefix. The backup restore database is `qeynox_restore` in that disposable container; destroy the whole
QA container after evidence capture. **This rehearsal was updated but not executed for P15.**

No full QA campaign, live database access, actual release, deployment or backup/restore certification
is claimed by the local guards/typecheck/build. A DBA/operator must rehearse the exact candidate on a
suitably isolated restored populated database and review it before any live upgrade.
