import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { DomainError } from '@qeynox/domain';

/** Ordered, immutable SQL files. The engine owns each file's transaction. */
export interface Migration { readonly name: string; readonly sql: string; readonly checksum: string }
export interface MigrationReport {
  readonly directory: string;
  readonly total: number;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}
export interface MigrationLedgerEntry { readonly name: string; readonly checksum: string }
export interface MigrationHistory {
  readonly applied: readonly MigrationLedgerEntry[];
  readonly pending: readonly MigrationLedgerEntry[];
  readonly mismatches: readonly { name: string; expected: string; actual: string }[];
  readonly unknownApplied: readonly string[];
  readonly outOfOrder: readonly string[];
}
export interface MigrationInspection extends MigrationHistory {
  readonly directory: string;
  readonly total: number;
  readonly ledgerExists: boolean;
  readonly publicTables: readonly string[];
  readonly target: { readonly database: string; readonly user: string; readonly serverAddress: string | null; readonly serverPort: number | null };
  readonly blockers: readonly string[];
  /** Binds operator approval to the observed target, complete source manifest and ledger. */
  readonly planSha256: string;
}
export type MigrationProgress = (event: 'APPLYING' | 'APPLIED' | 'SKIPPED', name: string) => void;
export interface MigrationOptions {
  directory?: string;
  onProgress?: MigrationProgress;
  /** Runs under the SAME advisory lock/connection, before any DDL or migration is executed. */
  beforeApply?: (inspection: MigrationInspection) => void | Promise<void>;
  /** Operators fail fast rather than silently waiting behind another migration session. */
  tryLock?: boolean;
  statementTimeoutMs?: number;
}
const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const transactionControl = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im;
const lockName = 'qeynox.schema_migrations';
export const defaultMigrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
const checksum = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Loads the full release from disk, never from a hardcoded migration count. No DB access. */
export async function loadMigrations(directory: string = defaultMigrationsDirectory): Promise<readonly Migration[]> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch { throw new DomainError('NOT_CONFIGURED', 'Migration directory is unavailable'); }
  if (entries.some(name => name.endsWith('.sql') && !migrationFilePattern.test(name))) {
    throw new DomainError('INVALID_INPUT', 'Unexpected SQL filename in migration directory');
  }
  const names = entries.filter(name => migrationFilePattern.test(name)).sort();
  if (!names.length) throw new DomainError('NOT_CONFIGURED', 'No migration files found');
  if (new Set(names.map(name => name.slice(0, 4))).size !== names.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate migration sequence');
  }
  const migrations: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(join(directory, name), 'utf8');
    if (!sql.trim()) throw new DomainError('INVALID_INPUT', 'Migration is empty: ' + name);
    if (transactionControl.test(sql)) throw new DomainError('INVALID_INPUT', 'Migration must not manage transactions: ' + name);
    migrations.push({ name, sql, checksum: checksum(sql) });
  }
  return migrations;
}

/** Pure comparison; reject unknown history, edits, and holes before applying ANY pending file. */
export function compareMigrationHistory(migrations: readonly MigrationLedgerEntry[], ledger: readonly MigrationLedgerEntry[]): MigrationHistory {
  const recorded = new Map(ledger.map(row => [row.name, row.checksum]));
  const known = new Set(migrations.map(row => row.name));
  const pending: MigrationLedgerEntry[] = [], mismatches: { name: string; expected: string; actual: string }[] = [], outOfOrder: string[] = [];
  let foundPending = false;
  for (const migration of migrations) {
    const prior = recorded.get(migration.name);
    if (prior === undefined) { pending.push({ name: migration.name, checksum: migration.checksum }); foundPending = true; }
    else {
      if (prior !== migration.checksum) mismatches.push({ name: migration.name, expected: migration.checksum, actual: prior });
      if (foundPending) outOfOrder.push(migration.name);
    }
  }
  return {
    applied: [...ledger].sort((a, b) => a.name.localeCompare(b.name)), pending, mismatches,
    unknownApplied: ledger.filter(row => !known.has(row.name)).map(row => row.name).sort(), outOfOrder,
  };
}

