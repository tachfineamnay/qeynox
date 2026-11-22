import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '@qeynox/domain';
import type { ArtifactStorePort, ObjectHead, ObjectReceipt } from './artifacts';
import { storageConfiguration } from './storage-configuration';

export interface S3ArtifactStoreOptions {
  endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string;
  serverSideEncryption?: 'AES256' | false;
  timeoutMs?: number; maxAttempts?: number;
}
export const STORAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Namespace defense in depth; workspace/document authorization remains in canonical services. */
export function assertPrivateObjectKey(key: string): void {
  const parts = key.split('/');
  if (!/^workspaces\/[A-Za-z0-9_-]+\/(?:documents|operations)\//.test(key) || parts.some(p => !p || p === '.' || p === '..' || /[\\%\u0000-\u001f\u007f]/.test(p)) || key.length > 1024) {
    throw new DomainError('DENIED', 'Invalid private storage object key');
  }
}
export function storageFailureCode(error: unknown): string {
  if (error instanceof DomainError && ['AUTH_REJECTED', 'NOT_FOUND', 'ALREADY_EXISTS', 'THROTTLED', 'TIMEOUT', 'UNAVAILABLE'].includes(error.context?.storageFailure ?? '')) return error.context!.storageFailure!;
  const wire = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  const status = wire?.$metadata?.httpStatusCode;
  if (status === 401 || status === 403) return 'AUTH_REJECTED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 412) return 'ALREADY_EXISTS';
  if (status === 429 || status === 503) return 'THROTTLED';
  if (wire?.name === 'AbortError' || wire?.name === 'TimeoutError') return 'TIMEOUT';
  return 'UNAVAILABLE';
}

export function createS3ArtifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): S3ArtifactStore | undefined {
  const config = storageConfiguration(env);
  if (config.issues.length) return undefined;
  return new S3ArtifactStore(env.QEYNOX_ARTIFACT_BUCKET!, {
    endpoint: env.QEYNOX_ARTIFACT_ENDPOINT, region: env.QEYNOX_ARTIFACT_REGION!,
    accessKeyId: env.QEYNOX_ARTIFACT_ACCESS_KEY!, secretAccessKey: env.QEYNOX_ARTIFACT_SECRET_KEY!,
    serverSideEncryption: config.encryption, timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts,
  });
}

export class S3ArtifactStore implements ArtifactStorePort {
  private readonly client: S3Client;
  private readonly encryption: 'AES256' | false;
  private readonly timeoutMs: number;
  constructor(private readonly bucket: string, options: S3ArtifactStoreOptions) {
    if (!bucket || !options.region || !options.accessKeyId || !options.secretAccessKey) throw new DomainError('NOT_CONFIGURED', 'Private S3 credentials and bucket are required');
    this.encryption = options.serverSideEncryption ?? 'AES256';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 20_000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new DomainError('NOT_CONFIGURED', 'Invalid bounded storage transport settings');
    this.client = new S3Client({
      region: options.region, endpoint: options.endpoint, forcePathStyle: Boolean(options.endpoint),
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts, retryMode: 'standard', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 2000, requestTimeout: this.timeoutMs },
    });
  }
  private async bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new DomainError('UNAVAILABLE', 'Private storage deadline exceeded', { storageFailure: 'TIMEOUT' })); }, this.timeoutMs);
      });
      return await Promise.race([operation(controller.signal), deadline]);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = storageFailureCode(error);
      throw new DomainError(code === 'ALREADY_EXISTS' ? 'CONFLICT' : 'UNAVAILABLE', 'Private storage operation failed: ' + code, { storageFailure: code });
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async put(key: string, body: Uint8Array, contentType: string): Promise<ObjectReceipt> {
    assertPrivateObjectKey(key);
    if (body.byteLength > STORAGE_MAX_BYTES) throw new DomainError('INVALID_INPUT', 'Storage object exceeds transfer size policy');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const input: PutObjectCommandInput = { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, IfNoneMatch: '*', Metadata: { sha256 } };
    if (this.encryption) input.ServerSideEncryption = this.encryption;
    const response = await this.bounded(signal => this.client.send(new PutObjectCommand(input), { abortSignal: signal }));
    return { key, versionId: response.VersionId, sha256, size: body.byteLength };
  }
  async head(key: string): Promise<ObjectHead | undefined> {
    assertPrivateObjectKey(key);
    return this.bounded(async signal => {
      try {
        const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
        return { sha256: response.Metadata?.sha256, size: response.ContentLength };
      } catch (error) {
        // Only an authoritative missing-object response is absence; never turn 403/timeouts into DELETED.
        if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
          // A missing/misrouted bucket must not masquerade as verified object deletion.
          await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'workspaces/', MaxKeys: 1 }), { abortSignal: signal });
          return undefined;
        }
        throw error;
      }
    });
  }
  async signedRead(key: string, expiresSeconds: number): Promise<string> {
    assertPrivateObjectKey(key);
    if (!Number.isSafeInteger(expiresSeconds)) throw new DomainError('INVALID_INPUT', 'Invalid signing expiry');
    const object = await this.head(key);
    if (!object) throw new DomainError('NOT_FOUND', 'Private storage object is unavailable', { storageFailure: 'NOT_FOUND' });
    if (object.size !== undefined && object.size > STORAGE_MAX_BYTES) throw new DomainError('INVALID_INPUT', 'Storage object exceeds transfer size policy');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: Math.max(30, Math.min(300, expiresSeconds)) });
  }
  signedPut(key: string, contentType: string, expiresSeconds: number): Promise<string> {
    assertPrivateObjectKey(key);
    if (!Number.isSafeInteger(expiresSeconds)) throw new DomainError('INVALID_INPUT', 'Invalid signing expiry');
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, IfNoneMatch: '*', ...(this.encryption ? { ServerSideEncryption: this.encryption } : {}) }), {
      expiresIn: Math.max(60, Math.min(900, expiresSeconds)), unhoistableHeaders: new Set(['x-amz-server-side-encryption', 'if-none-match']),
    });
  }
  async read(key: string): Promise<Uint8Array> {
    assertPrivateObjectKey(key);
    return this.bounded(async signal => {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      if (!response.Body) throw new DomainError('UNAVAILABLE', 'Storage object body missing');
      const reader = response.Body.transformToWebStream().getReader();
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        if (signal.aborted) throw new DomainError('UNAVAILABLE', 'Storage read cancelled');
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > STORAGE_MAX_BYTES) throw new DomainError('INVALID_INPUT', 'Storage object exceeds transfer size policy');
          chunks.push(next.value);
        }
        if (signal.aborted) throw new DomainError('UNAVAILABLE', 'Storage read cancelled');
        return Buffer.concat(chunks);
      } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
    });
  }
  async deleteObject(key: string): Promise<void> {
    assertPrivateObjectKey(key);
    await this.bounded(signal => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal }));
  }
  close(): void { this.client.destroy(); }
  /** Read-only credential/bucket probe. Never returns keys/content or claims PUT/SSE/delete certification. */
  async probe(): Promise<{ status: 'READABLE_NOT_WRITE_VERIFIED' | 'BLOCKED'; failure?: string }> {
    try {
      await this.bounded(signal => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'workspaces/', MaxKeys: 1 }), { abortSignal: signal }));
      return { status: 'READABLE_NOT_WRITE_VERIFIED' };
    } catch (error) { return { status: 'BLOCKED', failure: storageFailureCode(error) }; }
  }
}
