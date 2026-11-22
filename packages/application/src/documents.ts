/**
 * MISSION A17 — customer documents and tenant-safe knowledge.
 *
 * Upload flow (private object storage, no bytes through the API):
 *   1. beginUpload  — validates metadata (type/size/sha256/retention/purpose), creates a
 *                     PENDING_UPLOAD row and returns a presigned single-PUT URL;
 *   2. the client PUTs the bytes directly to object storage;
 *   3. completeUpload — head/read back, verifies size + SHA-256 against the declaration, sniffs the
 *                     declared type, flips the row to PROCESSING and enqueues a background ingest job;
 *   4. drainIngestPending — worker-side (or QA-driven) background processing: download, extract
 *                     (PDF/DOCX/text), chunk, index; state AVAILABLE or FAILED with a real code.
 *
 * Retrieval: tenant-scoped PostgreSQL full-text search over document_chunks (tsvector generated in
 * the database). Optional hybrid reranking when a reviewed OpenAI-compatible embedding provider is
 * configured through attested, host-allowlisted egress — never otherwise, and never faked.
 *
 * Citations returned by search are grounded in actual uploaded documents: every citation carries
 * documentId + chunkId + the parent document's SHA-256. Deleting a document cascades to chunks and
 * attachments — cited material disappears with the source it cites.
 *
 * Ingestion and retrieval are strictly separate from business verification: nothing here promotes
 * a claim, mutates an operation or writes an evidence record.
 *
 * Retention & consent: upload requires an explicit purpose statement (the recorded consent act) and
 * stores it; retentionDays/expiresAt bound lifetime. Expired documents are excluded from
 * list/search/download and are purged by purgeExpired.
 *
 * Deletion (P12): delete and retention purge revoke access atomically — the document row, chunks,
 * attachments and ingest job disappear in the same transaction that persists a durable
 * document_storage_deletions intent. The storage object is then deleted and verified absent, with
 * lease-protected retries (drainStorageDeletions); storage deletion is never reported as done unless
 * verified, and an exhausted intent ends FAILED for operator attention instead of being forgotten.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DomainError, isConsentActive, newId, type ID, type Principal } from '@qeynox/domain';
import {
  QeyNoxStore, assertActiveWorkspaceMember, documentAuditEvents, documentChunks, documentIngestJobs, documentStorageDeletions, documents, identityMemberships, operationDocuments, operations,
  type StorageDeletionReason, type StorageDeletionState,
} from '@qeynox/persistence';
import { storageFailureCode } from './s3';
import { cosineSimilarity, type EmbeddingProvider } from './embeddings';

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const;
export type DocumentContentType = (typeof DOCUMENT_ALLOWED_CONTENT_TYPES)[number];

export interface DocumentObjectPort {
  signedPut(key: string, contentType: string, expiresSeconds: number): Promise<string>;
  head(key: string): Promise<{ sha256?: string; size?: number } | undefined>;
  read(key: string): Promise<Uint8Array>;
  signedRead(key: string, expiresSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface BeginUploadInput { readonly name: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string; readonly purpose: string; readonly retentionDays?: number }
export interface DocumentView {
  readonly id: string; readonly name: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string;
  readonly state: 'PENDING_UPLOAD' | 'PROCESSING' | 'AVAILABLE' | 'FAILED' | 'DELETED';
  readonly extractionCode: string | null; readonly purpose: string | null; readonly uploadedBy: string;
  readonly retentionDays: number; readonly expiresAt: string | null; readonly expired: boolean;
  readonly chunkCount: number; readonly createdAt: string; readonly attachments: number;
}
export interface Citation {
  readonly citationId: string; readonly documentId: string; readonly chunkId: string;
  readonly name: string; readonly sha256: string; readonly page: number | null; readonly ordinal: number;
  readonly snippet: string; readonly score: number; readonly mode: 'FTS' | 'HYBRID';
}
export interface SearchResult { readonly query: string; readonly mode: 'FTS' | 'HYBRID'; readonly embedding: 'CONFIGURED' | 'NOT_CONFIGURED'; readonly citations: readonly Citation[] }

/**
 * P10 — why an attached document contributed nothing to an agent step. Reported truthfully (to the
 * agent, the step output and the document audit log), never silently dropped.
 */
export type WithheldDocumentReason =
  | 'NOT_AVAILABLE'          // still PENDING_UPLOAD / PROCESSING, or FAILED ingestion
  | 'EXPIRED'                // retention window elapsed (purge may not have run yet)
  | 'NO_CONSENT_RECORD'      // no recorded upload purpose (the consent act)
  | 'ACCESS_REVOKED'         // the member who attached it no longer has ACTIVE workspace access
  | 'CONSENT_MISSING'        // the mission owner has not granted the document-to-AI consent scope
  | 'PROFILE_NOT_PERMITTED'; // the reviewed agent profile does not accept document excerpts
export interface MissionPassage {
  readonly documentId: string; readonly chunkId: string; readonly name: string; readonly documentSha256: string;
  readonly page: number | null; readonly ordinal: number;
  /** Bounded excerpt actually handed to the agent, and the SHA-256 of exactly that text. */
  readonly excerpt: string; readonly excerptSha256: string; readonly truncated: boolean;
  readonly score: number;
}
export interface MissionPassageBounds { readonly maxPassages: number; readonly maxPassageChars: number; readonly maxTotalChars: number }
export interface MissionPassageRetrieval {
  readonly mode: 'FTS' | 'HYBRID' | 'LEADING' | 'NONE';
  readonly passages: readonly MissionPassage[];
  readonly withheld: readonly { readonly documentId: string; readonly name: string; readonly reason: WithheldDocumentReason }[];
  readonly attachedCount: number;
}

interface ExtractedPage { readonly text: string; readonly page?: number }
interface ExtractedDocument { readonly pages: readonly ExtractedPage[] }

const sha256Of = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

/** P12 — storage deletion of a revoked document: what the caller can truthfully be told. */
export type StorageDeletionOutcome = 'DELETED' | 'PENDING';
/** P12 — storage-deletion attempts before the intent is FAILED (operator attention); ~1 min → 6 h backoff. */
export const STORAGE_DELETION_MAX_ATTEMPTS = 12;
const STORAGE_DELETION_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const STORAGE_DELETION_LEASE_MS = 120_000;
/** Presigned PUT lifetime (600 s, see beginUpload) plus margin. */
const UPLOAD_URL_GRACE_MS = 11 * 60 * 1000;
interface ClaimedStorageDeletion { readonly id: string; readonly workspaceId: string; readonly documentId: string; readonly storageKey: string; readonly attempts: number; readonly token: string; readonly notBefore: Date }
/** A short, non-sensitive error classifier (SDK error name only — never messages, keys or URLs). */
function storageErrorSuffix(error: unknown): string {
  if (error instanceof DomainError && error.context?.storageFailure) return ':S3_' + storageFailureCode(error);
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(name) ? ':' + name : '';
}

