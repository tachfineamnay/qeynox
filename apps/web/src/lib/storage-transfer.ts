import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const transfer = z.object({ url: z.string().url(), method: z.enum(['GET', 'PUT']), workspaceId: z.string(), sessionHash: z.string(), expires: z.number().int().positive() }).strict();
export const maxTransferBytes = 10 * 1024 * 1024;
function key(env: NodeJS.ProcessEnv): Buffer {
  const text = env.QEYNOX_STORAGE_RELAY_KEY ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new Error('STORAGE_RELAY_NOT_CONFIGURED');
  return Buffer.from(text, 'base64');
}
function validateTarget(value: string, workspaceId: string, env: NodeJS.ProcessEnv): URL {
  const url = new URL(value), endpoint = new URL(env.QEYNOX_ARTIFACT_ENDPOINT ?? '');
  const bucket = env.QEYNOX_ARTIFACT_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[A-Za-z0-9_-]{4,128}$/.test(workspaceId)) throw new Error('INVALID_STORAGE_SCOPE');
  if (endpoint.origin !== 'http://qeynox-storage:9000' || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('PRIVATE_STORAGE_REQUIRED');
  const path = decodeURIComponent(url.pathname);
  if (url.origin !== endpoint.origin || url.username || url.password || url.hash || !path.startsWith('/' + bucket + '/workspaces/' + workspaceId + '/') || path.split('/').some(part => part === '..' || part === '.')) throw new Error('INVALID_STORAGE_SCOPE');
  if (!/^[a-f0-9]{64}$/.test(url.searchParams.get('X-Amz-Signature') ?? '')) throw new Error('SIGNED_OBJECT_REQUIRED');
  return url;
}
export function mintStorageTransfer(url: string, method: 'GET' | 'PUT', workspaceId: string, sessionToken: string, env: NodeJS.ProcessEnv, now = Date.now()): string {
  validateTarget(url, workspaceId, env);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const value = JSON.stringify({ url, method, workspaceId, sessionHash: createHash('sha256').update(sessionToken).digest('hex'), expires: now + 120_000 });
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const ticket = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const publicUrl = new URL(env.QEYNOX_PUBLIC_URL ?? '');
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_ORIGIN_REQUIRED');
  return new URL('/storage-transfer?ticket=' + ticket, publicUrl).href;
}
export function openStorageTransfer(ticket: string, method: string, workspaceId: string, sessionToken: string, env: NodeJS.ProcessEnv, now = Date.now()): URL {
  if (!/^[A-Za-z0-9_-]{40,16000}$/.test(ticket)) throw new Error('INVALID_STORAGE_TRANSFER');
  const bytes = Buffer.from(ticket, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key(env), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const value = transfer.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')));
  if (value.method !== method || value.workspaceId !== workspaceId || value.sessionHash !== createHash('sha256').update(sessionToken).digest('hex') || value.expires <= now || value.expires > now + 120_000) throw new Error('EXPIRED_OR_WRONG_STORAGE_TRANSFER');
  return validateTarget(value.url, workspaceId, env);
}
/** Bound before buffering: Content-Length alone is not trusted (chunked transfers are allowed). */
export async function boundedTransferBody(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxTransferBytes) { await reader.cancel(); throw new Error('TRANSFER_TOO_LARGE'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