export function migrationBlockers(history: MigrationHistory, ledgerExists: boolean, publicTables: readonly string[]): readonly string[] {
  const blockers: string[] = [];
  if (!ledgerExists && publicTables.length) blockers.push('Populated schema has no migration ledger; automatic baselining is forbidden');
  if (ledgerExists && !history.applied.length && publicTables.some(name => name !== 'schema_migrations')) blockers.push('Empty ledger on a populated schema; automatic baselining is forbidden');
  if (history.mismatches.length) blockers.push('Applied migration content changed; add a new migration instead');
  if (history.unknownApplied.length) blockers.push('Ledger contains migrations absent from this release');
  if (history.outOfOrder.length) blockers.push('Applied migrations are not a contiguous release prefix');
  return blockers;
}

async function inspectClient(client: PoolClient, directory: string, migrations: readonly Migration[]): Promise<MigrationInspection> {
  const identity = await client.query<MigrationInspection['target']>(
    'SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"',
  );
  const tables = await client.query<{ name: string }>("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname");
  const publicTables = tables.rows.map(row => row.name);
  const ledgerExists = publicTables.includes('schema_migrations');
  const ledger = ledgerExists ? (await client.query<MigrationLedgerEntry>('SELECT name, checksum FROM public.schema_migrations ORDER BY name')).rows : [];
  const history = compareMigrationHistory(migrations, ledger);
  const blockers = migrationBlockers(history, ledgerExists, publicTables);
  const target = identity.rows[0];
  if (!target) throw new DomainError('INVALID_STATE', 'Database identity unavailable');
  const planSha256 = checksum(JSON.stringify({ target, migrations: migrations.map(({ name, checksum: sha }) => ({ name, checksum: sha })), ledger: history.applied, publicTables }));
  return { directory, total: migrations.length, ledgerExists, publicTables, target, ...history, blockers, planSha256 };
}

async function withMigrationSession<T>(connectionString: string | undefined, options: MigrationOptions, action: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!connectionString) throw new DomainError('NOT_CONFIGURED', 'DATABASE_URL required for migrations');
  const timeout = options.statementTimeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new DomainError('INVALID_INPUT', 'Invalid migration statement timeout');
  const pool = new Pool({ connectionString, max: 1, allowExitOnIdle: true, connectionTimeoutMillis: 5000 });
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query("SET search_path TO public");
    await client.query("SELECT set_config('lock_timeout', '5s', false), set_config('statement_timeout', $1, false)", [String(timeout)]);
    if (options.tryLock) {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
      if (!result.rows[0]?.locked) throw new DomainError('CONFLICT', 'Another migration session holds the advisory lock');
    } else await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
    locked = true;
    return await action(client);
  } finally {
    if (client) {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => undefined);
      client.release(true); // Destroy the session, including any remaining transaction/lock after failure.
    }
    await pool.end();
  }
}

/** Consistent, read-only inspection: no CREATE TABLE, DDL, seed or migration SQL. */
export async function inspectMigrations(connectionString: string | undefined, options: MigrationOptions = {}): Promise<MigrationInspection> {
  const directory = options.directory ?? defaultMigrationsDirectory;
  const migrations = await loadMigrations(directory);
  return withMigrationSession(connectionString, options, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await inspectClient(client, directory, migrations);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  });
}

/** Shared engine for isolated QA and explicitly authorized operator releases. Never called at app startup. */
export async function runMigrations(connectionString: string | undefined, options: MigrationOptions = {}): Promise<MigrationReport> {
  const directory = options.directory ?? defaultMigrationsDirectory;
  const migrations = await loadMigrations(directory);
  return withMigrationSession(connectionString, options, async client => {
    const inspection = await inspectClient(client, directory, migrations);
    await options.beforeApply?.(inspection);
    if (inspection.blockers.length) throw new DomainError('CONFLICT', inspection.blockers.join('; '));
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const recorded = new Set(inspection.applied.map(row => row.name));
    const appliedNow: string[] = [], skipped: string[] = [];
    for (const migration of migrations) {
      if (recorded.has(migration.name)) {
        skipped.push(migration.name); options.onProgress?.('SKIPPED', migration.name); continue;
      }
      options.onProgress?.('APPLYING', migration.name);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        const detail = error instanceof Error ? error.message : 'unknown error';
        throw new DomainError('INVALID_STATE', 'Migration failed: ' + migration.name + ': ' + detail);
      }
      appliedNow.push(migration.name); options.onProgress?.('APPLIED', migration.name);
    }
    return { directory, total: migrations.length, applied: appliedNow, skipped };
  });
}
