/**
 * MISSION A07 — Atlas results experience QA (isolated database only).
 *
 * Proves the parts of the results experience that can be wrong in a way a customer would not notice:
 *
 *   1. CLASSIFICATION  — an unreviewed claim is never presented as a verified conclusion, in any
 *                        surface (classification, HTML export, PDF export, reader grouping).
 *   2. DOCUMENT INTEGRITY — JSON, HTML and PDF derive from the same facts; JSON stays byte-stable
 *                        (artifact reconciliation depends on it) and PDF is deterministic, valid and
 *                        really carries the document text.
 *   3. SAFETY          — exported HTML cannot execute injected markup, and no non-http(s) or
 *                        credential-bearing citation is ever rendered as a link.
 *   4. TENANT ISOLATION — a document is only readable/exportable inside its own workspace, on its
 *                        active revision, and reconciliation inherits the same guard.
 *   5. REVIEW GATING   — a SUPPORTED claim in an unreviewed document is still not a conclusion, and a
 *                        DELIVERABLE document is only "delivered" when a verified finding exists.
 *
 * HONEST BOUNDARY — read before trusting a green run:
 * - The PDF/HTML assertions run the real generators in @qeynox/application, not a browser. They prove
 *   the artefact's contents and determinism, NOT pixel layout or print pagination.
 * - No PDF viewer runs here, so "valid PDF" means: correct header, correct trailer, parseable by
 *   pdf-lib. Visual fidelity is NOT VERIFIED.
 * - Artifact upload uses an in-memory ArtifactStorePort double. Signed-URL expiry and S3 privacy are
 *   covered by qa:storage, which is BLOCKED in this environment (no S3 endpoint).
 */
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  artifactObjects, identityMemberships, identityUsers, identityWorkspaces, operations, resultDocuments,
} from '@qeynox/persistence';
import {
  ArtifactDelivery, ResultAssembler, classifyDocument, classifyFinding, documentVerdict, exportHtml, exportJson, exportPdf,
  isVerifiableUri, FINDING_CLASS_LABEL, EXPORT_CONTENT_TYPE, exportExtension, formatFromContentType,
  type ArtifactStorePort, type ObjectHead, type ObjectReceipt, type ResultDocument,
} from '@qeynox/application';
import { DomainError, newId, type ID, type Operation, type Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

let assertions = 0;
const passed: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { passed.push(message); console.log('PASS: ' + message); }
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ' (' + error.message + ')' : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
const utf8 = (content: Uint8Array): string => Buffer.from(content).toString('utf8');
const has = (content: Uint8Array, needle: string): boolean => utf8(content).includes(needle);

/**
 * Extract the text a PDF actually draws.
 *
 * Page content streams are Flate-compressed, so a naive byte search proves nothing. This inflates
 * every stream and pulls the literal strings out of the `Tj`/`TJ` text operators, which is enough to
 * assert what the document says. It is deliberately not a general PDF parser and makes no claim about
 * fonts, positioning or visual output.
 */
function pdfText(pdfBytes: Uint8Array): string {
  const bytes = Buffer.from(pdfBytes);
  const chunks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = bytes.indexOf('stream', cursor);
    if (start < 0) break;
    const end = bytes.indexOf('endstream', start);
    if (end < 0) break;
    // Skip the EOL that follows the `stream` keyword.
    let from = start + 'stream'.length;
    if (bytes[from] === 0x0d) from++;
    if (bytes[from] === 0x0a) from++;
    try { chunks.push(inflateSync(bytes.subarray(from, end)).toString('latin1')); } catch { /* not deflate: image or font data */ }
    cursor = end + 'endstream'.length;
  }
  const content = chunks.join('\n');
  const literal = [...content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)].map(match => match[1]!.replace(/\\([()\\])/g, '$1'));
  // pdf-lib writes WinAnsi text as hex strings, so both forms must be understood.
  const hexadecimal = [...content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map(match => Buffer.from(match[1]!, 'hex').toString('latin1'));
  return [...literal, ...hexadecimal].join('\n');
}

