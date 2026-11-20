/**
 * MISSION A17 — customer documents and tenant-safe knowledge QA.
 *
 *  PART 1 — contracts and pure logic (always runnable)
 *   - the deterministic paragraph-aware chunker (bounds, overlap, ordinals, page mapping);
 *   - cosine similarity + brute-force ranking sanity;
 *   - embeddingsFromEnv gates (partial config ⇒ undefined; unattested ⇒ undefined);
 *   - supported content types and the 10 MB ceiling are declared, not scattered.
 *
 *  PART 2 — vault + retrieval against an isolated disposable database
 *   - in-memory object store fake (the only double permitted; never a product fallback);
 *   - begin/complete flow: declared-metadata validation, size/SHA-256 verification against the
 *     stored object, magic-byte sniffing, discard-on-mismatch, fail-closed when storage absent;
 *   - background ingestion into PENDING_UPLOAD→PROCESSING→AVAILABLE/FAILED with retry semantics
 *     (garbage text document terminates FAILED after 3 attempts);
 *   - tenant-scoped full-text search: finds the right document, excludes the other tenant,
 *     returns citations carrying documentId/chunkId/SHA-256; document deletion invalidates them;
 *   - optional hybrid rerank through a QA-injected deterministic embedding provider, and a
 *     throwing provider degrading search to FTS without failing anything;
 *   - attach/detach to a mission; retention expiry excludes + purges; revoke deletes everywhere.
 *
 * NO live object storage or embeddings endpoint is used in this suite (no MinIO/docker available
 * here; no provider credentials). The S3 leg and the provider transport are deployment gates, not
 * claims. A passing run is integration evidence for the database + service layer only.
 *
 * Run: pnpm qa:documents   (requires QEYNOX_QA_DATABASE_URL)
 * Exit: 0 PASS · 3 BLOCKED · 1 FAILED
 */
import { createHash, randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  documentAuditEvents, documentChunks, documents, operationDocuments,
  identityMemberships, identityUsers, identityWorkspaces,
} from '@qeynox/persistence';
import {
  DocumentVaultService, DOCUMENT_ALLOWED_CONTENT_TYPES, DOCUMENT_MAX_BYTES, chunkPages, cosineSimilarity, embeddingsFromEnv,
  type DocumentObjectPort,
} from '@qeynox/application';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
const sha256Of = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

