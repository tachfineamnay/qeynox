/**
 * TASK 08A real object-storage QA (isolated database + isolated S3-compatible MinIO only).
 *
 * Requires QEYNOX_QA_DATABASE_URL and QEYNOX_QA_S3_ENDPOINT / QEYNOX_QA_S3_ACCESS_KEY /
 * QEYNOX_QA_S3_SECRET_KEY pointing at a disposable MinIO/S3-compatible service.
 * Creates a random bucket, verifies private uploads, SHA-256 metadata, signed download expiry,
 * tenant isolation, failed-upload recovery and safe PENDING_UPLOAD reconciliation.
 * BLOCKED (not PASS) when the QA storage endpoint is absent.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  artifactObjects, identityMemberships, identityUsers, identityWorkspaces, operations, resultDocuments,
} from '@qeynox/persistence';
import {
  ArtifactDelivery, S3ArtifactStore, exportHtml, exportJson,
  type ArtifactStorePort, type ObjectHead, type ObjectReceipt, type ResultDocument,
} from '@qeynox/application';
import { DomainError, newId, type ID, type Operation, type Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

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
const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
class FailingPutStore implements ArtifactStorePort {
  constructor(private readonly real: ArtifactStorePort) {}
  async put(): Promise<never> { throw new Error('QA injected upload failure'); }
  head(key: string): Promise<ObjectHead | undefined> { return this.real.head(key); }
  signedRead(key: string, expiresSeconds: number): Promise<string> { return this.real.signedRead(key, expiresSeconds); }
}
function documentFor(workspaceId: ID, operationId: ID, revisionId: ID, title: string): ResultDocument {
  return {
    id: newId(), workspaceId, operationId, revisionId, version: 1, title, objective: 'QA object storage verification',
    scope: ['QA storage scope'], findings: [], nextActions: [], limitations: [], unresolved: [], citations: [],
    createdAt: new Date().toISOString(), status: 'READY_FOR_REVIEW',
  };
}
async function operationWithRevision(store: QeyNoxStore, principal: Principal, title: string): Promise<{operation: Operation; revisionId: ID}> {
  const operation = await store.createOperation(principal, title, 'QA storage operation objective', []);
  const revisionId = randomUUID() as ID;
  const updated: Operation = { ...operation, currentRevisionId: revisionId };
  await store.db.update(operations).set({ currentRevisionId: revisionId, payload: updated as unknown as Operation }).where(eq(operations.id, operation.id));
  return { operation: updated, revisionId };
}

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_S3_ENDPOINT || !process.env.QEYNOX_QA_S3_ACCESS_KEY || !process.env.QEYNOX_QA_S3_SECRET_KEY) {
    console.log('STORAGE QA BLOCKED: QEYNOX_QA_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY are not configured; no live S3 checks performed.');
    return;
  }
  if (!process.env.QEYNOX_QA_DATABASE_URL) throw new DomainError('NOT_CONFIGURED', 'QEYNOX_QA_DATABASE_URL required for storage QA');
  const endpoint = process.env.QEYNOX_QA_S3_ENDPOINT;
  const accessKeyId = process.env.QEYNOX_QA_S3_ACCESS_KEY;
  const secretAccessKey = process.env.QEYNOX_QA_S3_SECRET_KEY;
  const bucket = 'qeynox-qa-' + randomUUID().replace(/-/g, '').slice(0, 16);
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  assert(true, 'isolated S3 bucket created');
  const realStore = new S3ArtifactStore(bucket, { region: 'us-east-1', endpoint, accessKeyId, secretAccessKey, serverSideEncryption: false });
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total, 'QA database migrated');
    connection = connectDatabase(qa.url);
    const store = new QeyNoxStore(connection.db);
    const ownerId = randomUUID(), otherId = randomUUID(), workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
    await connection.db.insert(identityUsers).values([
      { id: ownerId, email: 'qa-storage-owner-' + ownerId + '@example.invalid' },
      { id: otherId, email: 'qa-storage-other-' + otherId + '@example.invalid' },
    ]);
    await connection.db.insert(identityWorkspaces).values([
      { id: workspaceId, name: 'QA Storage Workspace', createdBy: ownerId },
      { id: otherWorkspaceId, name: 'QA Other Workspace', createdBy: otherId },
    ]);
    await connection.db.insert(identityMemberships).values([
      { id: randomUUID(), userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: otherId, workspaceId: otherWorkspaceId, role: 'OWNER', status: 'ACTIVE' },
    ]);
    const owner: Principal = { userId: ownerId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const other: Principal = { userId: otherId as ID, workspaceId: otherWorkspaceId as ID, roles: ['OWNER'] };
    const delivery = new ArtifactDelivery(store, realStore);

    // --- Real upload, SHA-256 integrity, privacy and signed download expiry. ---
    const key = 'qa/object-' + randomUUID() + '.txt';
    const payload = Buffer.from('QeyNox real QA object payload ' + randomUUID());
    const receipt = await realStore.put(key, payload, 'text/plain');
    assert(receipt.sha256 === sha256(payload), 'put response digest matches content');
    const head = await realStore.head(key);
    assert(head?.sha256 === receipt.sha256 && head.size === payload.byteLength, 'head reports stored digest/size');
    const signedUrl = await realStore.signedRead(key, 180);
    assert(/X-Amz-Signature=/.test(signedUrl) && /X-Amz-Expires=180/.test(signedUrl), 'signed read URL carries signature and expiry');
    const signedResponse = await fetch(signedUrl);
    const signedBody = Buffer.from(await signedResponse.arrayBuffer());
    assert(signedResponse.status === 200 && signedBody.equals(payload), 'signed download returns the exact private object');
    const anonymous = await fetch(endpoint + '/' + bucket + '/' + key);
    assert(anonymous.status === 403 || anonymous.status === 401, 'bucket is private (anonymous object access denied)');
    const shortUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 1 });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const expiredResponse = await fetch(shortUrl);
    assert(expiredResponse.status === 403 || expiredResponse.status === 401, 'expired signed download is rejected');
    assert((await realStore.head('qa/missing-' + randomUUID())) === undefined, 'missing object head returns undefined');

    // --- ArtifactDelivery real upload, private read grant and tenant isolation. ---
    const main = await operationWithRevision(store, owner, 'QA storage deliverable');
    const document = documentFor(owner.workspaceId, main.operation.id, main.revisionId, 'QA storage document');
    await connection.db.insert(resultDocuments).values({ id: document.id, workspaceId: owner.workspaceId, operationId: main.operation.id, revisionId: main.revisionId, version: 1, state: 'READY_FOR_REVIEW', document: document as unknown as Record<string, unknown>, createdAt: document.createdAt });
    const jsonContent = exportJson(document), htmlContent = exportHtml(document);
    const jsonArtifact = await delivery.save(owner, document, 'json', jsonContent);
    const htmlArtifact = await delivery.save(owner, document, 'html', htmlContent);
    assert(jsonArtifact.sha256 === sha256(jsonContent) && htmlArtifact.sha256 === sha256(htmlContent), 'artifact save verifies SHA-256');
    const availableRows = await connection.db.select().from(artifactObjects).where(and(eq(artifactObjects.operationId, main.operation.id), eq(artifactObjects.state, 'AVAILABLE')));
    assert(availableRows.length === 2, 'both real uploads become AVAILABLE');
    const grantUrl = await delivery.readGrant(owner, main.operation.id, document.id, jsonArtifact.artifactId);
    const grantResponse = await fetch(grantUrl);
    assert(grantResponse.status === 200 && Buffer.from(await grantResponse.arrayBuffer()).equals(Buffer.from(jsonContent)), 'read grant downloads the uploaded artifact');
    await expectDomainError('NOT_FOUND', () => delivery.readGrant(other, main.operation.id, document.id, jsonArtifact.artifactId), 'cross-tenant read grant');
    await expectDomainError('NOT_FOUND', () => delivery.readGrant(owner, main.operation.id, newId() as ID, jsonArtifact.artifactId), 'wrong document read grant');

    // --- Failed upload leaves PENDING_UPLOAD, then safe reconciliation uploads it. ---
    const failedDocument = documentFor(owner.workspaceId, main.operation.id, main.revisionId, 'QA failed upload document');
    await connection.db.insert(resultDocuments).values({ id: failedDocument.id, workspaceId: owner.workspaceId, operationId: main.operation.id, revisionId: main.revisionId, version: 2, state: 'READY_FOR_REVIEW', document: failedDocument as unknown as Record<string, unknown>, createdAt: failedDocument.createdAt });
    const failingDelivery = new ArtifactDelivery(store, new FailingPutStore(realStore));
    await expectDomainError('INVALID_STATE', async () => { try { await failingDelivery.save(owner, failedDocument, 'json', exportJson(failedDocument)); } catch (error: unknown) { throw error instanceof DomainError ? error : new DomainError('INVALID_STATE', 'injected failure'); } }, 'injected upload failure');
    const pendingRows = await connection.db.select().from(artifactObjects).where(and(eq(artifactObjects.operationId, main.operation.id), eq(artifactObjects.state, 'PENDING_UPLOAD')));
    assert(pendingRows.length === 1, 'failed upload remains PENDING_UPLOAD, not falsely AVAILABLE');
    const reconciled = await delivery.reconcilePending(owner, main.operation.id);
    assert(reconciled.recovered.includes(pendingRows[0]!.id as ID) && reconciled.conflicts.length === 0, 'pending artifact safely recovered');
    const recoveredRow = (await connection.db.select().from(artifactObjects).where(eq(artifactObjects.id, pendingRows[0]!.id)))[0];
    assert(recoveredRow?.state === 'AVAILABLE', 'recovered artifact marked AVAILABLE only after digest-verified upload');
    const recoveredUrl = await delivery.readGrant(owner, main.operation.id, failedDocument.id, recoveredRow!.id as ID);
    assert(Buffer.from(await (await fetch(recoveredUrl)).arrayBuffer()).equals(Buffer.from(exportJson(failedDocument))), 'recovered object content intact');

    // --- Uploaded object with missing metadata is adopted by digest, not overwritten. ---
    const adoptedDocument = documentFor(owner.workspaceId, main.operation.id, main.revisionId, 'QA adopted object document');
    await connection.db.insert(resultDocuments).values({ id: adoptedDocument.id, workspaceId: owner.workspaceId, operationId: main.operation.id, revisionId: main.revisionId, version: 3, state: 'READY_FOR_REVIEW', document: adoptedDocument as unknown as Record<string, unknown>, createdAt: adoptedDocument.createdAt });
    const adoptedContent = Buffer.from(exportJson(adoptedDocument));
    const adoptedId = newId(), adoptedKey = 'workspaces/' + workspaceId + '/operations/' + main.operation.id + '/results/' + adoptedDocument.id + '/' + adoptedId + '.json';
    await realStore.put(adoptedKey, adoptedContent, 'application/json');
    await connection.db.insert(artifactObjects).values({ id: adoptedId, documentId: adoptedDocument.id, workspaceId, operationId: main.operation.id, key: adoptedKey, sha256: sha256(adoptedContent), contentType: 'application/json', size: adoptedContent.byteLength, state: 'PENDING_UPLOAD', createdAt: new Date().toISOString() });
    const headOnlyStore = new FailingPutStore(realStore);
    const adopted = await new ArtifactDelivery(store, headOnlyStore).reconcilePending(owner, main.operation.id);
    assert(adopted.recovered.includes(adoptedId) && adopted.conflicts.length === 0, 'already-uploaded object adopted without overwrite via head digest');

    // --- Conflicting metadata/document states are never uploaded or overwritten. ---
    const conflictDocument = documentFor(owner.workspaceId, main.operation.id, main.revisionId, 'QA conflict document original');
    await connection.db.insert(resultDocuments).values({ id: conflictDocument.id, workspaceId: owner.workspaceId, operationId: main.operation.id, revisionId: main.revisionId, version: 4, state: 'READY_FOR_REVIEW', document: conflictDocument as unknown as Record<string, unknown>, createdAt: conflictDocument.createdAt });
    const changedContent = Buffer.from(exportJson({ ...conflictDocument, title: 'QA conflict document changed' }));
    const changedDocument = JSON.parse(Buffer.from(changedContent).toString('utf8')) as ResultDocument;
    await connection.db.update(resultDocuments).set({ document: changedDocument as unknown as Record<string, unknown> }).where(eq(resultDocuments.id, conflictDocument.id));
    const conflictContent = Buffer.from(exportJson(conflictDocument));
    const conflictId = newId(), conflictKey = 'workspaces/' + workspaceId + '/operations/' + main.operation.id + '/results/' + conflictDocument.id + '/' + conflictId + '.json';
    await connection.db.insert(artifactObjects).values({ id: conflictId, documentId: conflictDocument.id, workspaceId, operationId: main.operation.id, key: conflictKey, sha256: sha256(conflictContent), contentType: 'application/json', size: conflictContent.byteLength, state: 'PENDING_UPLOAD', createdAt: new Date().toISOString() });
    const conflictResult = await delivery.reconcilePending(owner, main.operation.id);
    assert(conflictResult.conflicts.includes(conflictId), 'document-changed pending artifact is reported as a conflict');
    assert((await connection.db.select().from(artifactObjects).where(eq(artifactObjects.id, conflictId)))[0]?.state === 'PENDING_UPLOAD', 'conflicting artifact is not falsely promoted');
    assert((await realStore.head(conflictKey)) === undefined, 'conflicting artifact was not uploaded');
    const objectB = Buffer.from('QA conflicting object content');
    await realStore.put(conflictKey, objectB, 'application/json');
    const mismatchResult = await delivery.reconcilePending(owner, main.operation.id);
    assert(mismatchResult.conflicts.includes(conflictId), 'existing object digest mismatch reported as conflict');
    assert((await realStore.head(conflictKey))?.sha256 === sha256(objectB), 'existing mismatching object is never overwritten');
    await expectDomainError('NOT_FOUND', () => delivery.reconcilePending(other, main.operation.id), 'cross-tenant reconciliation');

    console.log('OBJECT_STORAGE_EVIDENCE', JSON.stringify({ bucket, objects: { uploaded: availableRows.length + 2, adopted: 1, conflicts: 2 }, signedGetStatus: signedResponse.status, anonymousStatus: anonymous.status, expiredStatus: expiredResponse.status, reconciliation: { recovered: reconciled.recovered.length + adopted.recovered.length, conflicts: conflictResult.conflicts.length + mismatchResult.conflicts.length } }));
    console.log('Object storage QA PASSED:', assertions, 'assertions');
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Object storage QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

