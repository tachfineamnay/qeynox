import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { loadMigrations, runMigrations, defaultMigrationsDirectory } from '../../../packages/persistence/src/migrate';
const url = process.env.QEYNOX_QA_DATABASE_URL;
const container = process.env.QEYNOX_QA_CONTAINER;
if (!url || !container || !/^qeynox-closeout-[a-f0-9]{8}$/.test(container) || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname !== '/qeynox_qa') throw new Error('Disposable QA target required');
const published = execFileSync('docker', ['port', container, '5432'], {encoding:'utf8'}).trim();
if (published !== '127.0.0.1:' + new URL(url).port) throw new Error('QA URL must point to the named disposable container');
const dir = await mkdtemp(join(tmpdir(), 'qeynox-migrations-'));
const pool = new pg.Pool({connectionString:url});
try {
  const existing = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(existing.rows[0].n, 0, 'QA database must be empty');
  const all = await loadMigrations();
  assert.equal(all.length, 17);
  for (const m of all.slice(0, 11)) await copyFile(join(defaultMigrationsDirectory, m.name), join(dir, m.name));
  const first = await runMigrations(url, {directory:dir}); assert.equal(first.applied.length, 11);
  await pool.query("INSERT INTO identity_users(id,email) VALUES ('qa-seed','migration-qa@example.invalid')");
  await pool.query("INSERT INTO identity_workspaces(id,name,created_by) VALUES ('qa-workspace','Retained workspace','qa-seed')");
  await pool.query("INSERT INTO identity_memberships(id,user_id,workspace_id,role,status) VALUES ('qa-member','qa-seed','qa-workspace','OWNER','ACTIVE')");
  const rows11 = await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  assert.deepEqual(rows11.rows, all.slice(0,11).map(({name,checksum}) => ({name,checksum})));
  const docker = (...args: string[]) => execFileSync('docker', ['exec', container, ...args], {stdio:'pipe'});
  docker('pg_dump','-U','postgres','-Fc','-f','/tmp/qeynox-rehearsal.dump','qeynox_qa');
  docker('createdb','-U','postgres','qeynox_restore');
  docker('pg_restore','-U','postgres','-d','qeynox_restore','--exit-on-error','/tmp/qeynox-rehearsal.dump');
  const restored = new URL(url); restored.pathname='/qeynox_restore';
  const restorePool = new pg.Pool({connectionString:restored.toString()});
  try {
    const rows = await restorePool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    assert.deepEqual(rows.rows, rows11.rows);
    assert.equal((await restorePool.query("SELECT count(*)::int AS n FROM identity_memberships WHERE id='qa-member'")).rows[0].n, 1);
  } finally { await restorePool.end(); }
  const upgraded = await runMigrations(url); assert.equal(upgraded.skipped.length, 11); assert.equal(upgraded.applied.length, 6);
  assert.deepEqual((await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows, all.map(({name,checksum}) => ({name,checksum})));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM identity_memberships WHERE id='qa-member'")).rows[0].n, 1);
  const rerun = await runMigrations(url); assert.equal(rerun.applied.length,0); assert.equal(rerun.skipped.length,17);
  console.log('Migration rehearsal PASS: seeded 0001–0011, dump/restore, exact checksums, 0012–0017 and rerun');
} finally { await pool.end(); await rm(dir,{recursive:true,force:true}); }