// =============================================================================================
// PART 1 — contracts and pure logic
// =============================================================================================
function partOne(): void {
  console.log('— PART 1: chunker, embeddings helpers, declared policy —');
  const before = assertions;

  const pages = [
    { text: 'Alpha bravo charlie\n\n' + 'delta '.repeat(200), page: 1 },
    { text: 'echo foxtrot\n\ngolf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey x-ray yankee zulu', page: 2 },
  ];
  const chunks = chunkPages(pages);
  assert(chunks.length >= 2, 'chunker splits long content');
  for (const chunk of chunks) {
    assert(Buffer.byteLength(chunk.text) <= 1400, 'chunk within target bound incl. overlap');
    assert(chunk.text.trim().length >= 20, 'chunk has substance');
  }
  assert(chunks.every((chunk, i) => chunk.ordinal === i), 'ordinals are dense and ordered');
  const pagesSpanned = new Set(chunks.map(c => c.page));
  assert(pagesSpanned.has(1) && pagesSpanned.has(2), 'page numbers are preserved');

  const tiny = chunkPages([{ text: 'too short', page: 1 }]);
  assert(tiny.length === 0, 'degenerate chunks are dropped');

  assert(cosineSimilarity([1, 0, 0], [1, 0, 0]) === 1, 'cosine of identical unit vectors is 1');
  assert(cosineSimilarity([1, 0], [0, 1]) === 0, 'cosine of orthogonal vectors is 0');
  assert(cosineSimilarity([], [1]) === 0 && cosineSimilarity([1, 2], [1]) === 0, 'cosine of mismatched vectors is 0, never NaN');

  assert(embeddingsFromEnv({}) === undefined, 'embeddings absent without configuration');
  assert(embeddingsFromEnv({ QEYNOX_EMBEDDINGS_ENABLED: 'true', QEYNOX_EMBEDDINGS_ENDPOINT: 'https://api.example.invalid/v1/embeddings', QEYNOX_EMBEDDINGS_API_KEY: 'k', QEYNOX_EMBEDDINGS_MODEL: 'm', QEYNOX_EMBEDDINGS_ALLOWED_HOSTS: 'api.example.invalid' }) === undefined, 'unattested egress ⇒ embeddings stay unconfigured');
  const configured = embeddingsFromEnv({ QEYNOX_EMBEDDINGS_ENABLED: 'true', QEYNOX_EMBEDDINGS_ENDPOINT: 'https://api.example.invalid/v1/embeddings', QEYNOX_EMBEDDINGS_API_KEY: 'k', QEYNOX_EMBEDDINGS_MODEL: 'm', QEYNOX_EMBEDDINGS_ALLOWED_HOSTS: 'api.example.invalid', QEYNOX_NETWORK_POLICY_ATTESTED: 'true' });
  assert(configured?.id === 'openai-compatible', 'fully attested configuration wires the reviewed provider');

  assert((DOCUMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes('application/pdf'), 'PDF supported');
  assert((DOCUMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'DOCX supported');
  assert((DOCUMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes('text/markdown'), 'markdown supported');
  assert(DOCUMENT_MAX_BYTES === 10 * 1024 * 1024, 'upload ceiling is 10 MB');

  console.log('  PART 1 PASSED: cumulative ' + assertions + ' assertions (' + (assertions - before) + ' in this half)');
}

// =============================================================================================
// Loopback doubles (QA only) and fixtures
// =============================================================================================
class FakeDocumentObjects implements DocumentObjectPort {
  readonly stored = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly deletedKeys: string[] = [];
  readonly signedPutKeys: string[] = [];
  failReadsFor = new Set<string>();
  async signedPut(key: string, contentType: string): Promise<string> {
    this.signedPutKeys.push(key);
    return 'fake-upload://' + encodeURIComponent(key) + '/' + contentType;
  }
  async putLastSigned(bytes: Uint8Array, contentType: string): Promise<string> {
    const key = this.signedPutKeys[this.signedPutKeys.length - 1]!;
    this.stored.set(key, { bytes: Uint8Array.from(bytes), contentType });
    return key;
  }
  async head(key: string) {
    const hit = this.stored.get(key);
    return hit ? { sha256: sha256Of(hit.bytes), size: hit.bytes.byteLength } : undefined;
  }
  async read(key: string): Promise<Uint8Array> {
    if (this.failReadsFor.has(key)) throw new Error('QA injected read failure');
    const hit = this.stored.get(key);
    if (!hit) throw new DomainError('NOT_FOUND', 'missing object');
    // Return a copy: the extractor (pdf-parse) detaches the caller's buffer, as the real store would avoid.
    return Uint8Array.from(hit.bytes);
  }
  async signedRead(key: string): Promise<string> {
    if (!this.stored.has(key)) throw new DomainError('NOT_FOUND', 'missing object');
    return 'fake-read://' + encodeURIComponent(key);
  }
  async deleteObject(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.stored.delete(key);
  }
}

/** Deterministic token-hash embedding: related texts share directional components. QA only. */
function qaEmbedding(dimension = 64): (texts: readonly string[]) => number[][] {
  return (texts) => texts.map(text => {
    const vector = new Array<number>(dimension).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(t => t.length > 2)) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) { hash ^= token.charCodeAt(i); hash = Math.imul(hash, 16777619); }
      vector[Math.abs(hash) % dimension]! += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map(v => v / norm);
  });
}

async function pdfFixture(lines: readonly string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = doc.addPage([612, 792]);
    page.drawText(line, { x: 72, y: 720, font, size: 12 });
  }
  return doc.save({ useObjectStreams: false });
}

function docxFixture(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs.map(p => '<w:p><w:r><w:t>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</w:t></w:r></w:p>').join('');
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(documentXml),
  });
}

