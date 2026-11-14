# Additive migrations 0012–0017 on an already-populated QeyNox database

**Never executed by this mission.** This is the operator procedure for the preproduction database
(already populated by the 0001–0011 foundation). Do **not** run the QA/empty-database migrator or
`runMigrations` against a populated database: this procedure applies each additive file explicitly.

## Scope

| Migration | Content | Additive only |
|---|---|---|
| 0012 | platform administration tables + audit | create tables/indexes |
| 0013 | identity user-management indexes | create indexes |
| 0014 | workspace membership lifecycle columns/indexes | add nullable columns + indexes |
| 0015 | invitation acceptance token columns/index | add nullable columns + unique partial index |
| 0016* | Soul onboarding progress table | create table/index |
| 0017* | Chatwoot support mapping table | create table/indexes |

\* 0016/0017 are also additive and are required by the Mission 05/06 candidate features. The mandatory
**Control** path only needs 0012+; apply 0016/0017 with the same procedure before enabling Soul/Support.
No file drops, renames or rewrites an existing column; migrations 0001–0011 are untouched.

## Preconditions

- Explicit operator authorization, maintenance announcement and a verified PostgreSQL backup
  (`pg_dump --format=custom`, plus restore test) taken immediately before the operation.
- `DATABASE_URL` points to the intended preproduction database; confirm with
  `SELECT current_database(), current_user, version();`.
- Current migration ledger is the expected 0001–0011 set:
  `SELECT name, checksum FROM schema_migrations ORDER BY name;`
- Freeze application writes during the operation (stop qeynox-api/qeynox-worker or enable maintenance).
- Files are copied from the candidate commit, not edited locally; LF line endings preserved.

## Procedure (one transaction per file)

```sh
# 0. Backup (required)
pg_dump --format=custom --file=qeynox-pre-0012-$(date +%Y%m%d%H%M).dump "$DATABASE_URL"

# 1. Acquisition: one migration at a time, fail closed on error
for f in 0012_platform_administration.sql 0013_identity_user_management_indexes.sql \
         0014_workspace_membership_lifecycle.sql 0015_invitation_acceptance_tokens.sql \
         0016_soul_onboarding.sql 0017_support_chatwoot_links.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 <<SQL
    SELECT pg_advisory_xact_lock(hashtext('qeynox.schema_migrations'));
    \i packages/persistence/migrations/$f
    INSERT INTO schema_migrations (name, checksum)
    VALUES ('$f', encode(digest(pg_read_file('packages/persistence/migrations/$f'), 'sha256'), 'hex'));
SQL
done
```

Notes: `pg_read_file` requires a server-side path; when psql runs locally, compute the checksum with
`sha256sum packages/persistence/migrations/<file>` and bind it as a psql variable instead. The
checksum must match the runner's SHA-256 (LF file bytes) or a later runner invocation will fail closed.

## Verification

```sql
SELECT name FROM schema_migrations ORDER BY name;  -- 0001..0017 exactly once
SELECT count(*) FROM information_schema.tables WHERE table_name IN
 ('platform_admin_assignments','platform_admin_sessions','platform_admin_audit',
  'soul_onboarding','support_chatwoot_links');
SELECT column_name FROM information_schema.columns
 WHERE table_name='identity_memberships'
   AND column_name IN ('invited_by','invited_at','joined_at','updated_at','invitation_token_hash','invitation_expires_at');
-- Index checks (0013/0014/0015/0017)
SELECT indexname FROM pg_indexes WHERE tablename IN
 ('platform_admin_audit','identity_users','identity_memberships','support_chatwoot_links');
-- Existing business rows untouched
SELECT count(*) FROM identity_users; SELECT count(*) FROM identity_workspaces; SELECT count(*) FROM identity_memberships;
```

Smoke: start API/worker, call `/health`, then platform `/v1/platform/auth/login` and read-only
GETs for users/organisations/operations. No data backfill is needed: new columns are nullable and
new tables start empty.

## Rollback

Migrations are forward-only. On a blocking failure, stop, restore the pre-migration custom dump into
a clean database (`pg_restore`) and redeploy the previous application commit. Never DROP columns,
tables or the migration ledger row manually. Cosmetic additive leftovers after partial success must
be handled with the same restore strategy, not by ad-hoc edits.

## Prohibited

- Running the QA migrator / empty-database `runMigrations` against this populated database.
- Rerunning 0001–0011, editing their files or resetting `schema_migrations`.
- Applying migrations without a backup or while writes are active.
- Executing anything automatically from the application container at startup.
