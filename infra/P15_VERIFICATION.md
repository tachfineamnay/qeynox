# P15 — Incremental database release: implementation and local verification

Date: 2026-11-22. Branch: `arena/45270500-qeynox`.
Base: `e572e02302b8bf72af28624332a46d1f73f8df5f`; `git fetch origin main` confirmed that
`HEAD` and `origin/main` matched before work. `AGENTS.md` read.

## Delivered

- One operator entrypoint: `pnpm db:release --mode preflight|dry-run|apply` (default preflight).
- Existing engine extended, not replaced: full dynamic discovery, read-only inspection, complete
  ledger comparison before mutation, same advisory lock, per-file SQL + ledger transactions.
- Exact requested connection identity checked before connecting; observed DB/user/server included
  in the plan. Missing/empty ledger on populated public tables, history gaps, unknown applied files
  and checksum drift block apply. No automatic baselining or checksum override.
- Apply requires explicit environment authorization, reviewed plan SHA-256, backup reference/digest,
  restore-test attestation and stopped-writer confirmation. It rechecks the plan under its execution
  lock. Resume is the same command with a newly inspected and explicitly approved plan.
- No historical SQL file modified. No seed/reset/business-record DML introduced by the release code.
  Migration SQL remains trusted reviewed code, not an automatically certified data-preservation policy.
- Old preproduction CLI delegates to the same guards. Old fixed-range Python generator refuses to
  generate SQL. Rehearsal discovers the full current release instead of assuming 17 migrations and
  now includes protected identity/workspace/mission/financial records and operator apply/resume.
- [DATABASE_RELEASE.md](DATABASE_RELEASE.md) documents backup/restore, explicit execution,
  partial-file recovery, lost-COMMIT-response handling and authorized restore/cutover.

## Commands actually executed for P15

| Check | Actual result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS; pnpm 9.15.9; lockfile unchanged |
| `pnpm --filter @qeynox/persistence test:release-safety` | PASS: 6 tests, 0 failures, 0 skipped |
| `pnpm typecheck` | PASS: 5 tasks successful (includes new persistence CLI/scripts typecheck) |
| `pnpm build` | PASS: 4 tasks successful |
| Root `pnpm db:release --mode preflight` with explicit local identity but no `DATABASE_URL` | Expected exit 1, `DATABASE_URL required`; no DB connection attempted |
| Retired Python generator | Expected exit 1, zero stdout bytes / no SQL emitted |
| Diff of `packages/persistence/migrations/` and `pnpm-lock.yaml` against origin/main | Empty; all 32 historical files unchanged |
| Startup-source/Dockerfile migration-invocation check | No matches in API/worker sources or API/worker Dockerfiles |
| `git diff --check` | PASS |

Final terminal summaries:

```text
# test:release-safety
1..6
# tests 6
# pass 6
# fail 0
# skipped 0

# pnpm typecheck
Tasks: 5 successful, 5 total
Cached: 2 cached, 5 total

# pnpm build
Tasks: 4 successful, 4 total
Cached: 2 cached, 4 total

# retired generator
Retired generator exit=1, stdout bytes=0
```

The six local tests cover independent apply guards/authorization, target routing and credential-safe
CLI refusal, applied/pending/drift/unknown/gap comparison, refusal to baseline populated schemas,
observed-identity/reviewed-plan guards, and dynamic file discovery/immutability/ambiguity checks.
They use pure report values and local files, **not a DB/S3 mock or an integration certification**.
Implementation-time TypeScript errors in parser narrowing and an assertion overload were corrected
before the final successful typecheck/build; no type suppressions or disabled assertions were used.

## Files changed (16)

Code and checks:
- `packages/persistence/src/migrate.ts`
- `packages/persistence/src/migration-release.ts`
- `packages/persistence/scripts/database-release.ts`
- `packages/persistence/scripts/database-release.test.ts`
- `packages/persistence/scripts/migrate-preproduction.ts`
- `packages/persistence/package.json`
- `packages/persistence/tsconfig.json`
- `package.json`
- `apps/api/scripts/qa-migration-rehearsal.ts`
- `infra/scripts/generate-upgrade-0012-0017.py`

Documentation:
- `README.md`
- `infra/DATABASE_RELEASE.md`
- `infra/MIGRATIONS_0012_0017_PREPRODUCTION.md`
- `infra/PREPRODUCTION.md`
- `infra/CONTROL_RELEASE.md`
- `infra/P15_VERIFICATION.md`

## Deliberately not executed / remaining gates

Per mission scope: **no full QA campaign, no PostgreSQL migration, no live database connection,
no deployment, and no actual backup or restore**. The Docker-backed migration rehearsal was updated
and typechecked, but not run. This is code/local safety verification, not permission to upgrade live.

Before a live release an operator/DBA must:
1. Rehearse the exact candidate on an isolated restored populated database, including protected user,
   workspace, mission and payment data; verify read-only inspection, apply, failure/partial resume and
   backup/restore against the actual PostgreSQL version and permissions.
2. Review pending SQL, data-dependent constraints, lock duration, disk headroom and application/schema
   compatibility. The supported canonical schema is `public`; custom schemas need separate review.
3. Verify the target inventory, tested backup/archive integrity, matching S3/key retention, writer freeze,
   provider-event backlog handling and recovery/cutover permissions.
4. Authorize the real run separately. Backup confirmation is an operator attestation; the CLI does not
   authenticate an external archive or automatically stop writers.

Historical architecture/audit results remain historical; P15 does not upgrade their certification status.
