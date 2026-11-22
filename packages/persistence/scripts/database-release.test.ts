/** Essential P15 local safety checks: pure plans/guards/files and CLI refusal; no DB/S3 doubles. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareMigrationHistory, migrationBlockers, defaultMigrationsDirectory, loadMigrations, type MigrationInspection } from '../src/migrate';
import { assertReleaseConnection, assertReleaseInspection, executeDatabaseRelease, parseReleaseOptions } from '../src/migration-release';

const targetArgs = ['--target-host', '127.0.0.1', '--target-port', '55432', '--target-database', 'qeynox_qa', '--target-user', 'qa_operator'];
const planSha = 'a'.repeat(64);
const approvals = ['--mode', 'apply', '--plan-sha256', planSha, '--backup-reference', 'qa-backup-ticket', '--backup-sha256', 'b'.repeat(64), '--confirm-backup-restored', '--confirm-writes-stopped'];

test('release flags default to inspection and require every independent apply guard', async () => {
  assert.equal(parseReleaseOptions(targetArgs).mode, 'preflight');
  assert.equal(parseReleaseOptions([...targetArgs, '--mode', 'dry-run']).mode, 'dry-run');
  const valid = [...targetArgs, ...approvals];
  assert.equal(parseReleaseOptions(valid).mode, 'apply');
  for (const key of ['--target-host', '--target-port', '--target-database', '--target-user', '--plan-sha256', '--backup-reference', '--backup-sha256', '--confirm-backup-restored', '--confirm-writes-stopped']) {
    const args = [...valid], index = args.indexOf(key);
    args.splice(index, key.startsWith('--confirm-') ? 1 : 2);
    assert.throws(() => parseReleaseOptions(args), Error, key);
  }
  for (const extra of [['--mode', 'aply'], ['--target-port', '5432'], ['--yes'], ['--mode'], ['--mode', 'apply']]) {
    assert.throws(() => parseReleaseOptions([...targetArgs, ...extra]));
  }
  // Authorization must fail before any socket is opened (the address is not a real DB).
  await assert.rejects(executeDatabaseRelease(valid, { DATABASE_URL: 'postgresql://qa_operator@127.0.0.1:55432/qeynox_qa' }, () => {}), /QEYNOX_ALLOW_DATABASE_UPGRADE/);
});

test('explicit connection identity refuses routing overrides and never exposes credentials', () => {
  const options = parseReleaseOptions(targetArgs);
  const valid = 'postgresql://qa_operator:never-log-this@127.0.0.1:55432/qeynox_qa';
  assert.equal(assertReleaseConnection(valid, options), valid);
  for (const raw of [undefined, 'not-a-url', valid.replace('55432', '5432'), valid.replace('qeynox_qa', 'other'), valid.replace('qa_operator:', 'other:'), valid + '?host=other', valid + '?options=-crole=other', valid + '#fragment']) {
    assert.throws(() => assertReleaseConnection(raw, options));
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./database-release.ts', import.meta.url)), ...targetArgs], {
    env: { ...process.env, DATABASE_URL: valid.replace('qeynox_qa', 'wrong') }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity does not match/);
  assert.equal((result.stdout + result.stderr).includes('never-log-this'), false);
});

test('history reports all pending/applied/checksum drift and refuses gaps or unknown releases', () => {
  const release = [1, 2, 3].map(n => ({ name: `000${n}_local.sql`, checksum: String(n).repeat(64) }));
  const prefix = compareMigrationHistory(release, release.slice(0, 1));
  assert.equal(prefix.applied.length, 1);
  assert.deepEqual(prefix.pending, release.slice(1));
  assert.deepEqual(prefix.mismatches, []);
  assert.deepEqual(prefix.outOfOrder, []);
  assert.deepEqual(compareMigrationHistory(release, release).pending, []);
  assert.equal(compareMigrationHistory(release, [{ ...release[2]!, checksum: 'edited' }]).mismatches.length, 1);
  assert.deepEqual(compareMigrationHistory(release, [release[2]!]).outOfOrder, [release[2]!.name]);
  assert.deepEqual(compareMigrationHistory(release, [{ name: '9999_future.sql', checksum: planSha }]).unknownApplied, ['9999_future.sql']);
});

test('a populated schema is never automatically baselined and every history anomaly blocks apply', () => {
  const release = [{ name: '0001_first.sql', checksum: planSha }];
  const empty = compareMigrationHistory(release, []);
  assert.deepEqual(migrationBlockers(empty, false, []), []);
  assert.deepEqual(migrationBlockers(empty, true, ['schema_migrations']), []);
  assert.match(migrationBlockers(empty, false, ['identity_users']).join(';'), /baselining is forbidden/);
  assert.match(migrationBlockers(empty, true, ['schema_migrations', 'operations']).join(';'), /baselining is forbidden/);
  assert.match(migrationBlockers(compareMigrationHistory(release, [{ ...release[0]!, checksum: 'changed' }]), true, []).join(';'), /content changed/);
  assert.match(migrationBlockers(compareMigrationHistory(release, [{ name: '9999_future.sql', checksum: planSha }]), true, []).join(';'), /absent from this release/);
});

test('apply approval is bound to observed DB user/server and reviewed plan, not just a URL', () => {
  const options = parseReleaseOptions([...targetArgs, ...approvals]);
  // A pure report value, not a simulated database or evidence of live SQL behavior.
  const report: MigrationInspection = {
    directory: '/qa-only', total: 0, applied: [], pending: [], mismatches: [], unknownApplied: [], outOfOrder: [],
    ledgerExists: false, publicTables: [], blockers: [], planSha256: planSha,
    target: { database: 'qeynox_qa', user: 'qa_operator', serverAddress: '127.0.0.1', serverPort: 5432 },
  };
  assert.doesNotThrow(() => assertReleaseInspection(report, options));
  assert.throws(() => assertReleaseInspection({ ...report, planSha256: 'c'.repeat(64) }, options), /plan changed/);
  assert.throws(() => assertReleaseInspection({ ...report, target: { ...report.target, user: 'other' } }, options), /identity/);
  assert.throws(() => assertReleaseInspection({ ...report, target: { ...report.target, serverAddress: null } }, options), /identity/);
});

test('discovery reads the complete directory, preserves source bytes and rejects ambiguous files', async () => {
  const actual = await loadMigrations();
  assert.deepEqual(actual.map(m => m.name), (await readdir(defaultMigrationsDirectory)).filter(n => n.endsWith('.sql')).sort());
  for (const migration of actual) assert.equal(migration.sql, await readFile(join(defaultMigrationsDirectory, migration.name), 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'qeynox-p15-safety-'));
  try {
    await writeFile(join(dir, '0001_first.sql'), 'SELECT 1;\n');
    assert.equal((await loadMigrations(dir)).length, 1);
    await writeFile(join(dir, '0002_next.sql'), 'SELECT 2;\n');
    assert.equal((await loadMigrations(dir)).length, 2, 'new migrations are discovered without changing code');
    await writeFile(join(dir, '0002_duplicate.sql'), 'SELECT 2;\n');
    await assert.rejects(loadMigrations(dir), /Duplicate/);
    await rm(join(dir, '0002_duplicate.sql'));
    await writeFile(join(dir, 'manual.sql'), 'SELECT 3;\n');
    await assert.rejects(loadMigrations(dir), /Unexpected SQL/);
    await rm(join(dir, 'manual.sql'));
    await writeFile(join(dir, '0002_next.sql'), 'BEGIN;\nSELECT 2;\nCOMMIT;\n');
    await assert.rejects(loadMigrations(dir), /transactions/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
