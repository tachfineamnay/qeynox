# Additive migrations 0012–0017 on an already-populated QeyNox database

This operator procedure upgrades an existing 0001–0011 database. It generates SQL from the exact committed Git blobs, verifies the entire existing ledger and applies 0012–0017 in one transaction under the migration advisory lock. It does not reset or delete existing data. A successful isolated PostgreSQL rehearsal is required before use.

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

## Procedure (single transaction)

From the clean repository at the intended release commit, after the required backup and restore test:

```sh
python3 infra/scripts/generate-upgrade-0012-0017.py > /tmp/qeynox-upgrade-0012-0017.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/qeynox-upgrade-0012-0017.sql
```

The generator reads committed Git blobs, checks that exactly 0001–0017 exist and computes their SHA-256 values locally. The SQL verifies `current_database() = 'qeynox'` and that the ledger contains exactly the expected 0001–0011 names and checksums before applying any file. It rejects a mismatch or repeat invocation and rolls back the transaction on failure. The generated SQL contains no credentials. Do not change the target database to make the guard pass.

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

- Running the empty-database migrator against this populated database.
- Rerunning 0001–0011, editing their files or resetting `schema_migrations`.
- Applying migrations without a backup or while writes are active.
- Executing anything automatically from the application container at startup.
