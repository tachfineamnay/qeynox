/** Opt-in disposable Docker rehearsal, never a deployment or application startup command. */
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { loadMigrations, runMigrations, defaultMigrationsDirectory } from '../../../packages/persistence/src/migrate';
import { executeDatabaseRelease } from '../../../packages/persistence/src/migration-release';

const url = process.env.QEYNOX_QA_DATABASE_URL;
const container = process.env.QEYNOX_QA_CONTAINER;
if (!url || !container || !/^qeynox-closeout-[a-f0-9]{8}$/.test(container) || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname !== '/qeynox_qa') throw new Error('Disposable QA target required');
const published = execFileSync('docker', ['port', container, '5432'], { encoding: 'utf8' }).trim();
if (published !== '127.0.0.1:' + new URL(url).port) throw new Error('QA URL must point to the named disposable container');
const dir = await mkdtemp(join(tmpdir(), 'qeynox-migrations-'));
const pool = new pg.Pool({ connectionString: url });
try {
  const existing = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(existing.rows[0].n, 0, 'QA database must be empty');
  const all = await loadMigrations();
  // Default baseline includes existing payment rows; the release endpoint is always discovered.
  // Operators may also rehearse an older supported prefix (e.g. 11) explicitly.
  const paymentBaseline = all.findIndex(m => m.name.endsWith('_payments.sql')) + 1;
  const baseline = Number(process.env.QEYNOX_QA_BASELINE_COUNT ?? paymentBaseline);
  assert(Number.isSafeInteger(baseline) && baseline >= 6 && baseline < all.length, 'Select a populated historical prefix with at least commerce/identity and a pending tail');
  const prefix = all.slice(0, baseline);
  for (const m of prefix) await copyFile(join(defaultMigrationsDirectory, m.name), join(dir, m.name));
  const first = await runMigrations(url, { directory: dir });
  assert.equal(first.applied.length, prefix.length);
  await pool.query("INSERT INTO identity_users(id,email) VALUES ('qa-seed','migration-qa@example.invalid')");
  await pool.query("INSERT INTO identity_workspaces(id,name,created_by) VALUES ('qa-workspace','Retained workspace','qa-seed')");
  await pool.query("INSERT INTO identity_memberships(id,user_id,workspace_id,role,status) VALUES ('qa-member','qa-seed','qa-workspace','OWNER','ACTIVE')");
  await pool.query("INSERT INTO operations(id,workspace_id,created_by,goal_id,status,version,last_activity_at,payload) VALUES ('qa-mission','qa-workspace','qa-seed','qa-goal','DRAFT',1,'2026-11-22T00:00:00Z','{\"qa\":\"preserve mission payload\"}')");
  await pool.query("INSERT INTO raas_orders(id,workspace_id,operation_id,revision_id,quote_id,state,amount_minor,currency,updated_at,created_at) VALUES ('qa-order','qa-workspace','qa-mission','qa-revision','qa-quote','PAYMENT_REQUIRED',100,'EUR','2026-11-22','2026-11-22')");
  await pool.query("INSERT INTO raas_payment_events(id,order_id,provider_event_id,kind,received_at,redacted_payload) VALUES ('qa-event','qa-order','qa:preserve-event','QA_RECORDED','2026-11-22','{\"qa\":\"retained financial history\"}')");
  const hasPayments = baseline >= paymentBaseline && paymentBaseline > 0;
  if (hasPayments) await pool.query("INSERT INTO raas_payments(id,workspace_id,operation_id,order_id,status,amount_minor,currency,idempotency_key,created_at,updated_at) VALUES ('qa-payment','qa-workspace','qa-mission','qa-order','CREATED',100,'EUR','qa-payment-key','2026-11-22','2026-11-22')");
  const protectedQueries = [
    "SELECT id,email,locale FROM identity_users WHERE id='qa-seed'",
    "SELECT id,name,created_by FROM identity_workspaces WHERE id='qa-workspace'",
    "SELECT id,user_id,workspace_id,role,status FROM identity_memberships WHERE id='qa-member'",
    "SELECT id,workspace_id,created_by,goal_id,status,version,payload FROM operations WHERE id='qa-mission'",
    "SELECT * FROM raas_orders WHERE id='qa-order'",
    "SELECT id,order_id,provider_event_id,kind,received_at,redacted_payload FROM raas_payment_events WHERE id='qa-event'",
    ...(hasPayments ? ["SELECT * FROM raas_payments WHERE id='qa-payment'"] : []),
  ];
  const snapshot = async (db: pg.Pool) => Promise.all(protectedQueries.map(async sql => (await db.query(sql)).rows));
  const before = await snapshot(pool);
  const rowsBefore = await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  assert.deepEqual(rowsBefore.rows, prefix.map(({ name, checksum }) => ({ name, checksum })));
  const docker = (...args: string[]) => execFileSync('docker', ['exec', container, ...args], { stdio: 'pipe' });
  docker('pg_dump','-U','postgres','-Fc','-f','/tmp/qeynox-rehearsal.dump','qeynox_qa');
  const backupSha = docker('sha256sum','/tmp/qeynox-rehearsal.dump').toString().split(' ')[0]!;
  docker('createdb','-U','postgres','qeynox_restore');
  docker('pg_restore','-U','postgres','-d','qeynox_restore','--exit-on-error','/tmp/qeynox-rehearsal.dump');
  const restored = new URL(url); restored.pathname = '/qeynox_restore';
  const restorePool = new pg.Pool({ connectionString: restored.toString() });
  try {
    assert.deepEqual((await restorePool.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows, rowsBefore.rows);
    assert.deepEqual(await snapshot(restorePool), before, 'restored identity/mission/financial records match');
  } finally { await restorePool.end(); }
  const target = new URL(url);
  const args = ['--target-host', target.hostname, '--target-port', target.port || '5432', '--target-database', 'qeynox_qa', '--target-user', decodeURIComponent(target.username)];
  const env = { DATABASE_URL: url, QEYNOX_ALLOW_DATABASE_UPGRADE: 'true' };
  let planSha256 = '';
  const review = (value: unknown) => {
    if (value && typeof value === 'object' && 'planSha256' in value && typeof value.planSha256 === 'string') planSha256 = value.planSha256;
  };
  await executeDatabaseRelease([...args, '--mode', 'dry-run'], env, review);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, baseline, 'dry-run does not mutate the ledger');
  const apply = () => executeDatabaseRelease([...args, '--mode', 'apply', '--plan-sha256', planSha256, '--backup-reference', 'qa-docker-custom-dump', '--backup-sha256', backupSha, '--confirm-backup-restored', '--confirm-writes-stopped'], env, () => {});
  await apply();
  assert.deepEqual((await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows, all.map(({ name, checksum }) => ({ name, checksum })));
  assert.deepEqual(await snapshot(pool), before, 'upgrade preserves identity/mission/financial records');
  // Resume is an operator action: obtain a fresh plan; all committed files must now be skipped.
  await executeDatabaseRelease([...args, '--mode', 'preflight'], env, review);
  await apply();
  assert.deepEqual(await snapshot(pool), before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, all.length);
  console.log(`Migration rehearsal PASS: ${baseline} baseline -> ${all.length} discovered migrations, dump/restore, protected records, operator dry-run/apply/resume`);
} finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