/** In-memory object store: records every key and byte so privacy and tenancy can be asserted. */
class MemoryStore implements ArtifactStorePort {
  readonly objects = new Map<string, { content: Uint8Array; contentType: string }>();
  puts = 0;
  async put(key: string, content: Uint8Array, contentType: string): Promise<ObjectReceipt> {
    this.puts++;
    this.objects.set(key, { content, contentType });
    return { key, sha256: sha256(content), size: content.byteLength };
  }
  async head(key: string): Promise<ObjectHead | undefined> {
    const found = this.objects.get(key);
    return found ? { sha256: sha256(found.content), size: found.content.byteLength } : undefined;
  }
  async signedRead(key: string): Promise<string> { return 'https://objects.invalid/' + encodeURIComponent(key); }
}

const citation = (uri?: string, fingerprint?: string) => ({
  sourceId: 'source_qa', provider: 'QA provider', uri, retrievedAt: '2026-01-01T12:00:00.000Z',
  ...(uri && !uri.startsWith('javascript:') ? { publishedAt: '2025-12-01T00:00:00.000Z' } : {}),
  ...(fingerprint ? { fingerprint } : {}),
});
const strong = citation('https://example.org/evidence', 'a'.repeat(64));

function documentFor(overrides: Partial<ResultDocument> & { workspaceId: ID; operationId: ID; revisionId: ID }): ResultDocument {
  return {
    id: newId(), version: 1, title: 'QA Atlas document', objective: 'QA Atlas objective',
    scope: ['QA scope'], findings: [], nextActions: [], limitations: [], unresolved: [], citations: [],
    createdAt: '2026-01-01T12:00:00.000Z', status: 'READY_FOR_REVIEW', ...overrides,
  } as unknown as ResultDocument;
}
type Finding = ResultDocument['findings'][number];
const finding = (overrides: Partial<Finding> = {}): Finding => ({
  claimId: newId(), statement: 'QA claim', status: 'UNVERIFIED', sourceIds: [], attemptId: newId(),
  limitations: [], citations: [], ...overrides,
} as unknown as Finding);
const verifiedFinding = finding({ statement: 'Verified QA finding', status: 'SUPPORTED', citations: [strong] as never });
const unverifiedFinding = finding({ statement: 'Unreviewed QA claim', status: 'UNVERIFIED', citations: [strong] as never });