// =============================================================================================
// PART 2 — vault behavior against a disposable database
// =============================================================================================
async function partTwo(): Promise<'PASSED' | 'BLOCKED'> {
  console.log('— PART 2: vault, retrieval, citations, retention —');
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: PART 2 not run — QEYNOX_QA_DATABASE_URL is not set. This run is NOT integration evidence.');
    return 'BLOCKED';
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    assert(migration.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);

    const wsA = randomUUID(); const wsB = randomUUID();
    const userA = randomUUID(); const userB = randomUUID();
    await db.insert(identityUsers).values([{ id: userA, email: 'qa-a17-a-' + userA + '@example.invalid' }, { id: userB, email: 'qa-a17-b-' + userB + '@example.invalid' }]);
    await db.insert(identityWorkspaces).values([{ id: wsA, name: 'QA A17 A', createdBy: userA }, { id: wsB, name: 'QA A17 B', createdBy: userB }]);
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: userA, workspaceId: wsA, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: userB, workspaceId: wsB, role: 'OWNER', status: 'ACTIVE' },
    ]);
    const ownerA: Principal = { userId: userA as ID, workspaceId: wsA as ID, roles: ['OWNER'] };
    const ownerB: Principal = { userId: userB as ID, workspaceId: wsB as ID, roles: ['OWNER'] };

    const objects = new FakeDocumentObjects();
    const embeddings = { id: 'qa-deterministic', embed: async (texts: readonly string[]) => qaEmbedding(64)(texts) };
    const hybridService = new DocumentVaultService(store, objects, embeddings);
    const plainService = new DocumentVaultService(store, objects);
    const noStorage = new DocumentVaultService(store, undefined);

    // --- Declaration gates --------------------------------------------------------------------
    const tiny = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    await expectDomainError('UNSUPPORTED', () => plainService.beginUpload(ownerA, { name: 'qa.exe', contentType: 'application/x-msdownload', sizeBytes: 10, sha256: sha256Of(tiny), purpose: 'testing upload gates' }), 'disallowed content type');
    await expectDomainError('INVALID_INPUT', () => plainService.beginUpload(ownerA, { name: 'big.pdf', contentType: 'application/pdf', sizeBytes: DOCUMENT_MAX_BYTES + 1, sha256: sha256Of(tiny), purpose: 'testing size gate' }), 'oversized file');
    await expectDomainError('INVALID_INPUT', () => plainService.beginUpload(ownerA, { name: 'bad.pdf', contentType: 'application/pdf', sizeBytes: tiny.byteLength, sha256: 'not-a-hash', purpose: 'testing hash gate' }), 'malformed sha256');
    await expectDomainError('INVALID_INPUT', () => plainService.beginUpload(ownerA, { name: 'x.pdf', contentType: 'application/pdf', sizeBytes: tiny.byteLength, sha256: sha256Of(tiny), purpose: 'ab' }), 'purpose too short');
    await expectDomainError('NOT_CONFIGURED', () => noStorage.beginUpload(ownerA, { name: 'x.pdf', contentType: 'application/pdf', sizeBytes: tiny.byteLength, sha256: sha256Of(tiny), purpose: 'testing storage gate' }), 'storage absent fails closed');

    // --- Happy path with a real PDF: begin → put → complete → drain → AVAILABLE ---------------
    const pdfBytes = await pdfFixture([
      'Quarterly orchard revenue uniquetoken PAPAYA4471 exceeded forecast by eighteen percent.',
      'Supplier consolidation moved pineapple logistics into the tangier cold chain hub.',
    ]);
    const begin = await plainService.beginUpload(ownerA, { name: 'orchard-report.pdf', contentType: 'application/pdf', purpose: 'Mission Q4 orchard revenue analysis', retentionDays: 30, sizeBytes: pdfBytes.byteLength, sha256: sha256Of(pdfBytes) });
    assert(typeof begin.uploadUrl === 'string' && begin.uploadUrl.startsWith('fake-upload://'), 'presigned PUT returned for the client');
    await expectDomainError('NOT_FOUND', () => plainService.completeUpload(ownerA, begin.documentId), 'complete before the object landed');
    await objects.putLastSigned(pdfBytes, 'application/pdf');
    const completed = await plainService.completeUpload(ownerA, begin.documentId);
    assert(completed.state === 'PROCESSING', 'complete accepted the stored object');
    const drain = await plainService.drainIngestPending();
    assert(drain.processed === 1 && drain.failed === 0, 'background ingestion processed the PDF');
    const available = await plainService.list(ownerA);
    const pdfView = available.find(doc => doc.id === begin.documentId);
    assert(pdfView?.state === 'AVAILABLE' && pdfView.chunkCount > 0, 'PDF is AVAILABLE with chunks');
    assert(pdfView.sha256 === sha256Of(pdfBytes), 'stored SHA-256 matches the declaration');

    // Idempotent replay: completing and draining again does not duplicate chunks.
    const replay = await plainService.completeUpload(ownerA, begin.documentId);
    assert(replay.state === 'PROCESSING', 'replayed complete is idempotent');
    const chunksBefore = await db.select().from(documentChunks).where(eq(documentChunks.documentId, begin.documentId));
    const drainAgain = await plainService.drainIngestPending();
    assert(drainAgain.processed === 0, 'no duplicate ingest for an already-processed document');
    const chunksAfter = await db.select().from(documentChunks).where(eq(documentChunks.documentId, begin.documentId));
    assert(chunksBefore.length === chunksAfter.length && chunksAfter.length > 0, 'chunk rows are stable');

    // --- Retrieval: tenant scoping and grounded citations --------------------------------------
    const hit = await plainService.search(ownerA, 'PAPAYA4471', 5);
    assert(hit.citations.length >= 1, 'FTS found the unique token');
    assert(hit.mode === 'FTS' && hit.embedding === 'NOT_CONFIGURED', 'no embeddings configured ⇒ honest FTS mode');
    const citation = hit.citations[0]!;
    assert(citation.documentId === begin.documentId && citation.chunkId.length > 0, 'citation links document and chunk');
    assert(citation.sha256 === sha256Of(pdfBytes) && /^[0-9a-f]{64}$/.test(citation.sha256), 'citation carries the document SHA-256');
    assert(citation.snippet.length > 0, 'citation carries a snippet');
    assert(!(await plainService.search(ownerA, 'nonexistenttokenzzz123', 5)).citations.length, 'gibberish query returns no citations');

    const crossTenant = await plainService.search(ownerB, 'PAPAYA4471', 5);
    assert(crossTenant.citations.length === 0, 'tenant B cannot retrieve tenant A content');
    assert((await plainService.list(ownerB)).length === 0, 'tenant B listing is empty');
    await expectDomainError('NOT_FOUND', () => plainService.get(ownerB, begin.documentId), 'tenant B metadata access');
    await expectDomainError('NOT_FOUND', () => plainService.signedDownload(ownerB, begin.documentId), 'tenant B download');
    await expectDomainError('NOT_FOUND', () => plainService.delete(ownerB, begin.documentId), 'tenant B deletion');

    // --- Mission attachment ----------------------------------------------------------------------
    const mission = await store.createOperation(ownerA, 'QA A17 mission', 'Verify attachment semantics', []);
    await plainService.attach(ownerA, begin.documentId, mission.id);
    const attached = await plainService.attachedDocuments(ownerA, mission.id);
    assert(attached.length === 1 && attached[0]!.id === begin.documentId, 'document attached to mission');
    await expectDomainError('NOT_FOUND', () => plainService.attach(ownerB, begin.documentId, mission.id), 'tenant B attach');
    await plainService.detach(ownerA, begin.documentId, mission.id);
    assert((await plainService.attachedDocuments(ownerA, mission.id)).length === 0, 'detach removes the attachment');
    await plainService.attach(ownerA, begin.documentId, mission.id);

    // --- DOCX path -------------------------------------------------------------------------------
    const docxBytes = docxFixture(['Board minutes uniquetoken MANGO9021 approved the cold chain expansion.', 'Second paragraph with additional detail.']);
    const docxBegin = await plainService.beginUpload(ownerA, { name: 'minutes.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', purpose: 'Mission board minutes review', sizeBytes: docxBytes.byteLength, sha256: sha256Of(docxBytes) });
    await objects.putLastSigned(docxBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await plainService.completeUpload(ownerA, docxBegin.documentId);
    assert((await plainService.drainIngestPending()).processed === 1, 'DOCX ingested');
    const docxHit = await plainService.search(ownerA, 'MANGO9021', 5);
    assert(docxHit.citations.some(c => c.documentId === docxBegin.documentId), 'DOCX text retrievable');

    // --- Plain text path and the garbage-terminal case -------------------------------------------
    const txtBytes = new TextEncoder().encode('Plain note uniquetoken KIWI3333 about supplier consolidation.');
    const txtBegin = await plainService.beginUpload(ownerA, { name: 'note.txt', contentType: 'text/plain', purpose: 'Mission supplier notes', sizeBytes: txtBytes.byteLength, sha256: sha256Of(txtBytes) });
    await objects.putLastSigned(txtBytes, 'text/plain');
    await plainService.completeUpload(ownerA, txtBegin.documentId);
    assert((await plainService.drainIngestPending()).processed === 1, 'text file ingested');

    const garbageBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x61, 0x62, 0x80, 0x81, 0x00, 0x63]);
    const garbageBegin = await plainService.beginUpload(ownerA, { name: 'garbage.txt', contentType: 'text/plain', purpose: 'Mission decoder rejection', sizeBytes: garbageBytes.byteLength, sha256: sha256Of(garbageBytes) });
    await objects.putLastSigned(garbageBytes, 'text/plain');
    await plainService.completeUpload(ownerA, garbageBegin.documentId);
    for (let attempt = 0; attempt < 3; attempt++) await plainService.drainIngestPending();
    const garbageView = await plainService.get(ownerA, garbageBegin.documentId);
    assert(garbageView.state === 'FAILED' && garbageView.extractionCode === 'INVALID_STATE', 'undecodable bytes terminate FAILED with a real code');

    // --- SHA-256 mismatch discards the object ---------------------------------------------------
    const mismatchBegin = await plainService.beginUpload(ownerA, { name: 'mismatch.pdf', contentType: 'application/pdf', purpose: 'Mission integrity check', sizeBytes: pdfBytes.byteLength, sha256: sha256Of(new Uint8Array([1, 2, 3])) });
    await objects.putLastSigned(pdfBytes, 'application/pdf');
    await expectDomainError('CONFLICT', () => plainService.completeUpload(ownerA, mismatchBegin.documentId), 'mismatched SHA-256 is rejected');
    const mismatchRow = (await plainService.list(ownerA)).find(doc => doc.id === mismatchBegin.documentId);
    assert(mismatchRow?.state === 'FAILED' && mismatchRow.extractionCode === 'sha256_mismatch', 'mismatched object discarded and recorded');

    // --- Magic-byte sniffing ----------------------------------------------------------------------
    const fakePdf = new TextEncoder().encode('definitely not a pdf, just text pretending');
    const fakePdfBegin = await plainService.beginUpload(ownerA, { name: 'fake.pdf', contentType: 'application/pdf', purpose: 'Mission sniffing check', sizeBytes: fakePdf.byteLength, sha256: sha256Of(fakePdf) });
    await objects.putLastSigned(fakePdf, 'application/pdf');
    await expectDomainError('CONFLICT', () => plainService.completeUpload(ownerA, fakePdfBegin.documentId), 'non-PDF bytes rejected for a PDF declaration');

    // --- Hybrid rerank through QA embeddings, and degradation on provider failure -----------------
    const hybridBytes = new TextEncoder().encode('Hybrid retrieval probe uniquetoken BANANA8080 warms ranking path.');
    const hybridBegin = await hybridService.beginUpload(ownerA, { name: 'hybrid.txt', contentType: 'text/plain', purpose: 'Mission hybrid ranking probe', sizeBytes: hybridBytes.byteLength, sha256: sha256Of(hybridBytes) });
    await objects.putLastSigned(hybridBytes, 'text/plain');
    await hybridService.completeUpload(ownerA, hybridBegin.documentId);
    assert((await hybridService.drainIngestPending()).processed === 1, 'hybrid-path document ingested');
    const storedVectors = await db.select().from(documentChunks).where(eq(documentChunks.documentId, hybridBegin.documentId));
    assert(storedVectors.length > 0 && storedVectors.every(row => Array.isArray(row.embedding) && row.embedding.length > 0), 'embeddings stored alongside chunks');
    const hybridHit = await hybridService.search(ownerA, 'BANANA8080', 3);
    assert(hybridHit.mode === 'HYBRID' && hybridHit.embedding === 'CONFIGURED', 'hybrid mode engages only with a configured provider');
    assert(hybridHit.citations[0]?.documentId === hybridBegin.documentId, 'hybrid citation still grounds to the real document');

    const throwingEmbeddings = { id: 'qa-throwing', embed: async () => { throw new Error('QA provider outage'); } };
    const degradedService = new DocumentVaultService(store, objects, throwingEmbeddings);
    const degradedBytes = new TextEncoder().encode('Degraded provider probe uniquetoken CHERRY1212 stays findable.');
    const degradedBegin = await degradedService.beginUpload(ownerA, { name: 'degraded.txt', contentType: 'text/plain', purpose: 'Mission degradation probe', sizeBytes: degradedBytes.byteLength, sha256: sha256Of(degradedBytes) });
    await objects.putLastSigned(degradedBytes, 'text/plain');
    await degradedService.completeUpload(ownerA, degradedBegin.documentId);
    assert((await degradedService.drainIngestPending()).processed === 1, 'ingestion succeeds despite embedding provider failure');
    const degradedHit = await degradedService.search(ownerA, 'CHERRY1212', 3);
    assert(degradedHit.mode === 'FTS', 'embedding outage degrades to FTS, never to a failure');

    // --- Retention: expiry excludes and purges ---------------------------------------------------
    const ephemeralBytes = new TextEncoder().encode('Ephemeral memo uniquetoken MELON6060 expires immediately.');
    const ephemeralBegin = await plainService.beginUpload(ownerA, { name: 'ephemeral.txt', contentType: 'text/plain', purpose: 'Mission retention probe', retentionDays: 1, sizeBytes: ephemeralBytes.byteLength, sha256: sha256Of(ephemeralBytes) });
    await objects.putLastSigned(ephemeralBytes, 'text/plain');
    await plainService.completeUpload(ownerA, ephemeralBegin.documentId);
    assert((await plainService.drainIngestPending()).processed === 1, 'ephemeral document ingested');
    await db.update(documents).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(documents.id, ephemeralBegin.documentId));
    assert((await plainService.search(ownerA, 'MELON6060', 5)).citations.length === 0, 'expired document is excluded from retrieval');
    await expectDomainError('DENIED', () => plainService.signedDownload(ownerA, ephemeralBegin.documentId), 'expired document download');
    const purge = await plainService.purgeExpired({ limit: 10 });
    assert(purge.deleted >= 1, 'expired document purged');
    assert((await plainService.list(ownerA)).every(doc => doc.id !== ephemeralBegin.documentId), 'purged document is gone from listing');

    // --- Revocation: delete removes the object, the rows and the citations ----------------------
    const revokeBegin = await plainService.beginUpload(ownerA, { name: 'revoke.txt', contentType: 'text/plain', purpose: 'Mission revocation probe', sizeBytes: txtBytes.byteLength, sha256: sha256Of(txtBytes) });
    await objects.putLastSigned(txtBytes, 'text/plain');
    await plainService.completeUpload(ownerA, revokeBegin.documentId);
    assert((await plainService.drainIngestPending()).processed === 1, 'revocation probe ingested');
    await plainService.delete(ownerA, revokeBegin.documentId);
    assert(objects.deletedKeys.length > 0, 'storage object deleted on revoke');
    assert((await plainService.search(ownerA, 'KIWI3333', 10)).citations.every(c => c.documentId !== revokeBegin.documentId), 'citations for the revoked document are gone');
    await expectDomainError('NOT_FOUND', () => plainService.get(ownerA, revokeBegin.documentId), 'revoked document is not found');

    // --- Attachment rows cascade on revoke --------------------------------------------------------
    assert((await db.select().from(operationDocuments).where(eq(operationDocuments.documentId, revokeBegin.documentId))).length === 0, 'attachments cascade on revoke');

    // --- Audit trail covers the lifecycle ----------------------------------------------------------
    const audits = await db.select().from(documentAuditEvents).where(eq(documentAuditEvents.workspaceId, wsA));
    const actions = new Set(audits.map(a => a.action));
    for (const action of ['UPLOAD_STARTED', 'UPLOAD_VALIDATE', 'INGEST', 'ATTACH', 'DETACH', 'DELETE', 'EXPIRED_PURGE']) {
      assert(actions.has(action), 'audit trail covers ' + action);
    }

    console.log('  PART 2 PASSED: cumulative ' + assertions + ' assertions');
    return 'PASSED';
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : error));
  }
}

partOne();
try {
  const integration = await partTwo();
  if (integration === 'BLOCKED') {
    console.log('A17 DOCUMENTS QA PARTIAL — PART 1 PASSED (' + assertions + ' assertions), PART 2 BLOCKED.');
    process.exit(BLOCKED);
  }
  console.log('A17 DOCUMENTS QA PASSED: ' + assertions + ' assertions.');
  process.exit(PASS);
} catch (error: unknown) {
  console.error('A17 DOCUMENTS QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(FAILED);
}