/** P11 — ingestion attempts per document before a terminal FAILED (claims of abandoned jobs count). */
export const INGEST_MAX_ATTEMPTS = 3;
/** P11 — processing lease; renewed between phases. QEYNOX_DOCUMENT_INGEST_LEASE_MS, clamped 30 s – 30 min. */
function ingestLeaseMs(): number {
  const configured = Number(process.env.QEYNOX_DOCUMENT_INGEST_LEASE_MS ?? 300_000);
  return Number.isFinite(configured) ? Math.max(30_000, Math.min(1_800_000, Math.floor(configured))) : 300_000;
}
/** This worker's claim was taken over (lease expired and re-claimed, or reset): stop without writing. */
class IngestLeaseLostError extends Error { constructor() { super('Ingest lease lost'); } }
/** Not worth retrying (document gone or no longer awaiting ingestion). */
class IngestTerminalError extends Error { constructor(readonly code: string) { super('Ingest cannot proceed: ' + code); } }
const uuid = () => randomUUID();
const isHex64 = (value: string) => /^[0-9a-f]{64}$/i.test(value);
const nowIso = () => new Date().toISOString();

function sanitizeName(name: string): string {
  const trimmed = name.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  return trimmed.length ? trimmed : 'document';
}

function storageKeyFor(workspaceId: string, id: string, name: string): string {
  // The key carries no customer data beyond the random document id and a safe slug of the name.
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
  return `workspaces/${workspaceId}/documents/${id}/${slug === '.' || slug === '..' ? 'document' : slug}`;
}

/** Deterministic paragraph-aware chunker. Overlap keeps citations meaningful across boundaries. */
export function chunkPages(pages: readonly ExtractedPage[], target = 1200, overlap = 150): Array<{ text: string; page: number | null; ordinal: number }> {
  const chunks: Array<{ text: string; page: number | null; ordinal: number }> = [];
  let ordinal = 0;
  for (const page of pages) {
    const paragraphs = page.text.split(/\n\s*\n/).map(p => p.replace(/[ \t]+/g, ' ').trim()).filter(p => p.length > 0);
    let buffer = '';
    const flush = () => {
      const text = buffer.trim();
      if (text.length >= 20) chunks.push({ text, page: page.page ?? null, ordinal: ordinal++ });
      buffer = overlap > 0 ? text.slice(Math.max(0, text.length - overlap)) : '';
    };
    for (const paragraph of paragraphs) {
      if ((buffer + '\n\n' + paragraph).trim().length > target && buffer.trim().length > 0) flush();
      buffer = buffer ? buffer + '\n\n' + paragraph : paragraph;
    }
    if (buffer.trim().length > 0) flush();
    buffer = '';
  }
  return chunks;
}

async function extractDocument(contentType: DocumentContentType, bytes: Uint8Array): Promise<ExtractedDocument> {
  if (contentType === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      const pages = (result.pages ?? []).map(p => ({ text: String(p.text ?? ''), page: p.num }));
      const totalText = String(result.text ?? '').trim();
      if (!totalText) throw new DomainError('INVALID_STATE', 'PDF contains no extractable text');
      if (!pages.length) return { pages: [{ text: result.text, page: 1 }] };
      return { pages };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = String(result.value ?? '').trim();
    if (!text) throw new DomainError('INVALID_STATE', 'DOCX contains no extractable text');
    return { pages: [{ text }] };
  }
  // Plain text family: decode UTF-8 strictly (fatal on invalid sequences) before accepting.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try { text = decoder.decode(bytes); } catch { throw new DomainError('INVALID_STATE', 'File is not valid UTF-8 text'); }
  if (text.includes('\u0000')) throw new DomainError('INVALID_STATE', 'File contains NUL bytes; it is not a text document');
  const printable = text.replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/g, '');
  if (printable.length / Math.max(1, text.length) < 0.9) throw new DomainError('INVALID_STATE', 'File does not look like a text document');
  return { pages: [{ text }] };
}

function sniffContentType(contentType: DocumentContentType, bytes: Uint8Array): boolean {
  if (contentType === 'application/pdf') return bytes.length > 5 && Buffer.from(bytes.slice(0, 5)).toString('latin1') === '%PDF-';
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    // DOCX is a ZIP container; require the local-file-header magic bytes.
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  return true; // text family validated during decode
}

const toIso = (value: Date | string | null): string | null => value === null ? null : (value instanceof Date ? value.toISOString() : String(value));

