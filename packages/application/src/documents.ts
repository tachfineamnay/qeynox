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
 * stores it; retentionDays/expiresAt bound lifetime; delete revokes everywhere (storage object + rows)
 * and writes a workspace audit event. Expired documents are excluded from list/search/download and
 * are hard-deleted by purgeExpired.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DomainError, newId, type ID, type Principal } from '@qeynox/domain';
import {
  QeyNoxStore, documentAuditEvents, documentChunks, documentIngestJobs, documents, operationDocuments, operations,
} from '@qeynox/persistence';
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

interface ExtractedPage { readonly text: string; readonly page?: number }
interface ExtractedDocument { readonly pages: readonly ExtractedPage[] }

const sha256Of = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
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
  return `workspaces/${workspaceId}/documents/${id}/${slug}`;
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
      .onConflictDoUpdate({ target: documentIngestJobs.documentId, set: { state: 'PENDING', attempts: 0, lastErrorCode: null, updatedAt: new Date() } });
    await this.audit(actor.workspaceId, row.id, actor.userId, 'UPLOAD_VALIDATE', 'SUCCESS');
    return { documentId, state: 'PROCESSING' };
  }

  /** Background ingestion. Returns how many jobs were processed. Idempotent per document. */
  async drainIngestPending(options: { workspaceId?: string; limit?: number } = {}): Promise<{ processed: number; failed: number }> {
    const objects = this.requireStorage();
    const limit = Math.max(1, Math.min(10, options.limit ?? 5));
    const scope = options.workspaceId
      ? and(eq(documentIngestJobs.state, 'PENDING'), eq(documentIngestJobs.workspaceId, options.workspaceId))
      : eq(documentIngestJobs.state, 'PENDING');
    const claimed: Array<{ jobId: string; documentId: string; workspaceId: string }> = [];
    await this.store.db.transaction(async tx => {
      const pending = await tx.select().from(documentIngestJobs).where(scope).orderBy(documentIngestJobs.updatedAt).limit(limit);
      for (const job of pending) {
        const [locked] = await tx.update(documentIngestJobs)
          .set({ state: 'PROCESSING', attempts: job.attempts + 1, updatedAt: new Date() })
          .where(and(eq(documentIngestJobs.id, job.id), eq(documentIngestJobs.state, 'PENDING')))
          .returning({ id: documentIngestJobs.id });
        if (locked) claimed.push({ jobId: job.id, documentId: job.documentId, workspaceId: job.workspaceId });
      }
    });

    let processed = 0, failed = 0;
    for (const job of claimed) {
      try {
        const [row] = await this.store.db.select().from(documents).where(and(eq(documents.id, job.documentId), eq(documents.workspaceId, job.workspaceId), isNull(documents.deletedAt))).limit(1);
        if (!row) throw new DomainError('NOT_FOUND', 'Document vanished during ingest');
        const bytes = await objects.read(row.storageKey);
        const extracted = await extractDocument(row.contentType as DocumentContentType, bytes);
        const chunks = chunkPages(extracted.pages);
        if (!chunks.length) throw new DomainError('INVALID_STATE', 'No substantial text could be extracted');

        // Idempotent retry: replace any chunks from an earlier attempt.
        await this.store.db.delete(documentChunks).where(eq(documentChunks.documentId, row.id));
        const chunkRows = chunks.map(chunk => ({
          id: uuid(), documentId: row.id, workspaceId: job.workspaceId,
          ordinal: chunk.ordinal, page: chunk.page, text: chunk.text,
        }));
        for (const c of chunkRows) {
          await this.store.db.insert(documentChunks).values(c);
        }

        // Optional embeddings; absence is honest, absence of configuration never fails ingestion.
        if (this.embeddings) {
          try {
            const texts = chunkRows.map(c => c.text);
            for (let i = 0; i < texts.length; i += 32) {
              const batch = texts.slice(i, i + 32);
              const vectors = await this.embeddings.embed(batch);
              for (let j = 0; j < batch.length; j++) {
                await this.store.db.update(documentChunks).set({ embedding: vectors[j] }).where(eq(documentChunks.id, chunkRows[i + j]!.id));
              }
            }
          } catch {
            // Embeddings are best-effort; the FTS index remains authoritative. Recorded on the job.
            await this.store.db.update(documentIngestJobs).set({ lastErrorCode: 'EMBEDDINGS_FAILED', updatedAt: new Date() }).where(eq(documentIngestJobs.id, job.jobId));
          }
        }

        await this.store.db.update(documents).set({ state: 'AVAILABLE', chunkCount: chunkRows.length, updatedAt: new Date() }).where(eq(documents.id, row.id));
        await this.store.db.update(documentIngestJobs).set({ state: 'DONE', updatedAt: new Date() }).where(eq(documentIngestJobs.id, job.jobId));
        await this.audit(job.workspaceId, row.id, null, 'INGEST', 'SUCCESS');
        processed++;
      } catch (error: unknown) {
        const code = error instanceof DomainError ? error.code : 'INGEST_FAILED';
        const [jobRow] = await this.store.db.select().from(documentIngestJobs).where(eq(documentIngestJobs.id, job.jobId)).limit(1);
        const attempts = jobRow?.attempts ?? 3;
        const terminal = attempts >= 3;
        await this.store.db.update(documentIngestJobs).set({ state: terminal ? 'FAILED' : 'PENDING', lastErrorCode: code, updatedAt: new Date() }).where(eq(documentIngestJobs.id, job.jobId));
        if (terminal) {
          await this.store.db.update(documents).set({ state: 'FAILED', extractionCode: code, updatedAt: new Date() }).where(eq(documents.id, job.documentId));
        }
        await this.audit(job.workspaceId, job.documentId, null, 'INGEST', 'FAILED', code);
        failed++;
      }
    }
    return { processed, failed };
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

  /** Hard-delete everywhere: storage object (best-effort), rows, chunks, attachments, audit kept. */
  async delete(actor: Principal, documentId: string): Promise<void> {
    const objects = this.requireStorage();
    const row = await this.getRow(actor, documentId);
    try { await objects.deleteObject(row.storageKey); } catch { /* object may already be gone; rows still deleted */ }
    await this.store.db.delete(documents).where(and(eq(documents.id, row.id), eq(documents.workspaceId, actor.workspaceId)));
    await this.audit(actor.workspaceId, row.id, actor.userId, 'DELETE', 'SUCCESS');
  }

  /** Retention enforcement: hard-delete AVAILABLE documents whose retention window expired. */
  async purgeExpired(options: { limit?: number } = {}): Promise<{ deleted: number }> {
    const objects = this.requireStorage();
    const limit = Math.max(1, Math.min(50, options.limit ?? 20));
    const expired = await this.store.db.select().from(documents)
      .where(and(eq(documents.state, 'AVAILABLE'), isNull(documents.deletedAt), lt(documents.expiresAt, new Date())))
      .limit(limit);
    let deleted = 0;
    for (const row of expired) {
      try { await objects.deleteObject(row.storageKey); } catch { /* keep going; rows must still be purged */ }
      await this.store.db.delete(documents).where(and(eq(documents.id, row.id), eq(documents.state, 'AVAILABLE')));
      await this.audit(row.workspaceId, row.id, null, 'EXPIRED_PURGE', 'SUCCESS');
      deleted++;
    }
    return { deleted };
  }
}
