import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { DomainError } from '@qeynox/domain';

/** Ordered SQL migration files applied exactly once and recorded in schema_migrations. */
export interface Migration { readonly name: string; readonly sql: string; readonly checksum: string }
export interface MigrationReport {
  readonly directory: string;
  readonly total: number;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}
export type MigrationProgress = (event: 'APPLYING' | 'APPLIED' | 'SKIPPED', name: string) => void;

const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const transactionControl = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im;
const migrationsTable = 'schema_migrations';
export const defaultMigrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Loads and validates migration files without opening a database connection. */
export async function loadMigrations(directory: string = defaultMigrationsDirectory): Promise<readonly Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new DomainError('NOT_CONFIGURED', 'Migration directory is unavailable');
  }
  const names = entries.filter(name => migrationFilePattern.test(name)).sort();
  if (!names.length) throw new DomainError('NOT_CONFIGURED', 'No migration files found');
  const migrations: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(join(directory, name), 'utf8');
    if (!sql.trim()) throw new DomainError('INVALID_INPUT', 'Migration is empty: ' + name);
    // The runner owns the transaction boundary; a file-level BEGIN/COMMIT would silently escape it.
    if (transactionControl.test(sql)) throw new DomainError('INVALID_INPUT', 'Migration must not manage transactions: ' + name);
    migrations.push({ name, sql, checksum: checksum(sql) });
  }
  return migrations;
}

/**
 * Applies pending migrations inside one transaction per file.
 * Already-applied migrations are skipped; a changed checksum fails closed instead of re-running.
 * Callers must target a disposable QA database during verification. Never production.
 */
export async function runMigrations(
  connectionString: string | undefined,
  options: { directory?: string; onProgress?: MigrationProgress } = {},
): Promise<MigrationReport> {
  if (!connectionString) throw new DomainError('NOT_CONFIGURED', 'DATABASE_URL required for migrations');
  const directory = options.directory ?? defaultMigrationsDirectory;
  const migrations = await loadMigrations(directory);
  const pool = new Pool({ connectionString, max: 1, allowExitOnIdle: true });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['qeynox.schema_migrations']);
    await client.query(
      'CREATE TABLE IF NOT EXISTS ' + migrationsTable +
        ' (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const existing = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM ' + migrationsTable);
    const applied = new Map(existing.rows.map(row => [row.name, row.checksum]));
    const appliedNow: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      const prior = applied.get(migration.name);
      if (prior !== undefined) {
        if (prior !== migration.checksum) {
          throw new DomainError('CONFLICT', 'Applied migration content changed; add a new migration instead: ' + migration.name);
        }
        skipped.push(migration.name);
        options.onProgress?.('SKIPPED', migration.name);
        continue;
      }
      options.onProgress?.('APPLYING', migration.name);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO ' + migrationsTable + ' (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        const detail = error instanceof Error ? error.message : 'unknown error';
        throw new DomainError('INVALID_STATE', 'Migration failed: ' + migration.name + ': ' + detail);
      }
      appliedNow.push(migration.name);
      options.onProgress?.('APPLIED', migration.name);
    }
    return { directory, total: migrations.length, applied: appliedNow, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['qeynox.schema_migrations']).catch(() => undefined);
    client.release();
    await pool.end();
  }
}