export class DocumentVaultService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly objects: DocumentObjectPort | undefined,
    private readonly embeddings?: EmbeddingProvider,
  ) {}

  private requireStorage(): DocumentObjectPort {
    if (!this.objects) throw new DomainError('NOT_CONFIGURED', 'Document storage is not configured on this deployment');
    return this.objects;
  }

  private async audit(workspaceId: string, documentId: string | null, userId: string | null, action: string, outcome: 'SUCCESS' | 'DENIED' | 'FAILED', reason?: string): Promise<void> {
    await this.store.db.insert(documentAuditEvents).values({ id: uuid(), workspaceId, documentId, userId, action, outcome, reason: reason ?? null });
  }

  private async getRow(actor: Principal, documentId: string) {
    const [row] = await this.store.db.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.workspaceId, actor.workspaceId), isNull(documents.deletedAt))).limit(1);
    if (!row) throw new DomainError('NOT_FOUND', 'Document not found');
    return row;
  }

  async beginUpload(actor: Principal, input: BeginUploadInput): Promise<{ documentId: string; uploadUrl: string; expiresInSeconds: number }> {
    const objects = this.requireStorage();
    const name = sanitizeName(input.name);
    const contentType = String(input.contentType);
    if (!(DOCUMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      await this.audit(actor.workspaceId, null, actor.userId, 'UPLOAD_STARTED', 'DENIED', 'content_type');
      throw new DomainError('UNSUPPORTED', 'Only PDF, DOCX and plain-text files (txt/markdown/csv) are supported');
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > DOCUMENT_MAX_BYTES) {
      await this.audit(actor.workspaceId, null, actor.userId, 'UPLOAD_STARTED', 'DENIED', 'size');
      throw new DomainError('INVALID_INPUT', 'File exceeds the 10 MB limit or has an invalid size');
    }
    const sha256 = String(input.sha256).toLowerCase();
    if (!isHex64(sha256)) throw new DomainError('INVALID_INPUT', 'sha256 must be 64 hex characters');
    const purpose = String(input.purpose ?? '').trim();
    if (purpose.length < 3 || purpose.length > 300) throw new DomainError('INVALID_INPUT', 'A short purpose statement is required (3-300 characters)');
    const retentionDays = input.retentionDays === undefined ? 365 : input.retentionDays;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new DomainError('INVALID_INPUT', 'Retention must be a whole number of days between 1 and 3650');

    const id = uuid();
    const key = storageKeyFor(actor.workspaceId, id, name);
    const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
    await this.store.db.insert(documents).values({
      id, workspaceId: actor.workspaceId, name, contentType, sizeBytes: input.sizeBytes, sha256, storageKey: key,
      state: 'PENDING_UPLOAD', purpose, uploadedBy: actor.userId, retentionDays, expiresAt,
    });
    const uploadUrl = await objects.signedPut(key, contentType, 600);
    await this.audit(actor.workspaceId, id, actor.userId, 'UPLOAD_STARTED', 'SUCCESS');
    return { documentId: id, uploadUrl, expiresInSeconds: 600 };
  }

  async completeUpload(actor: Principal, documentId: string): Promise<{ documentId: string; state: 'PROCESSING' }> {
    const objects = this.requireStorage();
    const row = await this.getRow(actor, documentId);
    if (row.state === 'AVAILABLE' || row.state === 'PROCESSING') return { documentId, state: 'PROCESSING' };
    if (row.state !== 'PENDING_UPLOAD') throw new DomainError('INVALID_STATE', 'Document is not awaiting an upload');

    const head = await objects.head(row.storageKey);
    if (!head) throw new DomainError('NOT_FOUND', 'The stored object is missing; upload the bytes before completing');
    const fail = async (reason: string) => {
      await this.store.db.update(documents).set({ state: 'FAILED', extractionCode: reason, updatedAt: new Date() }).where(and(eq(documents.id, row.id), eq(documents.workspaceId, actor.workspaceId)));
      await objects.deleteObject(row.storageKey).catch(() => undefined);
      await this.audit(actor.workspaceId, row.id, actor.userId, 'UPLOAD_VALIDATE', 'FAILED', reason);
      throw new DomainError('CONFLICT', 'Uploaded object failed validation (' + reason + '); it was discarded');
    };
    if (typeof head.size === 'number' && head.size !== row.sizeBytes) return fail('size_mismatch');
    if (head.sha256 && head.sha256.toLowerCase() !== row.sha256) return fail('sha256_mismatch');

    const bytes = await objects.read(row.storageKey);
    if (bytes.byteLength !== row.sizeBytes) return fail('size_mismatch');
    if (sha256Of(bytes) !== row.sha256) return fail('sha256_mismatch');
    if (!sniffContentType(row.contentType as DocumentContentType, bytes)) return fail('content_type_mismatch');

    await this.store.db.update(documents).set({ state: 'PROCESSING', updatedAt: new Date() }).where(eq(documents.id, row.id));
    await this.store.db.insert(documentIngestJobs).values({ id: uuid(), workspaceId: actor.workspaceId, documentId: row.id, state: 'PENDING' })
      .onConflictDoUpdate({ target: documentIngestJobs.documentId, set: { state: 'PENDING', attempts: 0, lastErrorCode: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() } });
    await this.audit(actor.workspaceId, row.id, actor.userId, 'UPLOAD_VALIDATE', 'SUCCESS');
    return { documentId, state: 'PROCESSING' };
  }

  /**
   * Background ingestion with durable processing leases (MISSION P11).
   *
   * Lifecycle of a document_ingest_jobs row:
   *   PENDING ──claim──▶ PROCESSING (lease_owner, fresh lease_token, lease_expires_at, attempts+1)
   *   PROCESSING ──finalize (one transaction)──▶ DONE      + document AVAILABLE with its chunks
   *   PROCESSING ──failure, attempts left──────▶ PENDING
   *   PROCESSING ──failure, attempts exhausted─▶ FAILED    + document FAILED
   *   PROCESSING with an EXPIRED lease (worker crashed / stalled) is abandoned:
   *     attempts left ⇒ re-claimed by the next drain (a new attempt, new token);
   *     attempts exhausted ⇒ FAILED with LEASE_EXPIRED, document FAILED.
   *
   * Single active owner: claims use FOR UPDATE SKIP LOCKED, and every later write is fenced by
   * (state = PROCESSING AND lease_token = <this claim's token>). A worker that lost its lease stops
   * without touching the job, the document or the chunks. Long phases renew the lease.
   *
   * No partial document: chunks (and optional embeddings) are computed in memory and written in the
   * SAME transaction that replaces any previous chunks, marks the document AVAILABLE and the job DONE.
   * A crash before commit leaves nothing visible; a retry replaces chunks idempotently.
   */
  async drainIngestPending(options: { workspaceId?: string; limit?: number; owner?: string } = {}): Promise<{ processed: number; failed: number }> {
    const objects = this.requireStorage();
    const limit = Math.max(1, Math.min(10, options.limit ?? 5));
    const owner = String(options.owner ?? this.ingestOwner).slice(0, 200);
    const leaseMs = ingestLeaseMs();
    let failed = await this.failExhaustedAbandonedJobs(leaseMs, options.workspaceId);
    const claimed = await this.claimIngestJobs(owner, leaseMs, limit, options.workspaceId);

    let processed = 0;
    for (const job of claimed) {
      try {
        const [row] = await this.store.db.select().from(documents).where(and(eq(documents.id, job.documentId), eq(documents.workspaceId, job.workspaceId), isNull(documents.deletedAt))).limit(1);
        if (!row) throw new IngestTerminalError('NOT_FOUND');
        if (row.state === 'AVAILABLE') {
          // A pre-lease worker committed the document but crashed before closing its job: close it as DONE.
          await this.store.db.update(documentIngestJobs).set({ state: 'DONE', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
            .where(and(eq(documentIngestJobs.id, job.jobId), eq(documentIngestJobs.state, 'PROCESSING'), eq(documentIngestJobs.leaseToken, job.token)));
          continue;
        }
        if (row.state !== 'PROCESSING') throw new IngestTerminalError('INVALID_STATE');
        const bytes = await objects.read(row.storageKey);
        await this.renewIngestLease(job, leaseMs);
        const extracted = await extractDocument(row.contentType as DocumentContentType, bytes);
        const chunks = chunkPages(extracted.pages);
        if (!chunks.length) throw new DomainError('INVALID_STATE', 'No substantial text could be extracted');
        await this.renewIngestLease(job, leaseMs);

        const chunkRows: Array<typeof documentChunks.$inferInsert> = chunks.map(chunk => ({
          id: uuid(), documentId: row.id, workspaceId: job.workspaceId,
          ordinal: chunk.ordinal, page: chunk.page, text: chunk.text,
        }));
        // Optional embeddings, computed before the write; absence of configuration never fails ingestion.
        let embeddingsFailed = false;
        if (this.embeddings) {
          try {
            for (let i = 0; i < chunkRows.length; i += 32) {
              const batch = chunkRows.slice(i, i + 32);
              const vectors = await this.embeddings.embed(batch.map(c => c.text));
              batch.forEach((c, j) => { c.embedding = vectors[j]; });
              await this.renewIngestLease(job, leaseMs);
            }
          } catch (error: unknown) {
            if (error instanceof IngestLeaseLostError) throw error;
            // Embeddings are best-effort; the FTS index remains authoritative. Recorded on the job.
            embeddingsFailed = true;
            for (const c of chunkRows) delete c.embedding;
          }
        }

        await this.store.db.transaction(async tx => {
          const [owned] = await tx.select({ id: documentIngestJobs.id }).from(documentIngestJobs)
            .where(and(eq(documentIngestJobs.id, job.jobId), eq(documentIngestJobs.state, 'PROCESSING'), eq(documentIngestJobs.leaseToken, job.token)))
            .for('update').limit(1);
          if (!owned) throw new IngestLeaseLostError();
          const [doc] = await tx.select({ id: documents.id }).from(documents)
            .where(and(eq(documents.id, row.id), eq(documents.workspaceId, job.workspaceId), eq(documents.state, 'PROCESSING'), isNull(documents.deletedAt)))
            .for('update').limit(1);
          if (!doc) throw new IngestTerminalError('NOT_FOUND');
          // Idempotent replacement: whatever an earlier attempt (or legacy code) left is replaced atomically.
          await tx.delete(documentChunks).where(eq(documentChunks.documentId, row.id));
          for (let i = 0; i < chunkRows.length; i += 100) await tx.insert(documentChunks).values(chunkRows.slice(i, i + 100));
          await tx.update(documents).set({ state: 'AVAILABLE', chunkCount: chunkRows.length, extractionCode: null, updatedAt: new Date() }).where(eq(documents.id, row.id));
          await tx.update(documentIngestJobs).set({
            state: 'DONE', lastErrorCode: embeddingsFailed ? 'EMBEDDINGS_FAILED' : null,
            leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(),
          }).where(eq(documentIngestJobs.id, job.jobId));
        });
        await this.audit(job.workspaceId, row.id, null, 'INGEST', 'SUCCESS');
        processed++;
      } catch (error: unknown) {
        // Lost the lease: another worker owns the job now (or it was reset). Write nothing.
        if (error instanceof IngestLeaseLostError) continue;
        const code = error instanceof IngestTerminalError ? error.code : error instanceof DomainError ? (error.context?.storageFailure ? 'STORAGE_' + storageFailureCode(error) : error.code) : 'INGEST_FAILED';
        const terminal = error instanceof IngestTerminalError || job.attempts >= INGEST_MAX_ATTEMPTS;
        const recorded = await this.store.db.transaction(async tx => {
          const [released] = await tx.update(documentIngestJobs)
            .set({ state: terminal ? 'FAILED' : 'PENDING', lastErrorCode: code, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
            .where(and(eq(documentIngestJobs.id, job.jobId), eq(documentIngestJobs.state, 'PROCESSING'), eq(documentIngestJobs.leaseToken, job.token)))
            .returning({ id: documentIngestJobs.id });
          if (!released) return false;
          if (terminal) {
            await tx.update(documents).set({ state: 'FAILED', extractionCode: code, chunkCount: 0, updatedAt: new Date() })
              .where(and(eq(documents.id, job.documentId), eq(documents.state, 'PROCESSING')));
            await tx.delete(documentChunks).where(and(eq(documentChunks.documentId, job.documentId), sql`NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ${job.documentId} AND d.state = 'AVAILABLE')`));
          }
          return true;
        });
        if (!recorded) continue;
        await this.audit(job.workspaceId, job.documentId, null, 'INGEST', 'FAILED', code);
        failed++;
      }
    }
    return { processed, failed };
  }

  /** Per-instance lease owner identity (diagnostic; ownership itself is proven by the lease token). */
  private readonly ingestOwner = hostname().slice(0, 100) + ':' + process.pid + ':' + randomUUID().slice(0, 8);

  /**
   * Claims up to `limit` jobs that are PENDING or abandoned (PROCESSING with an expired lease, or a
   * legacy lease-less PROCESSING row older than one lease). SKIP LOCKED: concurrent drains never claim
   * the same row; each claim gets a fresh fencing token and counts as an attempt.
   */
  private async claimIngestJobs(owner: string, leaseMs: number, limit: number, workspaceId?: string): Promise<Array<{ jobId: string; documentId: string; workspaceId: string; attempts: number; token: string }>> {
    const token = randomUUID();
    const executed = await this.store.db.execute(sql`
      UPDATE document_ingest_jobs AS j
      SET state = 'PROCESSING', attempts = j.attempts + 1,
          lease_owner = ${owner}, lease_token = ${token} || ':' || j.id,
          lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
          updated_at = now()
      WHERE j.id IN (
        SELECT c.id FROM document_ingest_jobs c
        WHERE (c.state = 'PENDING'
               OR (c.state = 'PROCESSING' AND c.attempts < ${INGEST_MAX_ATTEMPTS}
                   AND (c.lease_expires_at < now()
                        OR (c.lease_expires_at IS NULL AND c.updated_at < now() - make_interval(secs => ${leaseMs / 1000})))))
          ${workspaceId ? sql`AND c.workspace_id = ${workspaceId}` : sql``}
        ORDER BY c.updated_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.id, j.document_id, j.workspace_id, j.attempts, j.lease_token
    `);
    const rows = ((executed as unknown as { rows?: unknown[] }).rows ?? (executed as unknown as unknown[])) as Array<{ id: string; document_id: string; workspace_id: string; attempts: number; lease_token: string }>;
    return rows.map(row => ({ jobId: row.id, documentId: row.document_id, workspaceId: row.workspace_id, attempts: Number(row.attempts), token: row.lease_token }));
  }

  /**
   * Abandoned jobs whose attempts are exhausted fail terminally (LEASE_EXPIRED) instead of being
   * re-claimed forever: a document that crashes its worker every time ends FAILED, never stuck.
   */
  private async failExhaustedAbandonedJobs(leaseMs: number, workspaceId?: string): Promise<number> {
    const failedJobs = await this.store.db.transaction(async tx => {
      const executed = await tx.execute(sql`
        UPDATE document_ingest_jobs AS j
        SET state = 'FAILED', last_error_code = 'LEASE_EXPIRED',
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE j.id IN (
          SELECT c.id FROM document_ingest_jobs c
          WHERE c.state = 'PROCESSING' AND c.attempts >= ${INGEST_MAX_ATTEMPTS}
            AND (c.lease_expires_at < now()
                 OR (c.lease_expires_at IS NULL AND c.updated_at < now() - make_interval(secs => ${leaseMs / 1000})))
            ${workspaceId ? sql`AND c.workspace_id = ${workspaceId}` : sql``}
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        RETURNING j.document_id, j.workspace_id
      `);
      const rows = ((executed as unknown as { rows?: unknown[] }).rows ?? (executed as unknown as unknown[])) as Array<{ document_id: string; workspace_id: string }>;
      for (const row of rows) {
        await tx.update(documents).set({ state: 'FAILED', extractionCode: 'LEASE_EXPIRED', chunkCount: 0, updatedAt: new Date() })
          .where(and(eq(documents.id, row.document_id), eq(documents.state, 'PROCESSING')));
        await tx.delete(documentChunks).where(and(eq(documentChunks.documentId, row.document_id), sql`NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ${row.document_id} AND d.state = 'AVAILABLE')`));
      }
      return rows;
    });
    for (const row of failedJobs) await this.audit(row.workspace_id, row.document_id, null, 'INGEST', 'FAILED', 'LEASE_EXPIRED');
    return failedJobs.length;
  }

  /** Extends this claim's lease; throws IngestLeaseLostError when the claim is no longer ours. */
  private async renewIngestLease(job: { jobId: string; token: string }, leaseMs: number): Promise<void> {
    const [renewed] = await this.store.db.update(documentIngestJobs)
      .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`, updatedAt: new Date() })
      .where(and(eq(documentIngestJobs.id, job.jobId), eq(documentIngestJobs.state, 'PROCESSING'), eq(documentIngestJobs.leaseToken, job.token)))
      .returning({ id: documentIngestJobs.id });
    if (!renewed) throw new IngestLeaseLostError();
  }

  private toView = (row: typeof documents.$inferSelect, attachments = 0): DocumentView => ({
    id: row.id, name: row.name, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: row.sha256,
    state: row.state, extractionCode: row.extractionCode ?? null, purpose: row.purpose ?? null, uploadedBy: row.uploadedBy,
    retentionDays: row.retentionDays,
    expiresAt: toIso(row.expiresAt),
    expired: row.expiresAt ? new Date(row.expiresAt).getTime() <= Date.now() : false,
    chunkCount: row.chunkCount, createdAt: toIso(row.createdAt) ?? nowIso(), attachments,
  });

  private async attachmentCounts(workspaceId: string, documentIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!documentIds.length) return counts;
    const rows = await this.store.db.select({ documentId: operationDocuments.documentId, count: count() })
      .from(operationDocuments)
      .where(and(eq(operationDocuments.workspaceId, workspaceId), inArray(operationDocuments.documentId, [...documentIds])))
      .groupBy(operationDocuments.documentId);
    for (const row of rows) counts.set(row.documentId, Number(row.count));
    return counts;
  }

  async list(actor: Principal): Promise<DocumentView[]> {
    const rows = await this.store.db.select().from(documents)
      .where(and(eq(documents.workspaceId, actor.workspaceId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.createdAt)).limit(200);
    const attachments = await this.attachmentCounts(actor.workspaceId, rows.map(r => r.id));
    return rows.map(row => this.toView(row, attachments.get(row.id) ?? 0));
  }

  async get(actor: Principal, documentId: string): Promise<DocumentView> {
    const row = await this.getRow(actor, documentId);
    const attachments = await this.attachmentCounts(actor.workspaceId, [row.id]);
    return this.toView(row, attachments.get(row.id) ?? 0);
  }

  async signedDownload(actor: Principal, documentId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const objects = this.requireStorage();
    const row = await this.getRow(actor, documentId);
    if (row.state !== 'AVAILABLE') throw new DomainError('INVALID_STATE', 'Only processed documents can be downloaded');
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) throw new DomainError('DENIED', 'Document retention period has expired');
    return { url: await objects.signedRead(row.storageKey, 180), expiresInSeconds: 180 };
  }

  /** Tenant-scoped retrieval. FTS always; hybrid rerank only when a reviewed embedding provider is wired. */
  async search(actor: Principal, query: string, limit = 8): Promise<SearchResult> {
    await assertActiveWorkspaceMember(this.store.db,actor);
    const cleaned = String(query ?? '').trim();
    if (cleaned.length < 2 || cleaned.length > 300) throw new DomainError('INVALID_INPUT', 'Query must be between 2 and 300 characters');
    const capped = Math.max(1, Math.min(20, limit));
    const embeddingMode = this.embeddings ? 'CONFIGURED' : 'NOT_CONFIGURED';

    const executed = await this.store.db.execute(sql`
      SELECT c.id AS chunk_id, c.document_id, c.ordinal, c.page, c.text, d.name, d.sha256,
             ts_rank(c.search_vector, plainto_tsquery('simple', ${cleaned})) AS rank,
             ts_headline('simple', c.text, plainto_tsquery('simple', ${cleaned}), 'MaxFragments=1, MaxWords=28, MinWords=10') AS snippet
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = ${actor.workspaceId}
        AND d.workspace_id = ${actor.workspaceId}
        AND d.state = 'AVAILABLE'
        AND d.deleted_at IS NULL
        AND (d.expires_at IS NULL OR d.expires_at > now())
        AND c.search_vector @@ plainto_tsquery('simple', ${cleaned})
      ORDER BY rank DESC
      LIMIT 20
    `);
    const candidates: Array<{ chunk_id: string; document_id: string; ordinal: number; page: number | null; text: string; name: string; sha256: string; rank: number; snippet: string }> =
      (executed as unknown as { rows?: unknown[] }).rows as never ?? (executed as unknown as never[]);

    let mode: 'FTS' | 'HYBRID' = 'FTS';
    if (this.embeddings && candidates.length) {
      await assertActiveWorkspaceMember(this.store.db,actor);
      try {
        const [queryVector] = await this.embeddings.embed([cleaned]);
        // Load stored vectors in one query (small candidate pool by construction).
        const ids = candidates.map(c => c.chunk_id);
        const stored = await this.store.db.select({ id: documentChunks.id, embedding: documentChunks.embedding }).from(documentChunks).where(inArray(documentChunks.id, ids));
        const vectorById = new Map(stored.map(row => [row.id, row.embedding ?? undefined]));
        const reranked = candidates.map(candidate => {
          const vector = vectorById.get(candidate.chunk_id);
          const similarity = vector ? cosineSimilarity(queryVector!, vector) : 0;
          // 65% lexical rank + 35% semantic similarity, normalized to [0,1].
          const lexical = Math.min(1, Math.max(0, Number(candidate.rank)));
          const semantic = (similarity + 1) / 2;
          return { candidate, score: 0.65 * lexical + 0.35 * semantic };
        }).sort((a, b) => b.score - a.score);
        mode = 'HYBRID';
        return {
          query: cleaned, mode, embedding: embeddingMode,
          citations: reranked.slice(0, capped).map(({ candidate, score }) => this.toCitation(candidate, score, mode)),
        };
      } catch {
        // Embedding failure degrades to honest FTS-only results; never to fabricated matches.
        mode = 'FTS';
      }
    }

    return {
      query: cleaned, mode, embedding: embeddingMode,
      citations: candidates.slice(0, capped).map(candidate => this.toCitation(candidate, Math.min(1, Math.max(0, Number(candidate.rank))), mode)),
    };
  }

  private toCitation(candidate: { chunk_id: string; document_id: string; ordinal: number; page: number | null; name: string; sha256: string; snippet: string }, score: number, mode: 'FTS' | 'HYBRID'): Citation {
    return {
      citationId: candidate.chunk_id,
      documentId: candidate.document_id,
      chunkId: candidate.chunk_id,
      name: candidate.name,
      sha256: candidate.sha256,
      page: candidate.page ?? null,
      ordinal: candidate.ordinal,
      snippet: candidate.snippet,
      score: Number(score.toFixed(6)),
      mode,
    };
  }

  /**
   * P10 — passages for an agent step, from documents ATTACHED to this mission only.
   *
   * Isolation: the mission must belong to the actor's workspace; attachments, documents and chunks
   * are all filtered by that workspace and this operation. Eligibility: AVAILABLE, not deleted, not
   * expired, a recorded purpose (consent act) and an attaching member who still has ACTIVE access.
   * Everything else is returned in `withheld` with its reason. `withholdAll` (consent or profile not
   * granted) withholds every attached document without reading any chunk text.
   *
   * Ranking reuses the existing FTS (OR-query over `websearch_to_tsquery`) and the optional embedding
   * rerank. When nothing matches, the leading passages of each eligible document are used and the mode
   * says so. Text is bounded per passage and in total; nothing here touches object storage.
   */
  async missionPassages(
    actor: Principal,
    operationId: string,
    queryText: string,
    bounds: MissionPassageBounds,
    withholdAll?: Extract<WithheldDocumentReason, 'CONSENT_MISSING' | 'PROFILE_NOT_PERMITTED'>,
    beforeExternal?: ()=>Promise<void>,
  ): Promise<MissionPassageRetrieval> {
    await this.assertMission(actor, operationId);
    await assertActiveWorkspaceMember(this.store.db,actor);
    const currentConsents=await this.store.getConsents(actor.workspaceId,actor.userId);
    if(!currentConsents.some(permit=>isConsentActive(permit,new Date().toISOString())&&permit.scopes.includes('context:read')))withholdAll='CONSENT_MISSING';
    const attached = await this.attachedForAgent(actor, operationId);
    if (!attached.length) return { mode: 'NONE', passages: [], withheld: [], attachedCount: 0 };
    const withheld: Array<MissionPassageRetrieval['withheld'][number]> = [];
    const eligible: typeof attached = [];
    for (const entry of attached) {
      const reason = withholdAll ?? entry.ineligible;
      if (reason) withheld.push({ documentId: entry.id, name: entry.name, reason });
      else eligible.push(entry);
    }
    for (const entry of withheld) await this.audit(actor.workspaceId, entry.documentId, null, 'AGENT_RETRIEVAL', 'DENIED', entry.reason.toLowerCase());
    if (!eligible.length) return { mode: 'NONE', passages: [], withheld, attachedCount: attached.length };

    const ids = eligible.map(entry => entry.id);
    const maxPassages = Math.max(1, Math.min(12, Math.floor(bounds.maxPassages)));
    const cleaned = missionOrQuery(queryText);
    type Row = { chunk_id: string; document_id: string; ordinal: number; page: number | null; text: string; name: string; sha256: string; rank: number };
    let rows: Row[] = [];
    let mode: MissionPassageRetrieval['mode'] = 'FTS';
    if (cleaned.length >= 2) {
      const executed = await this.store.db.execute(sql`
        SELECT c.id AS chunk_id, c.document_id, c.ordinal, c.page, c.text, d.name, d.sha256,
               ts_rank(c.search_vector, websearch_to_tsquery('simple', ${cleaned})) AS rank
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        JOIN operation_documents od ON od.document_id = d.id
        WHERE c.workspace_id = ${actor.workspaceId}
          AND d.workspace_id = ${actor.workspaceId}
          AND od.workspace_id = ${actor.workspaceId}
          AND od.operation_id = ${operationId}
          AND d.id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
          AND d.state = 'AVAILABLE'
          AND d.deleted_at IS NULL
          AND (d.expires_at IS NULL OR d.expires_at > now())
          AND c.search_vector @@ websearch_to_tsquery('simple', ${cleaned})
        ORDER BY rank DESC, c.document_id, c.ordinal
        LIMIT ${maxPassages * 3}
      `);
      rows = ((executed as unknown as { rows?: unknown[] }).rows ?? (executed as unknown as unknown[])) as Row[];
      if (rows.length && this.embeddings) {
        await beforeExternal?.();
        const reranked = await this.rerank(String(queryText ?? '').trim().slice(0, 300), rows.map(row => ({ id: row.chunk_id, rank: Number(row.rank) })));
        if (reranked) {
          const byId = new Map(rows.map(row => [row.chunk_id, row] as const));
          rows = reranked.map(({ id, score }) => ({ ...byId.get(id)!, rank: score }));
          mode = 'HYBRID';
        }
      }
    }
    if (!rows.length) {
      // No lexical match: fall back to each eligible document's leading passages, labelled as such.
      const leading = await this.store.db.select({
        chunk_id: documentChunks.id, document_id: documentChunks.documentId, ordinal: documentChunks.ordinal,
        page: documentChunks.page, text: documentChunks.text,
      }).from(documentChunks)
        .where(and(eq(documentChunks.workspaceId, actor.workspaceId), inArray(documentChunks.documentId, ids), lt(documentChunks.ordinal, maxPassages)))
        .orderBy(documentChunks.ordinal, documentChunks.documentId)
        .limit(maxPassages);
      const meta = new Map(eligible.map(entry => [entry.id, entry] as const));
      rows = leading.map(row => ({ ...row, name: meta.get(row.document_id)!.name, sha256: meta.get(row.document_id)!.sha256, rank: 0 }));
      mode = rows.length ? 'LEADING' : 'NONE';
    }

    const maxPassageChars = Math.max(200, Math.min(4000, Math.floor(bounds.maxPassageChars)));
    let remaining = Math.max(maxPassageChars, Math.min(48_000, Math.floor(bounds.maxTotalChars)));
    const passages: MissionPassage[] = [];
    for (const row of rows) {
      if (passages.length >= maxPassages || remaining <= 0) break;
      const limit = Math.min(maxPassageChars, remaining);
      const full = String(row.text);
      const excerpt = full.length > limit ? full.slice(0, limit) : full;
      remaining -= excerpt.length;
      passages.push({
        documentId: row.document_id, chunkId: row.chunk_id, name: row.name, documentSha256: row.sha256,
        page: row.page ?? null, ordinal: Number(row.ordinal),
        excerpt, excerptSha256: createHash('sha256').update(excerpt).digest('hex'), truncated: excerpt.length < full.length,
        score: Number(Math.min(1, Math.max(0, Number(row.rank))).toFixed(6)),
      });
    }
    // A retrieval may await embeddings. Recheck the actual actor, original consent epoch and
    // attachment eligibility before handing any cached excerpts to a new inference boundary.
    await assertActiveWorkspaceMember(this.store.db,actor);
    const latestConsents=await this.store.getConsents(actor.workspaceId,actor.userId);
    const boundConsents=currentConsents.filter(permit=>isConsentActive(permit,new Date().toISOString())&&permit.scopes.includes('context:read'));
    if(!boundConsents.some(bound=>latestConsents.some(permit=>permit.id===bound.id&&permit.version===bound.version&&isConsentActive(permit,new Date().toISOString()))))throw new DomainError('DENIED','Document retrieval consent changed');
    const citable=await this.stillCitableChunks(actor,operationId,passages.map(passage=>passage.chunkId));
    if(passages.some(passage=>!citable.has(passage.chunkId)))throw new DomainError('DENIED','Document access changed during retrieval');
    for (const documentId of new Set(passages.map(passage => passage.documentId))) {
      await this.audit(actor.workspaceId, documentId, null, 'AGENT_RETRIEVAL', 'SUCCESS', mode.toLowerCase());
    }
    return { mode: passages.length ? mode : 'NONE', passages, withheld, attachedCount: attached.length };
  }

  /**
   * P10 — re-checks, after the agent ran, which handed-out chunks are STILL attached, AVAILABLE,
   * unexpired and attached by an ACTIVE member. A document deleted, detached or revoked during the
   * run is not cited.
   */
  async stillCitableChunks(actor: Principal, operationId: string, chunkIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (!chunkIds.length) return new Set();
    const eligibleDocs = new Set((await this.attachedForAgent(actor, operationId)).filter(entry => !entry.ineligible).map(entry => entry.id));
    if (!eligibleDocs.size) return new Set();
    const rows = await this.store.db.select({ id: documentChunks.id, documentId: documentChunks.documentId }).from(documentChunks)
      .where(and(eq(documentChunks.workspaceId, actor.workspaceId), inArray(documentChunks.id, [...chunkIds])));
    return new Set(rows.filter(row => eligibleDocs.has(row.documentId)).map(row => row.id));
  }

  private async attachedForAgent(actor: Principal, operationId: string): Promise<Array<{ id: string; name: string; sha256: string; ineligible: Exclude<WithheldDocumentReason, 'CONSENT_MISSING' | 'PROFILE_NOT_PERMITTED'> | null }>> {
    const rows = await this.store.db.select({ document: documents, attachedBy: operationDocuments.attachedBy })
      .from(operationDocuments)
      .innerJoin(documents, eq(documents.id, operationDocuments.documentId))
      .where(and(
        eq(operationDocuments.workspaceId, actor.workspaceId), eq(operationDocuments.operationId, operationId),
        eq(documents.workspaceId, actor.workspaceId), isNull(documents.deletedAt),
      ))
      .orderBy(operationDocuments.createdAt);
    if (!rows.length) return [];
    // The mission owner (the actor the worker runs as) and every attaching member must still hold
    // ACTIVE workspace access; a removed or suspended member's documents stop reaching agents.
    const attachers = [...new Set([...rows.map(row => row.attachedBy), actor.userId])];
    const active = new Set((await this.store.db.select({ userId: identityMemberships.userId }).from(identityMemberships)
      .where(and(eq(identityMemberships.workspaceId, actor.workspaceId), inArray(identityMemberships.userId, attachers), eq(identityMemberships.status, 'ACTIVE'))))
      .map(row => row.userId));
    const now = Date.now();
    return rows.map(({ document, attachedBy }) => ({
      id: document.id, name: document.name, sha256: document.sha256,
      ineligible: document.state !== 'AVAILABLE' ? 'NOT_AVAILABLE' as const
        : document.expiresAt && new Date(document.expiresAt).getTime() <= now ? 'EXPIRED' as const
        : !document.purpose?.trim() ? 'NO_CONSENT_RECORD' as const
        : !active.has(actor.userId) || !active.has(attachedBy) ? 'ACCESS_REVOKED' as const
        : null,
    }));
  }

  /** Optional semantic rerank over an FTS candidate pool. Null when unconfigured or on any failure. */
  private async rerank(query: string, candidates: readonly { id: string; rank: number }[]): Promise<Array<{ id: string; score: number }> | null> {
    if (!this.embeddings || !candidates.length) return null;
    try {
      const [queryVector] = await this.embeddings.embed([query]);
      const stored = await this.store.db.select({ id: documentChunks.id, embedding: documentChunks.embedding }).from(documentChunks).where(inArray(documentChunks.id, candidates.map(c => c.id)));
      const vectorById = new Map(stored.map(row => [row.id, row.embedding ?? undefined]));
      return candidates.map(candidate => {
        const vector = vectorById.get(candidate.id);
        const similarity = vector ? cosineSimilarity(queryVector!, vector) : 0;
        // Same weighting as search(): 65% lexical rank + 35% semantic similarity, normalized to [0,1].
        const lexical = Math.min(1, Math.max(0, Number(candidate.rank)));
        return { id: candidate.id, score: 0.65 * lexical + 0.35 * ((similarity + 1) / 2) };
      }).sort((a, b) => b.score - a.score);
    } catch {
      // Embedding failure degrades to honest FTS-only ranking; never to fabricated matches.
      return null;
    }
  }

  async attach(actor: Principal, documentId: string, operationId: string): Promise<void> {
    const row = await this.getRow(actor, documentId);
    if (row.state !== 'AVAILABLE') throw new DomainError('INVALID_STATE', 'Only processed documents can be attached to a mission');
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) throw new DomainError('DENIED', 'Document retention period has expired');
    await this.assertMission(actor, operationId);
    await this.store.db.insert(operationDocuments).values({ id: uuid(), workspaceId: actor.workspaceId, operationId, documentId, attachedBy: actor.userId }).onConflictDoNothing();
    await this.audit(actor.workspaceId, documentId, actor.userId, 'ATTACH', 'SUCCESS');
  }

  async detach(actor: Principal, documentId: string, operationId: string): Promise<void> {
    await this.assertMission(actor, operationId);
    await this.store.db.delete(operationDocuments).where(and(eq(operationDocuments.workspaceId, actor.workspaceId), eq(operationDocuments.operationId, operationId), eq(operationDocuments.documentId, documentId)));
    await this.audit(actor.workspaceId, documentId, actor.userId, 'DETACH', 'SUCCESS');
  }

  private async assertMission(actor: Principal, operationId: string): Promise<void> {
    const [row] = await this.store.db.select().from(operations).where(and(eq(operations.id, operationId), eq(operations.workspaceId, actor.workspaceId))).limit(1);
    if (!row) throw new DomainError('NOT_FOUND', 'Mission not found');
  }

  async attachedDocuments(actor: Principal, operationId: string): Promise<DocumentView[]> {
    await this.assertMission(actor, operationId);
    const rows = await this.store.db.select({ document: documents })
      .from(operationDocuments)
      .innerJoin(documents, eq(documents.id, operationDocuments.documentId))
      .where(and(eq(operationDocuments.workspaceId, actor.workspaceId), eq(operationDocuments.operationId, operationId), isNull(documents.deletedAt)))
      .orderBy(desc(operationDocuments.createdAt));
    const attachments = await this.attachmentCounts(actor.workspaceId, rows.map(r => r.document.id));
    return rows.map(row => this.toView(row.document, attachments.get(row.document.id) ?? 0));
  }

  /**
   * P12 — delete a document. Access is revoked IMMEDIATELY and atomically: one transaction removes the
   * document row (cascading chunks, mission attachments and ingest jobs, so it can no longer be listed,
   * searched, downloaded, attached or put in an agent context) and persists a durable storage-deletion
   * intent. The object is then deleted and verified absent; if that fails or is ambiguous the intent
   * stays PENDING and is retried by drainStorageDeletions. `storage` reports what actually happened.
   */
  async delete(actor: Principal, documentId: string): Promise<{ storage: StorageDeletionOutcome }> {
    const intent = await this.revokeAndQueueDeletion(actor.workspaceId, documentId, 'USER_DELETE', actor.userId);
    if (!intent) throw new DomainError('NOT_FOUND', 'Document not found');
    await this.audit(actor.workspaceId, documentId, actor.userId, 'DELETE', 'SUCCESS', 'access_revoked');
    const storage = await this.attemptStorageDeletionNow(intent);
    return { storage };
  }

  /**
   * Retention enforcement through the same mechanism: every expired, not-yet-deleted document (any
   * state) is revoked and queued; storage deletion is attempted and otherwise retried. `deleted`
   * counts revoked documents, not storage outcomes (those are on the intent and in the audit log).
   */
  async purgeExpired(options: { limit?: number } = {}): Promise<{ deleted: number }> {
    const limit = Math.max(1, Math.min(50, options.limit ?? 20));
    const expired = await this.store.db.select({ id: documents.id, workspaceId: documents.workspaceId }).from(documents)
      .where(and(isNull(documents.deletedAt), lt(documents.expiresAt, new Date())))
      .orderBy(documents.expiresAt)
      .limit(limit);
    let deleted = 0;
    for (const row of expired) {
      const intent = await this.revokeAndQueueDeletion(row.workspaceId, row.id, 'RETENTION_EXPIRED', null);
      if (!intent) continue; // deleted concurrently by its owner or another sweep
      await this.audit(row.workspaceId, row.id, null, 'EXPIRED_PURGE', 'SUCCESS', 'access_revoked');
      await this.attemptStorageDeletionNow(intent);
      deleted++;
    }
    return { deleted };
  }

  /**
   * Retries due storage-deletion intents (worker sweep). Each claim is lease-protected (SKIP LOCKED +
   * fencing token), so concurrent sweeps never act on the same intent and a crashed sweep's claim is
   * picked up again after its lease expires. DELETED is recorded only once `head` confirms absence.
   */
  async drainStorageDeletions(options: { limit?: number } = {}): Promise<{ deleted: number; retrying: number; failed: number }> {
    const objects = this.requireStorage();
    const limit = Math.max(1, Math.min(50, options.limit ?? 10));
    const claimed = await this.claimStorageDeletions(limit);
    const totals = { deleted: 0, retrying: 0, failed: 0 };
    for (const intent of claimed) {
      const outcome = await this.executeStorageDeletion(objects, intent);
      if (outcome === 'DELETED') totals.deleted++;
      else if (outcome === 'FAILED') totals.failed++;
      else if (outcome === 'PENDING') totals.retrying++;
    }
    return totals;
  }

  /** Read-only status of a deletion intent in the actor's workspace (null when none exists). */
  async storageDeletionStatus(actor: Principal, documentId: string): Promise<{ state: StorageDeletionState; attempts: number; lastErrorCode: string | null; completedAt: string | null } | null> {
    const [row] = await this.store.db.select().from(documentStorageDeletions)
      .where(and(eq(documentStorageDeletions.workspaceId, actor.workspaceId), eq(documentStorageDeletions.documentId, documentId))).limit(1);
    return row ? { state: row.state, attempts: row.attempts, lastErrorCode: row.lastErrorCode ?? null, completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null } : null;
  }

  /**
   * One transaction: lock the live document in its workspace, persist the intent with the metadata
   * cleanup needs, then delete the row (FK cascades remove chunks, attachments and ingest jobs).
   * Returns null when the document does not exist (or is already deleted) in that workspace.
   */
  private async revokeAndQueueDeletion(workspaceId: string, documentId: string, reason: StorageDeletionReason, requestedBy: string | null): Promise<ClaimedStorageDeletion | null> {
    return this.store.db.transaction(async tx => {
      const [row] = await tx.select().from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)))
        .for('update').limit(1);
      if (!row) return null;
      // A presigned PUT issued for a PENDING_UPLOAD document stays usable for up to 10 minutes, so its
      // object could land after an immediate delete: wait until every such URL has expired.
      const notBefore = row.state === 'PENDING_UPLOAD' ? new Date(Date.now() + UPLOAD_URL_GRACE_MS) : new Date();
      const id = uuid();
      await tx.insert(documentStorageDeletions).values({
        id, workspaceId, documentId: row.id, storageKey: row.storageKey, sha256: row.sha256, sizeBytes: row.sizeBytes,
        contentType: row.contentType, documentState: row.state, reason, requestedBy, state: 'PENDING', notBefore,
      });
      await tx.delete(documents).where(and(eq(documents.id, row.id), eq(documents.workspaceId, workspaceId)));
      return { id, workspaceId, documentId: row.id, storageKey: row.storageKey, attempts: 0, token: '', notBefore };
    });
  }

  /** Immediate best-effort attempt after revocation; never reports DELETED unless verified. */
  private async attemptStorageDeletionNow(intent: ClaimedStorageDeletion): Promise<StorageDeletionOutcome> {
    if (!this.objects || intent.notBefore.getTime() > Date.now()) return 'PENDING';
    const [claimed] = await this.claimStorageDeletions(1, intent.id);
    if (!claimed) return 'PENDING';
    const outcome = await this.executeStorageDeletion(this.objects, claimed);
    return outcome === 'DELETED' ? 'DELETED' : 'PENDING';
  }

  private async claimStorageDeletions(limit: number, onlyId?: string): Promise<ClaimedStorageDeletion[]> {
    const token = randomUUID();
    const executed = await this.store.db.execute(sql`
      UPDATE document_storage_deletions AS d
      SET attempts = d.attempts + 1, lease_token = ${token} || ':' || d.id,
          lease_expires_at = now() + make_interval(secs => ${STORAGE_DELETION_LEASE_MS / 1000}), updated_at = now()
      WHERE d.id IN (
        SELECT c.id FROM document_storage_deletions c
        WHERE c.state = 'PENDING' AND c.not_before <= now()
          AND (c.lease_expires_at IS NULL OR c.lease_expires_at < now())
          ${onlyId ? sql`AND c.id = ${onlyId}` : sql``}
        ORDER BY c.not_before
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.workspace_id, d.document_id, d.storage_key, d.attempts, d.lease_token, d.not_before
    `);
    const rows = ((executed as unknown as { rows?: unknown[] }).rows ?? (executed as unknown as unknown[])) as Array<{ id: string; workspace_id: string; document_id: string; storage_key: string; attempts: number; lease_token: string; not_before: string | Date }>;
    return rows.map(row => ({ id: row.id, workspaceId: row.workspace_id, documentId: row.document_id, storageKey: row.storage_key, attempts: Number(row.attempts), token: row.lease_token, notBefore: new Date(row.not_before) }));
  }

  /**
   * Delete, then verify absence with `head`. Outcomes:
   *   head reports absent             ⇒ DELETED (completed_at set)
   *   delete threw                    ⇒ retry (DELETE_FAILED)
   *   head threw                      ⇒ retry (VERIFY_FAILED — ambiguous, never assumed deleted)
   *   object still present after delete ⇒ retry (STILL_PRESENT)
   * Retries back off exponentially; after STORAGE_DELETION_MAX_ATTEMPTS the intent is FAILED (the
   * object may still exist; operator attention required). All writes are fenced by the lease token.
   */
  private async executeStorageDeletion(objects: DocumentObjectPort, intent: ClaimedStorageDeletion): Promise<StorageDeletionState | 'LEASE_LOST'> {
    let errorCode: string | null = null;
    try {
      await objects.deleteObject(intent.storageKey);
    } catch (error: unknown) {
      errorCode = 'DELETE_FAILED' + storageErrorSuffix(error);
    }
    if (!errorCode) {
      try {
        if (await objects.head(intent.storageKey)) errorCode = 'STILL_PRESENT';
      } catch (error: unknown) {
        errorCode = 'VERIFY_FAILED' + storageErrorSuffix(error);
      }
    }
    const fenced = and(eq(documentStorageDeletions.id, intent.id), eq(documentStorageDeletions.state, 'PENDING'), eq(documentStorageDeletions.leaseToken, intent.token));
    let next: StorageDeletionState;
    if (!errorCode) {
      next = 'DELETED';
      const [done] = await this.store.db.update(documentStorageDeletions)
        .set({ state: 'DELETED', lastErrorCode: null, leaseToken: null, leaseExpiresAt: null, completedAt: new Date(), updatedAt: new Date() })
        .where(fenced).returning({ id: documentStorageDeletions.id });
      if (!done) return 'LEASE_LOST';
    } else {
      const terminal = intent.attempts >= STORAGE_DELETION_MAX_ATTEMPTS;
      next = terminal ? 'FAILED' : 'PENDING';
      const backoffMs = Math.min(STORAGE_DELETION_MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, intent.attempts - 1));
      const [recorded] = await this.store.db.update(documentStorageDeletions)
        .set({ state: next, lastErrorCode: errorCode, leaseToken: null, leaseExpiresAt: null, notBefore: new Date(Date.now() + backoffMs), updatedAt: new Date() })
        .where(fenced).returning({ id: documentStorageDeletions.id });
      if (!recorded) return 'LEASE_LOST';
    }
    // Audit is best-effort here: the intent row is the durable, truthful record (and the workspace — the
    // audit table's FK parent — may itself have been deleted since).
    await this.audit(intent.workspaceId, intent.documentId, null, 'STORAGE_DELETE', next === 'DELETED' ? 'SUCCESS' : 'FAILED',
      next === 'DELETED' ? 'verified_absent' : (next === 'FAILED' ? 'attempts_exhausted:' : 'will_retry:') + errorCode).catch(() => undefined);
    return next;
  }
}

/** Terms too common to rank mission passages (the FTS configuration is 'simple', without stop words). */
const MISSION_QUERY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'into', 'about', 'your', 'our', 'their',
  'les', 'des', 'une', 'pour', 'dans', 'avec', 'sur', 'par', 'est', 'aux', 'qui', 'que', 'ses', 'leur', 'nos', 'vos',
]);

/**
 * P10 — the mission/step text as an OR query for websearch_to_tsquery: letters and digits only (no
 * operators can be injected), stop words removed, at most 24 distinct terms. Empty when nothing is left.
 */
export function missionOrQuery(text: string): string {
  const terms: string[] = [];
  for (const raw of String(text ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || raw.length > 40 || raw === 'or' || MISSION_QUERY_STOP_WORDS.has(raw) || terms.includes(raw)) continue;
    terms.push(raw);
    if (terms.length >= 24) break;
  }
  return terms.join(' or ');
}
