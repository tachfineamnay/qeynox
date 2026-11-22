import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const transfer = z.object({ url: z.string().url(), method: z.enum(['GET', 'PUT']), workspaceId: z.string(), sessionHash: z.string(), expires: z.number().int().positive() }).strict();
export class StorageTransferError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
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
  const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
  if (url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || !signed.includes('host') || signed.some(header => !['host', 'content-type', 'if-none-match', 'x-amz-server-side-encryption'].includes(header))) throw new Error('UNSUPPORTED_STORAGE_SIGNATURE');
  return url;
}
function signedExpiry(url: URL, now: number): number {
  const text = url.searchParams.get('X-Amz-Date') ?? '';
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  const seconds = Number(url.searchParams.get('X-Amz-Expires'));
  if (!match || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900) throw new Error('INVALID_STORAGE_EXPIRY');
  const issued = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  if (!Number.isFinite(issued) || issued > now + 60_000 || issued + seconds * 1000 <= now + 5000) throw new StorageTransferError('STORAGE_GRANT_EXPIRED', 410);
  return issued + seconds * 1000 - 5000;
}
/** Explicitly forward only supported signed headers, without rewriting Host/path/query. */
export function storageTransferHeaders(url: URL, contentType: string): Record<string, string> {
  const signed = new Set((url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';'));
  return { 'content-type': contentType,
    ...(signed.has('if-none-match') ? { 'if-none-match': '*' } : {}),
    ...(signed.has('x-amz-server-side-encryption') ? { 'x-amz-server-side-encryption': 'AES256' } : {}),
  };
}
/** Reuse canonical resource checks on every transfer, including retention/revocation after minting. */
export function storageTransferAuthorization(url: URL, method: string): { path: string; pendingUpload: boolean } {
  const parts = decodeURIComponent(url.pathname).split('/').slice(1);
  const id = (value: string | undefined) => Boolean(value && /^[A-Za-z0-9_-]{4,120}$/.test(value));
  if (parts.length === 6 && parts[3] === 'documents' && id(parts[4])) {
    return { path: '/v1/documents/' + parts[4] + (method === 'GET' ? '/download' : ''), pendingUpload: method === 'PUT' };
  }
  const artifact = parts[7]?.match(/^([A-Za-z0-9_-]{4,120})\.(json|html|pdf)$/)?.[1];
  if (method === 'GET' && parts.length === 8 && parts[3] === 'operations' && parts[5] === 'results' && id(parts[4]) && id(parts[6]) && artifact) {
    return { path: '/v1/operations/' + parts[4] + '/documents/' + parts[6] + '/artifacts/' + artifact, pendingUpload: false };
  }
  throw new Error('UNSUPPORTED_STORAGE_OBJECT');
}
export function mintStorageTransfer(url: string, method: 'GET' | 'PUT', workspaceId: string, sessionToken: string, env: NodeJS.ProcessEnv, now = Date.now()): string {
  const target = validateTarget(url, workspaceId, env);
  const expires = Math.min(now + 120_000, signedExpiry(target, now));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const value = JSON.stringify({ url, method, workspaceId, sessionHash: createHash('sha256').update(sessionToken).digest('hex'), expires });
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
  if (value.expires <= now) throw new StorageTransferError('STORAGE_GRANT_EXPIRED', 410);
  if (value.method !== method || value.workspaceId !== workspaceId || value.sessionHash !== createHash('sha256').update(sessionToken).digest('hex') || value.expires > now + 120_000) throw new Error('EXPIRED_OR_WRONG_STORAGE_TRANSFER');
  const target = validateTarget(value.url, workspaceId, env);
  signedExpiry(target, now);
  return target;
}
/** Bound before buffering: Content-Length alone is not trusted (chunked transfers are allowed). */
export async function boundedTransferBody(stream: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => { void reader.cancel().catch(() => undefined); reject(new StorageTransferError('STORAGE_TRANSFER_TIMEOUT', 504)); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxTransferBytes) { void reader.cancel().catch(() => undefined); throw new StorageTransferError('TRANSFER_TOO_LARGE', 413); }
      chunks.push(next.value);
    }
  } finally { if (abort) signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  if (signal?.aborted) throw new StorageTransferError('STORAGE_TRANSFER_TIMEOUT', 504);
  return Buffer.concat(chunks);
}
