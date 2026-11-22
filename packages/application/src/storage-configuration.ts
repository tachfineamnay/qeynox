import { DomainError } from '@qeynox/domain';

/** Shared by API document/results and Worker; never returns credential values in diagnostics. */
export function storageConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const issues: { key: string; code: string }[] = [];
  const need = ['QEYNOX_ARTIFACT_ENDPOINT', 'QEYNOX_ARTIFACT_REGION', 'QEYNOX_ARTIFACT_BUCKET', 'QEYNOX_ARTIFACT_ACCESS_KEY', 'QEYNOX_ARTIFACT_SECRET_KEY'];
  for (const key of need) if (!env[key]?.trim()) issues.push({ key, code: 'REQUIRED' });
  if (env.QEYNOX_ARTIFACT_ENDPOINT) try {
    const url = new URL(env.QEYNOX_ARTIFACT_ENDPOINT);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (env.NODE_ENV === 'production' && url.origin !== 'http://qeynox-storage:9000') throw new Error();
  } catch { issues.push({ key: 'QEYNOX_ARTIFACT_ENDPOINT', code: 'PRIVATE_ENDPOINT_REQUIRED' }); }
  if (env.QEYNOX_ARTIFACT_BUCKET && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.QEYNOX_ARTIFACT_BUCKET)) issues.push({ key: 'QEYNOX_ARTIFACT_BUCKET', code: 'INVALID_BUCKET' });
  const encryption = env.QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION ?? 'AES256';
  if (!['AES256', 'false'].includes(encryption) || (env.NODE_ENV === 'production' && encryption !== 'AES256')) issues.push({ key: 'QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION', code: 'ENCRYPTION_REQUIRED' });
  const timeoutMs = Number(env.QEYNOX_STORAGE_TIMEOUT_MS ?? 10_000);
  const maxAttempts = Number(env.QEYNOX_STORAGE_MAX_ATTEMPTS ?? 2);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20_000) issues.push({ key: 'QEYNOX_STORAGE_TIMEOUT_MS', code: 'RANGE_1000_20000' });
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) issues.push({ key: 'QEYNOX_STORAGE_MAX_ATTEMPTS', code: 'RANGE_1_3' });
  return { issues, timeoutMs, maxAttempts, encryption: encryption === 'false' ? false as const : 'AES256' as const };
}

/** Infrastructure-loop limits only. P10–P12 claim/fencing/recovery logic remains unchanged. */
export function documentMaintenanceConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const read = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new DomainError('NOT_CONFIGURED', 'Invalid document maintenance setting: ' + key);
    return value;
  };
  const intervalMs = read('QEYNOX_DOCUMENT_INGEST_INTERVAL_MS', 5000, env.NODE_ENV === 'production' ? 1000 : 0, 60_000);
  const leaseMs = read('QEYNOX_DOCUMENT_INGEST_LEASE_MS', 300_000, 30_000, 1_800_000);
  const ingestBatch = read('QEYNOX_DOCUMENT_INGEST_BATCH', 1, 1, 10);
  const retentionBatch = read('QEYNOX_DOCUMENT_RETENTION_BATCH', 5, 1, 10);
  const deletionBatch = read('QEYNOX_DOCUMENT_DELETION_BATCH', 1, 1, 10);
  const { timeoutMs } = storageConfiguration(env);
  // P12 claims a batch under a fixed 120s lease; leave time for DB/loop overhead.
  if (deletionBatch * 2 * timeoutMs > 100_000) throw new DomainError('NOT_CONFIGURED', 'Storage deletion batch can outlive its existing lease');
  if (leaseMs < timeoutMs + 30_000) throw new DomainError('NOT_CONFIGURED', 'Ingestion lease needs storage and extraction headroom');
  return { intervalMs, leaseMs, ingestBatch, retentionBatch, deletionBatch };
}
