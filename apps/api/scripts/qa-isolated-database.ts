/**
 * Shared isolated-QA database lifecycle for verification scripts.
 * Refuses remote hosts and always targets a brand-new disposable database.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DomainError } from '@qeynox/domain';

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const qaDatabasePattern = /^qeynox_qa_[a-z0-9_]{6,40}$/;
const sessionDrainTimeoutMs = 5000;
const sessionPollIntervalMs = 50;

async function otherSessions(admin: Pool, database: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
    [database],
  );
  return Number(result.rows[0]?.count ?? 0);
}
async function waitForSessionsToDrain(admin: Pool, database: string, timeoutMs = sessionDrainTimeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await otherSessions(admin, database) === 0) return;
    await new Promise(resolve => setTimeout(resolve, sessionPollIntervalMs));
  }
}
export interface IsolatedQaDatabase {
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}
export async function createIsolatedQaDatabase(): Promise<IsolatedQaDatabase> {
  const value = process.env.QEYNOX_QA_DATABASE_URL;
  if (!value) throw new DomainError('NOT_CONFIGURED', 'QEYNOX_QA_DATABASE_URL is required for isolated QA runs');
  const source = new URL(value);
  if (!localHosts.has(source.hostname)) throw new DomainError('DENIED', 'QA runs refuse non-local database hosts: ' + source.hostname);
  const name = 'qeynox_qa_' + randomUUID().replace(/-/g, '').slice(0, 16);
  if (!qaDatabasePattern.test(name)) throw new Error('Generated QA database name is not safe');
  const admin = new Pool({ connectionString: value, max: 1 });
  admin.on('error', error => console.error('QA admin pool error:', error instanceof Error ? error.message : 'unknown database error'));
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
  } catch (error: unknown) {
    await admin.end().catch(() => undefined);
    throw error;
  }
  const target = new URL(value);
  target.pathname = '/' + name;
  return {
    url: target.toString(),
    name,
    drop: async () => {
      try {
        // Callers must close their pools first; wait out the socket-close race before dropping.
        await waitForSessionsToDrain(admin, name);
        const remaining = await otherSessions(admin, name);
        if (remaining > 0) {
          await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
          await waitForSessionsToDrain(admin, name, 2000);
        }
        await admin.query('DROP DATABASE IF EXISTS "' + name + '"');
      } finally {
        await admin.end().catch(() => undefined);
      }
    },
  };
}