async function main(): Promise<void> {
  const startedAt = Date.now();
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const store = new QeyNoxStore(connection.db);

    // ── Group 1 · classification is conservative and total ───────────────────────────────────────
    const cases: readonly (readonly [string, string, readonly unknown[], string])[] = [
      ['SUPPORTED with a verifiable citation', 'SUPPORTED', [strong], 'VERIFIED'],
      ['SUPPORTED with no citation at all', 'SUPPORTED', [], 'UNRESOLVED'],
      ['SUPPORTED citing a javascript: URL', 'SUPPORTED', [citation('javascript:alert(1)')], 'UNRESOLVED'],
      ['SUPPORTED citing a data: URL', 'SUPPORTED', [citation('data:text/html,<script>alert(1)</script>')], 'UNRESOLVED'],
      ['SUPPORTED citing a credential-bearing URL', 'SUPPORTED', [citation('https://user:secret@example.org/x')], 'UNRESOLVED'],
      ['SUPPORTED citing a relative path', 'SUPPORTED', [citation('/local/evidence')], 'UNRESOLVED'],
      ['UNVERIFIED', 'UNVERIFIED', [strong], 'AWAITING_ASSESSMENT'],
      ['CONFLICTING', 'CONFLICTING', [strong], 'UNRESOLVED'],
      ['STALE', 'STALE', [strong], 'UNRESOLVED'],
      ['DISPROVEN', 'DISPROVEN', [strong], 'UNRESOLVED'],
      ['NEEDS_HUMAN_REVIEW', 'NEEDS_HUMAN_REVIEW', [strong], 'UNRESOLVED'],
      ['an unknown future status', 'SOME_FUTURE_STATUS', [strong], 'AWAITING_ASSESSMENT'],
    ];
    for (const [label, status, citations, expected] of cases) {
      const result = classifyFinding(finding({ status, citations: citations as never }));
      assert(result.findingClass === expected, `${label} classifies as ${expected}, got ${result.findingClass}`);
      // The load-bearing invariant: "verified" and "may be shown as a conclusion" are the same bit.
      assert(result.verified === (expected === 'VERIFIED'), `${label}: the verified flag is true only for the VERIFIED class`);
    }
    const demoted = classifyFinding(finding({ status: 'SUPPORTED', citations: [] }));
    assert(demoted.blockers.includes('NO_VERIFIABLE_CITATION'), 'a demoted claim states why it was demoted');
    assert(classifyFinding(finding({ status: 'UNVERIFIED' })).blockers.includes('NOT_ASSESSED'), 'an unassessed claim says so');
    assert(classifyFinding(finding({ status: 'DISPROVEN', citations: [strong] as never })).blockers.includes('DISPROVEN_BY_EVIDENCE'), 'a disproven claim states why');
    for (const uri of ['https://example.org/a', 'http://example.org/a']) assert(isVerifiableUri(uri), uri + ' is verifiable');
    for (const uri of ['javascript:alert(1)', 'ftp://example.org/a', 'file:///etc/passwd', 'https://u:p@example.org/', '', undefined]) {
      assert(!isVerifiableUri(uri), String(uri) + ' must not be verifiable');
    }
    assert(Object.keys(FINDING_CLASS_LABEL).length === 4, 'every finding class has a stable customer label');
    pass('classification only demotes, never promotes, and always states a reason');

    // ── Group 2 · no unreviewed document can render as a reviewed conclusion ─────────────────────
    const base = { workspaceId: newId(), operationId: newId(), revisionId: newId() };
    const deliverableDoc = documentFor({ ...base, status: 'DELIVERABLE', findings: [verifiedFinding, unverifiedFinding] as never });
    const reviewedVerdict = documentVerdict(deliverableDoc, classifyDocument(deliverableDoc));
    assert(/Only evidence-supported findings are presented as conclusions/.test(reviewedVerdict), 'a reviewed document with verified findings says exactly that');
    for (const status of ['DRAFT', 'PARTIAL', 'READY_FOR_REVIEW'] as const) {
      for (const findings of [[verifiedFinding], [verifiedFinding, unverifiedFinding], [unverifiedFinding], []]) {
        const doc = documentFor({ ...base, status, findings: findings as never });
        const classification = classifyDocument(doc);
        const verdict = documentVerdict(doc, classification);
        assert(verdict !== reviewedVerdict, `${status} must never borrow the reviewed verdict`);
        assert(classification.deliverable === false, `${status} is never deliverable, whatever it contains`);
        assert(!/presented as conclusions/.test(verdict), `${status} must not claim any conclusion`);
      }
    }
    assert(classifyDocument(documentFor({ ...base, status: 'DELIVERABLE', findings: [verifiedFinding, unverifiedFinding] as never })).counts.VERIFIED === 1, 'counts separate verified from unassessed');
    const unsupportedDeliverable = documentFor({ ...base, status: 'DELIVERABLE', findings: [finding({ status: 'SUPPORTED', citations: [] })] as never });
    assert(classifyDocument(unsupportedDeliverable).deliverable === false, 'the DELIVERABLE state alone never makes an unsupported claim a conclusion');
    assert(/Nothing here is a verified conclusion/.test(documentVerdict(unsupportedDeliverable, classifyDocument(unsupportedDeliverable))), 'and the verdict says so explicitly');
    pass('no unreviewed document can be presented as a reviewed conclusion');

    // ── Group 2b · the PDF never crashes on text its font cannot render ─────────────────────────
    // Narrow standard fonts cannot encode Greek, CJK or emoji. A customer's document must still
    // export, and the PDF must say what it could not render instead of dropping it silently.
    const exotic = documentFor({
      ...base, status: 'PARTIAL', title: 'Δοκιμή — 日本語 — 🚀',
      objective: 'QA objective with α, Ω, 中文字符 and an emoji 🚀 plus ASCII',
      findings: [finding({ statement: 'Mixed script finding: αβγ 中文 🚀 plain ASCII', status: 'UNRESOLVED' })] as never,
    });
    const exoticPdf = await exportPdf(exotic).then(
      value => value,
      (error: unknown) => { throw new Error('the PDF export must never throw on unrepresentable text, got: ' + String(error)); },
    );
    assert(Buffer.from(exoticPdf.slice(0, 5)).toString('latin1') === '%PDF-', 'a document with non-Latin text still exports a valid PDF');
    assert(sha256(exoticPdf) === sha256(await exportPdf(exotic)), 'and remains deterministic');
    assert(exoticPdf.byteLength > 1000, 'the exotic-text PDF is a real document, not an empty stub: ' + exoticPdf.byteLength + ' bytes');
    // The exact original text survives in the formats that can carry it — PDF is the lossy one.
    assert(has(exportJson(exotic), 'αβγ 中文 🚀 plain ASCII'), 'JSON preserves the exact original text');
    assert(has(exportHtml(exotic), 'αβγ 中文 🚀 plain ASCII'), 'HTML preserves the exact original text');
    // And the PDF must not contain a lone surrogate/replacement run pretending to be the statement.
    const exoticDrawable = pdfText(exoticPdf);
    assert(exoticDrawable.includes('Encoding notice'), 'the PDF discloses that some text could not be rendered');
    assert(exoticDrawable.includes('exact original text'), 'and points the reader at the formats that carry it');
    assert(exoticDrawable.includes('plain ASCII'), 'renderable text in the same sentence is still drawn');
    assert(!/\u0000{4,}/.test(utf8(exoticPdf)), 'the PDF does not emit NUL padding for unrenderable characters');
    pass('a PDF export never fails on unrepresentable text, and the other formats keep it exact');

    // ── Group 3 · exports agree, and are reproducible ────────────────────────────────────────────
    const rich = documentFor({
      ...base, status: 'READY_FOR_REVIEW', findings: [verifiedFinding, unverifiedFinding] as never,
      citations: [strong] as never, limitations: ['QA limitation α'], nextActions: ['Review the unassessed claim'],
      unresolved: [unverifiedFinding.claimId], scope: ['QA scope one'],
    });
    const json = exportJson(rich);
    const html = exportHtml(rich);
    const pdf = await exportPdf(rich);
    assert(sha256(json) === sha256(exportJson(rich)), 'the JSON export is byte-stable (reconciliation depends on it)');
    assert(sha256(html) === sha256(exportHtml(rich)), 'the HTML export is byte-stable');
    assert(sha256(pdf) === sha256(await exportPdf(rich)), 'the PDF export is deterministic — no timestamps or random ids');
    for (const [name, content] of [['HTML', html], ['JSON', json]] as const) {
      assert(has(content, 'Unreviewed QA claim') && has(content, 'Verified QA finding'), `${name} carries both findings`);
    }
    // The human-readable surfaces state the review decision in words; JSON states it as data, because
    // its shape is the persisted document and reconciliation digests depend on it staying stable.
    assert(has(html, 'Not reviewed'), 'the HTML export states in words that no human has reviewed it');
    const pdfContent = pdfText(pdf);
    assert(pdfContent.includes('not reviewed'), 'the PDF states in words that no human has reviewed it');
    assert(pdfContent.includes('Unreviewed QA claim'), 'the PDF actually draws the unassessed claim');
    assert(pdfContent.includes('Verified QA finding'), 'the PDF actually draws the verified finding');
    assert(pdfContent.includes('Awaiting assessment'), 'the PDF labels the unassessed finding by class');
    assert(pdfContent.includes('Not a conclusion'), 'the PDF explains why the claim is not a conclusion');
    assert(pdfContent.includes('QA limitation'), 'the PDF draws the recorded limitation');
    const jsonReview = JSON.parse(utf8(json)) as { status?: string; version?: number; reviewedAt?: string };
    assert(jsonReview.status === 'READY_FOR_REVIEW', 'the JSON export carries the review status as data');
    assert(jsonReview.version === 1, 'the JSON export carries the document version');
    assert(jsonReview.reviewedAt === undefined, 'the JSON export carries no fabricated review timestamp');
    // JSON is the persisted document, not a reshaped view: it must round-trip to the same classes.
    const roundTripped = classifyDocument(JSON.parse(utf8(json)) as ResultDocument);
    for (const findingClass of ['VERIFIED', 'UNRESOLVED', 'AWAITING_ASSESSMENT', 'AI_INTERPRETATION'] as const) {
      assert(roundTripped.counts[findingClass] === classifyDocument(rich).counts[findingClass], `a JSON round-trip preserves the ${findingClass} count`);
    }
    assert(roundTripped.counts.VERIFIED === 1 && roundTripped.counts.AWAITING_ASSESSMENT === 1, 'the JSON round-trip still separates verified from unassessed');
    // The same facts produce the same classification in every surface: no screen/export disagreement.
    const htmlVerifiedCount = (utf8(html).match(/class="finding" data-class="VERIFIED"/g) ?? []).length;
    assert(htmlVerifiedCount === classifyDocument(rich).counts.VERIFIED, 'the HTML verified section matches the classifier count');
    assert(has(json, 'QA limitation α'), 'non-ASCII content survives the JSON export intact');
    assert(has(html, 'QA limitation α'), 'non-ASCII content survives the HTML export intact');
    pass('JSON, HTML and PDF derive from one classification and are byte-reproducible');

    // ── Group 4 · the PDF is a real, document-specific artefact ──────────────────────────────────
    const header = Buffer.from(pdf.slice(0, 8)).toString('latin1');
    assert(header.startsWith('%PDF-1.'), 'the PDF starts with a valid version header, got ' + JSON.stringify(header));
    const tail = Buffer.from(pdf.slice(-4096)).toString('latin1');
    assert(tail.includes('%%EOF'), 'the PDF trailer is terminated');
    assert(pdf.byteLength > 1000, 'the PDF is not a stub: ' + pdf.byteLength + ' bytes');
    const emptyPdf = await exportPdf(documentFor({ ...base, status: 'DRAFT', title: 'Empty QA document' }));
    assert(sha256(emptyPdf) !== sha256(pdf), 'a different document produces a different PDF (no fixed placeholder)');
    assert(emptyPdf.byteLength > 500 && Buffer.from(emptyPdf.slice(0, 5)).toString('latin1') === '%PDF-', 'an empty document still exports a valid PDF');
    // More content must produce more pages/bytes, not silently truncate the finding text.
    const many = Array.from({ length: 40 }, (_, index) => finding({ statement: 'QA long finding ' + index + ' ' + 'x'.repeat(200), status: 'UNRESOLVED' }));
    const bigPdf = await exportPdf(documentFor({ ...base, status: 'PARTIAL', title: 'Big QA document', findings: many as never }));
    assert(bigPdf.byteLength > pdf.byteLength * 2, 'a document with many findings produces a substantially larger PDF (' + bigPdf.byteLength + ' vs ' + pdf.byteLength + ' bytes)');
    // Re-parsing proves the bytes are structurally valid, not merely header-shaped. Parsing with the
    // same library that wrote them is a structural check only: it says nothing about visual layout.
    const reopened = await PDFDocument.load(bigPdf).then(document => document.getPageCount(), () => -1);
    assert(reopened > 1, 'a long document paginates rather than overflowing a single page, pages=' + reopened);
    pass('the PDF export is a valid, paginated, deterministic, document-specific artefact');

    // ── Group 5 · exports cannot be used to inject anything ─────────────────────────────────────
    const hostile = documentFor({
      ...base, status: 'READY_FOR_REVIEW',
      title: '<script>alert("title")</script>', objective: '</title><img src=x onerror=alert(1)>',
      findings: [finding({
        statement: '<script>alert("finding")</script>', status: 'SUPPORTED', limitations: ['<b>bold</b>'],
        citations: [citation('javascript:alert(1)'), citation('https://user:pw@example.org/secret'), citation('https://example.org/ok?a=1&b=2')] as never,
      })],
      citations: [citation('javascript:alert(1)')] as never,
    });
    const hostileHtml = utf8(exportHtml(hostile));
    assert(!/<script/i.test(hostileHtml), 'injected script tags never survive into the HTML export');
    assert(!/href="javascript:/i.test(hostileHtml), 'javascript: URLs never become links');
    assert(!hostileHtml.includes('user:pw@'), 'embedded credentials are redacted, not reproduced');
    assert(!/<img\s/i.test(hostileHtml), 'no injected element survives as live markup');
    // `onerror=` may appear only as escaped text inside a paragraph — never as a parsed attribute.
    assert(!/<[a-z]+[^>]*\son\w+\s*=/i.test(hostileHtml), 'no live event-handler attribute is emitted');
    assert(!/<[a-z]+[^>]*\sstyle\s*=/i.test(hostileHtml), 'no injected style attribute is emitted');
    assert(hostileHtml.includes('&lt;script&gt;'), 'markup is escaped, not stripped: the reader sees exactly what was recorded');
    assert(hostileHtml.includes('https://example.org/ok?a=1&amp;b=2'), 'a legitimate citation survives escaping intact');
    // One legitimate citation among unsafe ones is enough to be verified — and that is correct. The
    // claim is only demoted when *every* citation it offers is unverifiable.
    assert(classifyDocument(hostile).counts.VERIFIED === 1, 'a claim with one genuinely verifiable citation is verified, whatever else it cites');
    const poisoned = documentFor({
      ...base, status: 'READY_FOR_REVIEW',
      findings: [finding({
        statement: 'QA poison claim', status: 'SUPPORTED',
        citations: [citation('javascript:alert(1)'), citation('https://user:pw@example.org/secret'), citation('data:text/html,x')] as never,
      })],
    });
    assert(classifyDocument(poisoned).counts.VERIFIED === 0, 'a claim whose only citations are unsafe can never be verified');
    assert(!has(exportHtml(poisoned), '(not verifiable)') === false, 'and the export marks each unsafe citation as not verifiable');
    pass('exports escape markup, refuse unsafe links, and stay honest under hostile input');

    // ── Group 6 · tenancy and review gating through the real services ───────────────────────────
    const mkWorkspace = async (label: string) => {
      const userId = randomUUID(), workspaceId = randomUUID();
      await connection!.db.insert(identityUsers).values({ id: userId, email: 'qa-a07-' + label + '-' + userId + '@example.invalid' });
      await connection!.db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA A07 ' + label, createdBy: userId });
      await connection!.db.insert(identityMemberships).values({ id: randomUUID(), userId, workspaceId, role: 'OWNER', status: 'ACTIVE' });
      return { principal: { userId: userId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] } as Principal, userId };
    };
    const primary = await mkWorkspace('owner');
    const secondary = await mkWorkspace('outsider');
    const owner = primary.principal;
    const outsider = secondary.principal;
    assert(owner.workspaceId !== outsider.workspaceId, 'the two principals really are in different workspaces');

    const operation = await store.createOperation(owner, 'QA A07 operation', 'QA A07 objective', []);
    const revisionId = randomUUID() as ID;
    const active: Operation = { ...operation, currentRevisionId: revisionId };
    await connection.db.update(operations).set({ currentRevisionId: revisionId, payload: active as unknown as Operation }).where(eq(operations.id, operation.id));

    const insertDocument = async (doc: ResultDocument, version: number) => {
      await connection!.db.insert(resultDocuments).values({
        id: doc.id, workspaceId: owner.workspaceId, operationId: operation.id, revisionId: doc.revisionId,
        version, state: doc.status, document: doc as unknown as Record<string, unknown>, createdAt: doc.createdAt,
      });
    };
    const liveDocument = documentFor({
      workspaceId: owner.workspaceId, operationId: operation.id, revisionId,
      status: 'READY_FOR_REVIEW', findings: [verifiedFinding, unverifiedFinding] as never, citations: [strong] as never,
    });
    await insertDocument(liveDocument, 1);

    const objects = new MemoryStore();
    const artifacts = new ArtifactDelivery(store, objects);
    const livePdf = await exportPdf(liveDocument);
    const save = await artifacts.save(owner, liveDocument, 'pdf', livePdf);
    assert(save.sha256 === sha256(livePdf), 'the recorded digest is the digest of the exported artefact');
    assert(objects.puts === 1 && objects.objects.size === 1, 'exactly one object was written');
    const [storedKey] = [...objects.objects.keys()];
    assert(!!storedKey && storedKey.startsWith('workspaces/' + owner.workspaceId + '/operations/' + operation.id + '/'), 'objects are namespaced by workspace and operation');
    assert(!!storedKey && storedKey.endsWith('.pdf'), 'the object key uses the format extension');
    assert(objects.objects.get(storedKey!)?.contentType === 'application/pdf', 'the object is stored with the PDF content type');
    assert(EXPORT_CONTENT_TYPE.pdf === 'application/pdf' && exportExtension.pdf === 'pdf' && formatFromContentType('application/pdf') === 'pdf', 'format, MIME type and extension are one source of truth');
    pass('PDF artefacts are stored under a tenant-scoped key with the correct digest and content type');

    // NOT_FOUND rather than DENIED is the stronger answer: it does not confirm that the operation exists.
    await expectDomainError('NOT_FOUND', () => store.getOperation(outsider, operation.id), 'an outsider cannot read the operation behind a document');
    await expectDomainError('NOT_FOUND', () => artifacts.save(outsider, liveDocument, 'pdf', livePdf), 'an outsider cannot export another workspace document');
    const putsBefore = objects.puts;
    await expectDomainError('NOT_FOUND', () => artifacts.save(outsider, { ...liveDocument, workspaceId: owner.workspaceId } as ResultDocument, 'json', exportJson(liveDocument)), 'a forged actor/document pair is refused');
    assert(objects.puts === putsBefore, 'a denied export writes no object');
    const superseded = { ...liveDocument, revisionId: randomUUID() as ID } as ResultDocument;
    await expectDomainError('DENIED', () => artifacts.save(owner, superseded, 'json', exportJson(liveDocument)), 'a superseded revision cannot be exported');
    pass('a document is only exportable by its own workspace, on its active revision');

    const pendingDocument = documentFor({ workspaceId: owner.workspaceId, operationId: operation.id, revisionId, status: 'READY_FOR_REVIEW', findings: [verifiedFinding] as never });
    await insertDocument(pendingDocument, 2);
    const pendingContent = await exportPdf(pendingDocument);
    const pendingId = newId();
    const pendingKey = 'workspaces/' + owner.workspaceId + '/operations/' + operation.id + '/results/' + pendingDocument.id + '/' + pendingId + '.pdf';
    await connection.db.insert(artifactObjects).values({
      id: pendingId, documentId: pendingDocument.id, workspaceId: owner.workspaceId, operationId: operation.id,
      key: pendingKey, sha256: sha256(pendingContent), contentType: 'application/pdf', size: pendingContent.byteLength,
      state: 'PENDING_UPLOAD', createdAt: '2026-01-01T12:00:00.000Z',
    });
    const reconciliation = await artifacts.reconcilePending(owner, operation.id);
    assert(reconciliation.recovered.length === 1, 'a pending PDF artefact is recovered by deterministic re-derivation');
    assert(reconciliation.conflicts.length === 0, 'a matching digest is never reported as a conflict');
    const recovered = objects.objects.get(pendingKey);
    assert(!!recovered && sha256(recovered.content) === sha256(pendingContent), 'the recovered object matches the recorded digest byte for byte');
    const outsiderReconciliation = await artifacts.reconcilePending(outsider, operation.id).then(() => 'ALLOWED', (error: unknown) => (error instanceof DomainError ? error.code : String(error)));
    assert(outsiderReconciliation === 'NOT_FOUND', 'reconciliation is tenant-scoped and does not confirm the operation exists, got ' + outsiderReconciliation);
    pass('pending PDF artefacts reconcile deterministically and stay inside the tenant');

    // Reading a document through the real service must be tenant-scoped even with its exact id.
    const documents = new ResultAssembler(store);
    const readByOwner = await documents.get(owner, operation.id, liveDocument.id as ID);
    assert(readByOwner.id === liveDocument.id && readByOwner!.workspaceId === owner.workspaceId, 'the owner reads their own document');
    // The outsider gets the same NOT_FOUND whether or not the id exists: no existence disclosure.
    const realIdResult = await documents.get(outsider, operation.id, liveDocument.id as ID).then(() => 'ALLOWED', (error: unknown) => (error instanceof DomainError ? error.code : String(error)));
    const fakeIdResult = await documents.get(outsider, operation.id, newId()).then(() => 'ALLOWED', (error: unknown) => (error instanceof DomainError ? error.code : String(error)));
    assert(realIdResult === 'NOT_FOUND', 'an outsider cannot read a foreign document by id, got ' + realIdResult);
    assert(realIdResult === fakeIdResult, 'a real id and a fake id are indistinguishable to an outsider (' + realIdResult + ' vs ' + fakeIdResult + ')');

    // ── Group 7 · the fixture is real (so the tenancy assertions above are not vacuous) ─────────
    const memberships = await connection.db.select().from(identityMemberships).where(eq(identityMemberships.workspaceId, owner.workspaceId));
    assert(memberships.length === 1, 'the owner really is a member of the workspace');
    const persisted = await connection.db.select().from(resultDocuments).where(eq(resultDocuments.workspaceId, owner.workspaceId));
    assert(persisted.length === 2, 'both QA documents are persisted in the owning workspace only');
    assert(persisted.every(row => row.workspaceId === owner.workspaceId), 'no document leaked into another workspace');
    const objectsInDb = await connection.db.select().from(artifactObjects).where(eq(artifactObjects.workspaceId, owner.workspaceId));
    assert(objectsInDb.length === 2, 'both artefacts (direct + reconciled) are recorded against the owner');
    pass('tenant fixture is real: two workspaces, two members, documents and artefacts in one of them');

    console.log('\nAtlas results A07 — ' + passed.length + ' groups, ' + assertions + ' assertions PASS in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    console.log('BOUNDARY: generators and tenancy verified against real application code and an isolated database. No browser, PDF viewer or S3 endpoint ran here: PDF visual fidelity is NOT VERIFIED and qa:storage stays BLOCKED.');
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Atlas results QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
