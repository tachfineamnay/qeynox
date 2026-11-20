import { startQeyNoxWorker } from '@qeynox/orchestration';
import { createWorkerDependencies } from './runtime';

async function main() {
  await startQeyNoxWorker(await createWorkerDependencies());
}
main().catch((error: unknown) => {
  console.error('Worker stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});

/**
 * MISSION A17 — background document ingestion (best-effort same-process poller).
 *
 * The durable job table (document_ingest_jobs) is the guarantee; this loop merely drains it on an
 * interval. Disable with QEYNOX_DOCUMENT_INGEST_INTERVAL_MS=0. Without storage configuration the
 * poller does not run at all — it never pretends ingestion happened.
 */
async function startDocumentIngestPoller(): Promise<void> {
  const interval = Number(process.env.QEYNOX_DOCUMENT_INGEST_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(interval) || interval <= 0) return;
  const { connectDatabase } = await import('@qeynox/persistence');
  const { S3ArtifactStore, DocumentVaultService, embeddingsFromEnv } = await import('@qeynox/application');
  const accessKeyId = process.env.QEYNOX_ARTIFACT_ACCESS_KEY;
  const secretAccessKey = process.env.QEYNOX_ARTIFACT_SECRET_KEY;
  const bucket = process.env.QEYNOX_ARTIFACT_BUCKET;
  if (!accessKeyId || !secretAccessKey || !bucket) {
    console.log('[documents] ingest poller idle: object storage is not configured (QEYNOX_ARTIFACT_*); ingestion stays fail-closed');
    return;
  }
  const conn = connectDatabase(process.env.DATABASE_URL);
  const { QeyNoxStore } = await import('@qeynox/persistence');
  const objects = new S3ArtifactStore(bucket, {
    accessKeyId, secretAccessKey,
    region: process.env.QEYNOX_ARTIFACT_REGION ?? 'us-east-1',
    endpoint: process.env.QEYNOX_ARTIFACT_ENDPOINT,
    serverSideEncryption: process.env.QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION === 'false' ? false : 'AES256',
  });
  const vault = new DocumentVaultService(new QeyNoxStore(conn.db), objects, embeddingsFromEnv());
  setInterval(() => {
    void vault.drainIngestPending({ limit: 5 }).catch(error => {
      console.error('[documents] ingest drain failed:', error instanceof Error ? error.message : 'unknown');
    });
    void vault.purgeExpired({ limit: 10 }).catch(() => undefined);
  }, interval).unref();
  console.log('[documents] ingest poller running every ' + interval + ' ms');
}

void startDocumentIngestPoller();
