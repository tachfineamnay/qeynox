/**
 * MISSION A20 — Global Atlas Library end-to-end QA (isolated disposable PostgreSQL only).
 *
 * Verifies:
 *   1. Derivation, provenance & deterministic version comparison invariants.
 *   2. Migration 0025 & single canonical result store (result_documents + artifact_objects; zero duplicate store).
 *   3. Authenticated /v1/results server-side cursor pagination, totalCount, and SQL wildcard-safe search.
 *   4. Filters by mission (operationId), result state, mission status, UTC date bounds, and document version (ALL/LATEST/PREVIOUS + exact version).
 *   5. Result card status, verification posture (VERIFIED_DELIVERABLE, AWAITING_REVIEW, PARTIALLY_VERIFIED, UNVERIFIED), provenance, timestamps, and failed-mission disclosures.
 *   6. Latest-vs-previous document version navigation & multi-hop comparison.
 *   7. PDF, HTML, and JSON exports + S3 ArtifactDelivery signed URLs + PENDING_UPLOAD reconciliation + unconfigured S3 fail-closed (503 NOT_CONFIGURED).
 *   8. Controlled result sharing with SHA-256 hashed capability tokens, DELIVERABLE-only gate, mandatory expiry, sanitization, and immediate revocation.
 *   9. Strict tenant isolation (Workspace Alpha vs Workspace Beta) and RBAC permissions (OWNER, ADMIN, MEMBER, INVITED, REVOKED, unauthenticated).
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import {
  QeyNoxStore,
  artifactObjects,
  claims,
  claimEvidenceLinks,
  commercialOrders,
  connectDatabase,
  events,
  identityMemberships,
  identityUsers,
  identityWorkspaces,
  operations,
  resultDocuments,
  resultShareLinks,
  runMigrations,
  sources,
} from '@qeynox/persistence';
import {
  DomainError,
  newId,
  type ApprovalRequest,
  type ID,
  type Operation,
  type Principal,
  type Source,
  type StepAttempt,
} from '@qeynox/domain';
import {
  CommerceService,
  ResultAssembler,
  ResultDeliveryService,
  compareResultVersions,
  decodeAtlasCursor,
  deriveVerificationPosture,
  encodeAtlasCursor,
  classifyDocument,
  summarizeProvenance,
  type ResultDocument,
} from '@qeynox/application';
import {
  atlasLibraryDetailSchema,
  atlasLibraryPageSchema,
  createdResultShareSchema,
  resultShareSummarySchema,
  sharedAtlasResultViewSchema,
} from '@qeynox/contracts';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) {
    throw new Error('ASSERTION FAILED: ' + message);
  }
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface StoredS3Object {
  readonly content: Buffer;
  readonly contentType: string;
  readonly sha256: string;
}

async function startLocalS3Fixture(): Promise<{
  readonly endpoint: string;
  readonly objects: Map<string, StoredS3Object>;
  readonly close: () => Promise<void>;
}> {
  const objects = new Map<string, StoredS3Object>();
  const server = createServer((req, res) => {
    const rawUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const objectPath = decodeURIComponent(rawUrl.pathname.replace(/^\/+/, ''));
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const content = Buffer.concat(chunks);
        const metaSha =
          typeof req.headers['x-amz-meta-sha256'] === 'string'
            ? req.headers['x-amz-meta-sha256']
            : sha256Hex(content);
        const contentType =
          typeof req.headers['content-type'] === 'string'
            ? req.headers['content-type']
            : 'application/octet-stream';
        objects.set(objectPath, { content, contentType, sha256: metaSha });
        res.writeHead(200, {
          ETag: `"${metaSha.slice(0, 32)}"`,
          'x-amz-version-id': 'v1',
        });
        res.end();
      });
      return;
    }
    if (req.method === 'HEAD') {
      const found = objects.get(objectPath);
      if (!found) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': found.contentType,
        'Content-Length': String(found.content.byteLength),
        'x-amz-meta-sha256': found.sha256,
      });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      // P22 BIS: emulate the real S3 ListObjectsV2 API. The storage layer's authoritative
      // missing-object probe (head → 404 → bucket list check) requires it; without this the
      // fixture could not behave like the S3/MinIO the production client is written against.
      if (rawUrl.searchParams.get('list-type') === '2') {
        const prefix = rawUrl.searchParams.get('prefix') ?? '';
        const requestedMax = Number(rawUrl.searchParams.get('max-keys') ?? '1000');
        const maxKeys = Number.isFinite(requestedMax) && requestedMax >= 0 ? requestedMax : 1000;
        const bucketPrefix = objectPath + '/';
        const matched = [...objects.keys()]
          .filter(key => key.startsWith(bucketPrefix + prefix))
          .sort()
          .slice(0, maxKeys);
        const contents = matched
          .map(key => `<Contents><Key>${key.slice(bucketPrefix.length)}</Key><Size>${objects.get(key)!.content.byteLength}</Size></Contents>`)
          .join('');
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          `<Name>${objectPath}</Name><Prefix>${prefix}</Prefix><KeyCount>${matched.length}</KeyCount>` +
          `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(xml);
        return;
      }
      const found = objects.get(objectPath);
      if (!found) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': found.contentType,
        'Content-Length': String(found.content.byteLength),
      });
      res.end(found.content);
      return;
    }
    res.writeHead(405);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}

async function httpJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    workspaceId?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceId) headers['x-qeynox-workspace'] = options.workspaceId;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function main(): Promise<void> {
  // =========================================================================
  // PART 1 — Pure Derivation, Cursor, Provenance & Version Diff Checks
  // =========================================================================
  console.log('— PART 1: posture derivation, provenance summary, cursor & version comparison —');

  const cursor = encodeAtlasCursor('2026-11-21T10:00:00.000Z', 'doc_alpha_01');
  const decoded = decodeAtlasCursor(cursor);
  check(
    decoded.createdAt === '2026-11-21T10:00:00.000Z' && decoded.id === 'doc_alpha_01',
    'Atlas cursor round-trips cleanly',
  );
  let cursorRejected = false;
  try {
    decodeAtlasCursor('not-valid-base64-json!!!');
  } catch (err) {
    cursorRejected = err instanceof DomainError && err.code === 'INVALID_INPUT';
  }
  check(cursorRejected, 'Malformed pagination cursor fails closed with INVALID_INPUT');

  const baseSyntheticDoc: ResultDocument = {
    id: 'doc_v1' as ID,
    workspaceId: 'ws_1' as ID,
    operationId: 'op_1' as ID,
    revisionId: 'rev_1' as ID,
    version: 1,
    title: 'Market Study v1',
    objective: 'Assess grid capacity',
    scope: ['Morocco'],
    findings: [
      {
        claimId: 'claim_1' as ID,
        statement: 'Installed solar capacity reached 830 MW.',
        status: 'UNVERIFIED',
        sourceIds: ['src_1'],
        attemptId: 'att_1' as ID,
        limitations: ['Awaiting verification'],
        citations: [
          {
            sourceId: 'src_1',
            provider: 'World Bank',
            uri: 'https://api.worldbank.org/v2/country/MAR/indicator/EG.ELC.ACCS.ZS',
            retrievedAt: '2026-11-10T09:00:00.000Z',
          },
        ],
      },
    ],
    nextActions: [],
    limitations: [],
    unresolved: ['claim_1'],
    citations: [
      {
        sourceId: 'src_1',
        provider: 'World Bank',
        uri: 'https://api.worldbank.org/v2/country/MAR/indicator/EG.ELC.ACCS.ZS',
        retrievedAt: '2026-11-10T09:00:00.000Z',
      },
    ],
    createdAt: '2026-11-10T09:05:00.000Z',
    status: 'PARTIAL',
  };

  const v1Class = classifyDocument(baseSyntheticDoc);
  check(
    deriveVerificationPosture(baseSyntheticDoc, v1Class) === 'UNVERIFIED',
    'Document with zero VERIFIED findings never claims PARTIALLY_VERIFIED',
  );

  const partialSyntheticDoc: ResultDocument = {
    ...baseSyntheticDoc,
    id: 'doc_v2' as ID,
    version: 2,
    scope: ['Morocco', 'Spain'],
    findings: [
      {
        ...baseSyntheticDoc.findings[0]!,
        status: 'SUPPORTED',
        limitations: [],
      },
      {
        claimId: 'claim_2' as ID,
        statement: 'Grid interconnect utilization is 74%.',
        status: 'NEEDS_HUMAN_REVIEW',
        sourceIds: ['src_2'],
        attemptId: 'att_1' as ID,
        limitations: ['Requires review'],
        citations: [
          {
            sourceId: 'src_2',
            provider: 'Brave Search',
            uri: 'https://user:secret@example.org/private-report',
            retrievedAt: '2026-11-12T11:00:00.000Z',
          },
        ],
      },
    ],
    createdAt: '2026-11-12T11:05:00.000Z',
    status: 'PARTIAL',
  };

  const v2Class = classifyDocument(partialSyntheticDoc);
  check(
    deriveVerificationPosture(partialSyntheticDoc, v2Class) === 'PARTIALLY_VERIFIED',
    'Document with 1 VERIFIED and 1 UNRESOLVED finding is PARTIALLY_VERIFIED',
  );

  const prov = summarizeProvenance(partialSyntheticDoc);
  check(prov.citationCount === 2, 'Provenance counts deduplicated sources');
  check(
    prov.verifiableCitationCount === 1,
    'Credential-bearing URL is excluded from verifiableCitationCount',
  );
  check(
    prov.providers.join(',') === 'World Bank,Brave Search',
    'Provenance extracts actual providers in order',
  );
  check(
    prov.latestRetrievedAt === '2026-11-12T11:00:00.000Z',
    'Provenance computes latestRetrievedAt',
  );

  const diffForward = compareResultVersions(baseSyntheticDoc, partialSyntheticDoc);
  const diffReverse = compareResultVersions(partialSyntheticDoc, baseSyntheticDoc);
  check(
    diffForward !== null &&
      diffReverse !== null &&
      diffForward.baseVersion === 1 &&
      diffForward.targetVersion === 2 &&
      diffReverse.baseVersion === 1 &&
      diffReverse.targetVersion === 2,
    'Version comparison always orients base = older version, target = newer version',
  );
  check(diffForward.verifiedDelta === 1, 'Version comparison tracks +1 verified finding');
  check(diffForward.changedFindings.length === 1, 'Version comparison detects status upgrade on claim_1');
  check(diffForward.addedFindings.length === 1, 'Version comparison detects added claim_2');
  check(diffForward.scopeAdded.includes('Spain'), 'Version comparison detects added scope item');

  console.log(`  PART 1 PASSED: ${assertions} assertions`);

  // =========================================================================
  // PART 2 — Isolated PostgreSQL, HTTP API, Pagination, Exports, Sharing & RBAC
  // =========================================================================
  console.log('— PART 2: isolated DB, search, filters, pagination, exports, sharing & tenant RBAC —');

  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  delete process.env.QEYNOX_ARTIFACT_ACCESS_KEY;
  delete process.env.QEYNOX_ARTIFACT_SECRET_KEY;
  delete process.env.QEYNOX_ARTIFACT_BUCKET;
  delete process.env.QEYNOX_SERVICE_CATALOG_PATH;

  let connection: ReturnType<typeof connectDatabase> | undefined;
  let appUnconfigured: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  let appWithS3: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  let s3Fixture: Awaited<ReturnType<typeof startLocalS3Fixture>> | undefined;

  try {
    const migrationReport = await runMigrations(qa.url);
    check(
      migrationReport.applied.includes('0025_atlas_library_shares.sql') ||
        migrationReport.skipped.includes('0025_atlas_library_shares.sql'),
      'Migration 0025_atlas_library_shares.sql applied cleanly',
    );

    connection = connectDatabase(qa.url);
    const store = new QeyNoxStore(connection.db);

    // Verify result_share_links has NO document JSON payload column (no second result store!)
    const shareColumns = await connection.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'result_share_links' ORDER BY column_name`,
    );
    const colNames = shareColumns.rows.map(r => r.column_name);
    check(
      colNames.includes('document_id') &&
        colNames.includes('token_hash') &&
        !colNames.includes('document') &&
        !colNames.includes('payload') &&
        !colNames.includes('content'),
      'result_share_links stores only governance metadata and never duplicates ResultDocument content',
    );

    // Boot real NestJS HTTP app (first with S3 unconfigured to prove 503 fail-closed)
    appUnconfigured = await NestFactory.create(AppModule, { logger: false });
    appUnconfigured.useGlobalFilters(new DomainExceptionFilter());
    await appUnconfigured.listen(0, '127.0.0.1');
    const addr1 = appUnconfigured.getHttpServer().address() as AddressInfo;
    const baseUrl1 = `http://127.0.0.1:${addr1.port}`;
    const authService = appUnconfigured.get(AuthService);

    // Seed Workspace Alpha (OWNER, ADMIN, MEMBER, INVITED, REVOKED) & Workspace Beta (OWNER)
    const wsAlphaId = ('ws_alpha_' + randomUUID().slice(0, 8)) as ID;
    const wsBetaId = ('ws_beta_' + randomUUID().slice(0, 8)) as ID;
    const alphaOwnerId = ('usr_alpha_owner_' + randomUUID().slice(0, 8)) as ID;
    const alphaAdminId = ('usr_alpha_admin_' + randomUUID().slice(0, 8)) as ID;
    const alphaMemberId = ('usr_alpha_member_' + randomUUID().slice(0, 8)) as ID;
    const alphaInvitedId = ('usr_alpha_invited_' + randomUUID().slice(0, 8)) as ID;
    const alphaRevokedId = ('usr_alpha_revoked_' + randomUUID().slice(0, 8)) as ID;
    const betaOwnerId = ('usr_beta_owner_' + randomUUID().slice(0, 8)) as ID;

    await connection.db.insert(identityUsers).values([
      { id: alphaOwnerId, email: 'owner@alpha.invalid' },
      { id: alphaAdminId, email: 'admin@alpha.invalid' },
      { id: alphaMemberId, email: 'member@alpha.invalid' },
      { id: alphaInvitedId, email: 'invited@alpha.invalid' },
      { id: alphaRevokedId, email: 'revoked@alpha.invalid' },
      { id: betaOwnerId, email: 'owner@beta.invalid' },
    ]);
    await connection.db.insert(identityWorkspaces).values([
      { id: wsAlphaId, name: 'Alpha Strategy Group', createdBy: alphaOwnerId },
      { id: wsBetaId, name: 'Beta Capital Partners', createdBy: betaOwnerId },
    ]);
    await connection.db.insert(identityMemberships).values([
      { id: randomUUID(), userId: alphaOwnerId, workspaceId: wsAlphaId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: alphaAdminId, workspaceId: wsAlphaId, role: 'ADMIN', status: 'ACTIVE' },
      { id: randomUUID(), userId: alphaMemberId, workspaceId: wsAlphaId, role: 'MEMBER', status: 'ACTIVE' },
      { id: randomUUID(), userId: alphaInvitedId, workspaceId: wsAlphaId, role: 'MEMBER', status: 'INVITED' },
      { id: randomUUID(), userId: alphaRevokedId, workspaceId: wsAlphaId, role: 'ADMIN', status: 'REVOKED' },
      { id: randomUUID(), userId: betaOwnerId, workspaceId: wsBetaId, role: 'OWNER', status: 'ACTIVE' },
    ]);

    const ownerSession = await authService.issueSession(alphaOwnerId, wsAlphaId);
    const adminSession = await authService.issueSession(alphaAdminId, wsAlphaId);
    const memberSession = await authService.issueSession(alphaMemberId, wsAlphaId);
    const betaOwnerSession = await authService.issueSession(betaOwnerId, wsBetaId);

    // INVITED and REVOKED memberships cannot issue sessions
    let invitedDenied = false;
    try {
      await authService.issueSession(alphaInvitedId, wsAlphaId);
    } catch (err) {
      invitedDenied = err instanceof DomainError && err.code === 'DENIED';
    }
    check(invitedDenied, 'INVITED user cannot issue a workspace session');

    let revokedDenied = false;
    try {
      await authService.issueSession(alphaRevokedId, wsAlphaId);
    } catch (err) {
      revokedDenied = err instanceof DomainError && err.code === 'DENIED';
    }
    check(revokedDenied, 'REVOKED user cannot issue a workspace session');

    // Unauthenticated call to /v1/results is denied
    const unauthRes = await httpJson(baseUrl1, '/v1/results');
    check(unauthRes.status === 403, 'Unauthenticated GET /v1/results returns 403 DENIED');

    // Empty workspace state
    const emptyRes = await httpJson(baseUrl1, '/v1/results', {
      token: ownerSession.token,
      workspaceId: wsAlphaId,
    });
    check(emptyRes.status === 200, 'Authenticated GET /v1/results on empty workspace returns 200');
    const emptyPage = atlasLibraryPageSchema.parse(emptyRes.body);
    check(
      emptyPage.items.length === 0 &&
        emptyPage.totalCount === 0 &&
        emptyPage.workspaceDocumentCount === 0 &&
        emptyPage.failedOperations.length === 0 &&
        emptyPage.artifactStoreConfigured === false &&
        emptyPage.canManageShares === true,
      'Empty workspace response is truthful and reports artifactStoreConfigured=false',
    );

    // Seed Workspace Alpha operations & versioned ResultDocuments
    const alphaOwnerPrincipal: Principal = {
      userId: alphaOwnerId,
      workspaceId: wsAlphaId,
      roles: ['OWNER'],
    };
    const betaOwnerPrincipal: Principal = {
      userId: betaOwnerId,
      workspaceId: wsBetaId,
      roles: ['OWNER'],
    };

    const assembler = new ResultAssembler(store);
    const delivery = new ResultDeliveryService(store);

    // Mission 1: 4 versions (v1 DRAFT -> v2 PARTIAL -> v3 READY_FOR_REVIEW -> v4 DELIVERABLE)
    const op1 = await store.createOperation(
      alphaOwnerPrincipal,
      'Morocco Solar Grid Benchmark',
      'Benchmark solar industrial power metrics across Morocco',
      ['Use public indicators only'],
    );
    const rev1Id = newId();
    await store.savePlan(
      alphaOwnerPrincipal,
      op1.id,
      { id: newId(), operationId: op1.id, latestRevision: 1, createdAt: '2026-11-10T08:00:00.000Z' },
      {
        id: rev1Id,
        planId: newId(),
        operationId: op1.id,
        revision: 1,
        reason: 'Initial plan',
        createdBy: alphaOwnerId,
        createdAt: '2026-11-10T08:00:00.000Z',
        status: 'ACTIVE',
      },
      [
        {
          id: newId(),
          operationId: op1.id,
          planRevisionId: rev1Id,
          ordinal: 1,
          title: 'Collect WDI energy access',
          description: 'Fetch WDI indicator',
          capabilityId: 'cap_1' as ID,
          dependsOn: [],
          state: 'COMPLETED',
          intent: 'RESEARCH',
          version: 1,
        },
      ],
    );
    const att1: StepAttempt = {
      id: newId(),
      workStepId: newId(),
      planRevisionId: rev1Id,
      operationId: op1.id,
      sequence: 1,
      state: 'COMPLETED',
      createdAt: '2026-11-10T08:10:00.000Z',
      version: 1,
    };
    await store.putStepAttempt(att1);
    await connection.db
      .update(operations)
      .set({ currentRevisionId: rev1Id, payload: { ...op1, currentRevisionId: rev1Id } })
      .where(eq(operations.id, op1.id));

    // v1: DRAFT (0 findings)
    const op1v1 = await assembler.assemble(
      alphaOwnerPrincipal,
      op1.id,
      rev1Id,
      'Morocco Solar Grid Benchmark — Draft',
      ['Morocco'],
      ['Gather primary WDI series'],
    );
    await connection.db
      .update(resultDocuments)
      .set({
        createdAt: '2026-11-10T10:00:00.000Z',
        document: { ...op1v1, createdAt: '2026-11-10T10:00:00.000Z' } as unknown as Record<string, unknown>,
      })
      .where(eq(resultDocuments.id, op1v1.id));

    // Add source + UNVERIFIED claim -> v2 PARTIAL
    const srcWb: Source = {
      id: newId(),
      workspaceId: wsAlphaId,
      operationId: op1.id,
      provider: 'World Bank Open Data',
      title: 'Access to electricity (% of population) - Morocco',
      uri: 'https://api.worldbank.org/v2/country/MAR/indicator/EG.ELC.ACCS.ZS?format=json',
      retrievedAt: '2026-11-12T09:30:00.000Z',
      sourcePublishedAt: '2025-12-01T00:00:00.000Z',
      fingerprint: sha256Hex('wb-mar-100'),
    };
    await store.recordSource(srcWb);
    const claimSolarId = newId();
    await connection.db.insert(claims).values({
      id: claimSolarId,
      workspaceId: wsAlphaId,
      operationId: op1.id,
      attemptId: att1.id,
      statement: 'Morocco grid electrification rate reached 100% in World Bank WDI series.',
      kind: 'FACT',
      status: 'UNVERIFIED',
      createdAt: '2026-11-12T09:31:00.000Z',
    });
    await connection.db.insert(claimEvidenceLinks).values({
      id: newId(),
      claimId: claimSolarId,
      sourceId: srcWb.id,
      relationship: 'SUPPORTS',
      addedAt: '2026-11-12T09:32:00.000Z',
    });

    const op1v2 = await assembler.assemble(
      alphaOwnerPrincipal,
      op1.id,
      rev1Id,
      'Morocco Solar Grid Benchmark — Partial',
      ['Morocco'],
      ['Verify WDI claim'],
    );
    await connection.db
      .update(resultDocuments)
      .set({
        createdAt: '2026-11-12T10:00:00.000Z',
        document: { ...op1v2, createdAt: '2026-11-12T10:00:00.000Z' } as unknown as Record<string, unknown>,
      })
      .where(eq(resultDocuments.id, op1v2.id));

    // Upgrade claim to SUPPORTED -> v3 READY_FOR_REVIEW
    await connection.db
      .update(claims)
      .set({ status: 'SUPPORTED' })
      .where(eq(claims.id, claimSolarId));

    const op1v3 = await assembler.assemble(
      alphaOwnerPrincipal,
      op1.id,
      rev1Id,
      'Morocco Solar Grid Benchmark — Review Candidate',
      ['Morocco', 'Industrial tariffs'],
      ['Approve delivery'],
    );
    await connection.db
      .update(resultDocuments)
      .set({
        createdAt: '2026-11-15T10:00:00.000Z',
        document: { ...op1v3, createdAt: '2026-11-15T10:00:00.000Z' } as unknown as Record<string, unknown>,
      })
      .where(eq(resultDocuments.id, op1v3.id));

    // Deliver v3 -> v4 DELIVERABLE through real ResultDeliveryService
    const op1Current = await store.getOperation(alphaOwnerPrincipal, op1.id);
    const op1Waiting: Operation = {
      ...op1Current,
      status: 'WAITING_APPROVAL',
      currentRevisionId: rev1Id,
      version: op1Current.version + 1,
      lastActivityAt: '2026-11-18T10:00:00.000Z',
    };
    await connection.db
      .update(operations)
      .set({
        status: 'WAITING_APPROVAL',
        version: op1Waiting.version,
        currentRevisionId: rev1Id,
        lastActivityAt: op1Waiting.lastActivityAt,
        payload: op1Waiting,
      })
      .where(eq(operations.id, op1.id));

    await connection.db.insert(commercialOrders).values({
      id: newId(),
      workspaceId: wsAlphaId,
      operationId: op1.id,
      revisionId: rev1Id,
      quoteId: newId(),
      state: 'AUTHORIZED',
      amountMinor: 0,
      currency: 'EUR',
      createdAt: '2026-11-18T10:02:00.000Z',
      updatedAt: '2026-11-18T10:02:00.000Z',
    });

    const approvalId = newId();
    const approval: ApprovalRequest = {
      id: approvalId,
      operationId: op1.id,
      planRevisionId: rev1Id,
      stepAttemptId: att1.id,
      workspaceId: wsAlphaId,
      purpose: 'RESULT_REVIEW',
      status: 'APPROVED',
      requestedAt: '2026-11-18T10:05:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      decidedBy: alphaOwnerId,
      decidedAt: '2026-11-18T10:06:00.000Z',
    };
    await store.putApproval(approval);

    const delivered = await delivery.deliver(alphaOwnerPrincipal, op1.id, op1v3.id, approvalId);
    const op1v4Id = delivered.documentId;
    const op1v4Doc = await assembler.get(alphaOwnerPrincipal, op1.id, op1v4Id);
    await connection.db
      .update(resultDocuments)
      .set({
        createdAt: '2026-11-18T12:00:00.000Z',
        document: { ...op1v4Doc, createdAt: '2026-11-18T12:00:00.000Z' } as unknown as Record<string, unknown>,
      })
      .where(eq(resultDocuments.id, op1v4Id));

    // Mission 2: 2 versions (v1 DRAFT -> v2 PARTIAL with 1 VERIFIED + 1 UNRESOLVED -> PARTIALLY_VERIFIED)
    const op2 = await store.createOperation(
      alphaOwnerPrincipal,
      'EU Battery Supply Chain Risk',
      'Evaluate lithium refining bottlenecks in Europe',
      [],
    );
    const rev2Id = newId();
    await store.savePlan(
      alphaOwnerPrincipal,
      op2.id,
      { id: newId(), operationId: op2.id, latestRevision: 1, createdAt: '2026-11-14T08:00:00.000Z' },
      {
        id: rev2Id,
        planId: newId(),
        operationId: op2.id,
        revision: 1,
        reason: 'Initial battery plan',
        createdBy: alphaOwnerId,
        createdAt: '2026-11-14T08:00:00.000Z',
        status: 'ACTIVE',
      },
      [],
    );
    const att2: StepAttempt = {
      id: newId(),
      workStepId: newId(),
      planRevisionId: rev2Id,
      operationId: op2.id,
      sequence: 1,
      state: 'COMPLETED',
      createdAt: '2026-11-14T08:10:00.000Z',
      version: 1,
    };
    await store.putStepAttempt(att2);
    await connection.db
      .update(operations)
      .set({ currentRevisionId: rev2Id, payload: { ...op2, currentRevisionId: rev2Id } })
      .where(eq(operations.id, op2.id));

    const op2v1 = await assembler.assemble(
      alphaOwnerPrincipal,
      op2.id,
      rev2Id,
      'EU Battery Supply Chain Risk — Draft',
      ['European Union'],
      [],
    );
    await connection.db
      .update(resultDocuments)
      .set({
        createdAt: '2026-11-14T09:00:00.000Z',
        document: { ...op2v1, createdAt: '2026-11-14T09:00:00.000Z' } as unknown as Record<string, unknown>,
      })
      .where(eq(resultDocuments.id, op2v1.id));

    const srcBrave: Source = {
      id: newId(),
      workspaceId: wsAlphaId,
      operationId: op2.id,
      provider: 'Brave Search',
      title: 'EU Critical Raw Materials Act refining targets',
      uri: 'https://commission.europa.eu/strategy/critical-raw-materials',
      retrievedAt: '2026-11-16T14:00:00.000Z',
      fingerprint: sha256Hex('brave-eu-crma'),
    };
    await store.recordSource(srcBrave);
    const claimBatSupported = newId();
    const claimBatUnresolved = newId();
    await connection.db.insert(claims).values([
      {
        id: claimBatSupported,
        workspaceId: wsAlphaId,
        operationId: op2.id,
        attemptId: att2.id,
        statement: 'EU CRMA sets a 40% domestic processing benchmark by 2030.',
        kind: 'FACT',
        status: 'SUPPORTED',
        createdAt: '2026-11-16T14:05:00.000Z',
      },
      {
        id: claimBatUnresolved,
        workspaceId: wsAlphaId,
        operationId: op2.id,
        attemptId: att2.id,
        statement: 'Refinery permitting lead time in Iberia averages 19 months.',
        kind: 'FACT',
        status: 'CONFLICTING',
        createdAt: '2026-11-16T14:06:00.000Z',
      },
    ]);
    await connection.db.insert(claimEvidenceLinks).values({
      id: newId(),
      claimId: claimBatSupported,
      sourceId: srcBrave.id,
      relationship: 'SUPPORTS',
      addedAt: '2026-11-16T14:07:00.000Z',
    });

    const op2v2 = await assembler.assemble(
      alphaOwnerPrincipal,
      op2.id,
      rev2Id,
      'EU Battery Supply Chain Risk — Partial Assessment',
      ['European Union'],
      ['Resolve permitting conflict'],
    );
    await connection.db
      .update(resultDocuments)
      .set({
        createdAt: '2026-11-16T15:00:00.000Z',
        document: { ...op2v2, createdAt: '2026-11-16T15:00:00.000Z' } as unknown as Record<string, unknown>,
      })
      .where(eq(resultDocuments.id, op2v2.id));

    // Mission 3: FAILED mission with zero ResultDocuments
    const op3Failed = await store.createOperation(
      alphaOwnerPrincipal,
      'APAC Semiconductor Tariff Scan',
      'Collect tariff schedules across APAC',
      [],
    );
    const failedPayload: Operation = {
      ...op3Failed,
      status: 'FAILED',
      version: 2,
      lastActivityAt: '2026-11-19T08:00:00.000Z',
      lastErrorCode: 'CONNECTOR_TIMEOUT',
    };
    await connection.db
      .update(operations)
      .set({
        status: 'FAILED',
        version: 2,
        lastActivityAt: failedPayload.lastActivityAt,
        payload: failedPayload,
      })
      .where(eq(operations.id, op3Failed.id));

    // Workspace Beta: Confidential document (must NEVER leak to Alpha!)
    const betaOp = await store.createOperation(
      betaOwnerPrincipal,
      'Beta Confidential Acquisition Target',
      'Private valuation memo for Beta Corp',
      [],
    );
    const betaRevId = newId();
    await store.savePlan(
      betaOwnerPrincipal,
      betaOp.id,
      { id: newId(), operationId: betaOp.id, latestRevision: 1, createdAt: '2026-11-17T10:00:00.000Z' },
      {
        id: betaRevId,
        planId: newId(),
        operationId: betaOp.id,
        revision: 1,
        reason: 'Beta plan',
        createdBy: betaOwnerId,
        createdAt: '2026-11-17T10:00:00.000Z',
        status: 'ACTIVE',
      },
      [],
    );
    const betaDoc: ResultDocument = {
      id: newId(),
      workspaceId: wsBetaId,
      operationId: betaOp.id,
      revisionId: betaRevId,
      version: 1,
      title: 'Beta Top Secret Valuation Deliverable',
      objective: 'Confidential target valuation',
      scope: ['Private'],
      findings: [
        {
          claimId: newId(),
          statement: 'Beta target EBITDA multiple is 11.2x.',
          status: 'SUPPORTED',
          sourceIds: ['beta_src'],
          attemptId: newId(),
          limitations: [],
          citations: [
            {
              sourceId: 'beta_src',
              provider: 'Beta Filing',
              uri: 'https://sec.gov/Archives/edgar/data/beta',
              retrievedAt: '2026-11-17T10:05:00.000Z',
            },
          ],
        },
      ],
      nextActions: [],
      limitations: [],
      unresolved: [],
      citations: [
        {
          sourceId: 'beta_src',
          provider: 'Beta Filing',
          uri: 'https://sec.gov/Archives/edgar/data/beta',
          retrievedAt: '2026-11-17T10:05:00.000Z',
        },
      ],
      createdAt: '2026-11-17T11:00:00.000Z',
      status: 'DELIVERABLE',
      reviewedBy: betaOwnerId,
      reviewedAt: '2026-11-17T11:05:00.000Z',
    };
    await connection.db.insert(resultDocuments).values({
      id: betaDoc.id,
      workspaceId: wsBetaId,
      operationId: betaOp.id,
      revisionId: betaRevId,
      version: 1,
      state: 'DELIVERABLE',
      document: betaDoc as unknown as Record<string, unknown>,
      createdAt: betaDoc.createdAt,
    });

    // ── Server-side Cursor Pagination (limit=2 across all 6 Alpha versions) ──
    const walkedIds: string[] = [];
    let nextCur: string | null = null;
    let pageCalls = 0;
    do {
      pageCalls++;
      const qs = nextCur ? `?limit=2&cursor=${encodeURIComponent(nextCur)}` : '?limit=2';
      const res = await httpJson(baseUrl1, `/v1/results${qs}`, {
        token: ownerSession.token,
        workspaceId: wsAlphaId,
      });
      check(res.status === 200, `Paginated GET /v1/results page ${pageCalls} returns 200`);
      const parsed = atlasLibraryPageSchema.parse(res.body);
      check(parsed.totalCount === 6, 'Paginated totalCount stays 6 across all pages');
      check(parsed.workspaceDocumentCount === 6, 'workspaceDocumentCount is 6');
      for (const item of parsed.items) {
        check(!walkedIds.includes(item.id), `No duplicate document ID ${item.id} across pages`);
        walkedIds.push(item.id);
      }
      nextCur = parsed.nextCursor;
    } while (nextCur !== null && pageCalls < 10);

    check(walkedIds.length === 6 && pageCalls === 3, 'Walked all 6 Alpha versions in 3 pages of 2');
    check(
      walkedIds[0] === op1v4Id && walkedIds[5] === op1v1.id,
      'Pagination orders newest-first (op1v4 first, op1v1 last)',
    );
    check(!walkedIds.includes(betaDoc.id), 'Zero Workspace Beta documents appeared in Alpha pagination');

    // Invalid cursor over HTTP -> 400
    const badCursorRes = await httpJson(baseUrl1, '/v1/results?cursor=tampered!!!', {
      token: ownerSession.token,
      workspaceId: wsAlphaId,
    });
    check(badCursorRes.status === 400, 'Tampered cursor returns 400 INVALID_INPUT');

    // ── Server-side Search & Wildcard Safety ──
    const searchSolar = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?q=Solar', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(searchSolar.totalCount === 4, 'Search q=Solar matches the 4 versions of Mission 1');

    const searchProvider = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?q=Brave%20Search', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(searchProvider.totalCount === 1, 'Search q=Brave Search matches op2v2 by citation provider');

    const searchPercentLiteral = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, `/v1/results?q=${encodeURIComponent('100%')}`, {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      searchPercentLiteral.totalCount === 3,
      'Search q=100% escapes % wildcard and matches only the 3 versions containing literal "100%"',
    );

    const searchConfidential = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?q=Confidential', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      searchConfidential.totalCount === 0,
      'Cross-tenant search for Beta keyword returns 0 results in Alpha',
    );

    // ── Filters: Mission, State, Mission Status, Date Range & Version ──
    const byMission2 = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, `/v1/results?operationId=${op2.id}`, {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(byMission2.totalCount === 2, 'Filter by operationId=op2 returns 2 versions');

    const byDeliverable = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?state=DELIVERABLE', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      byDeliverable.totalCount === 1 &&
        byDeliverable.items[0]?.id === op1v4Id &&
        byDeliverable.items[0]?.verificationPosture === 'VERIFIED_DELIVERABLE',
      'Filter state=DELIVERABLE returns op1v4 with VERIFIED_DELIVERABLE posture',
    );

    const byPartial = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?state=PARTIAL', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(byPartial.totalCount === 2, 'Filter state=PARTIAL returns op1v2 and op2v2');
    const op2v2Card = byPartial.items.find(i => i.id === op2v2.id);
    check(
      op2v2Card?.verificationPosture === 'PARTIALLY_VERIFIED' &&
        op2v2Card.counts.VERIFIED === 1 &&
        op2v2Card.counts.UNRESOLVED === 1,
      'op2v2 card reports PARTIALLY_VERIFIED with 1 verified and 1 unresolved finding',
    );
    const op1v2Card = byPartial.items.find(i => i.id === op1v2.id);
    check(
      op1v2Card?.verificationPosture === 'UNVERIFIED' &&
        op1v2Card.counts.AWAITING_ASSESSMENT === 1,
      'op1v2 card reports UNVERIFIED when 0 findings are verified',
    );

    const byFailedOp = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?operationStatus=FAILED', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      byFailedOp.items.length === 0 &&
        byFailedOp.failedOperations.length === 1 &&
        byFailedOp.failedOperations[0]?.operationId === op3Failed.id &&
        byFailedOp.failedOperations[0]?.lastErrorCode === 'CONNECTOR_TIMEOUT',
      'Failed mission without ResultDocument is surfaced honestly in failedOperations',
    );

    const byDateRange = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?from=2026-11-15&to=2026-11-18', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      byDateRange.totalCount === 3,
      'UTC date range 2026-11-15..2026-11-18 returns op1v3, op2v2, op1v4',
    );

    const invertedDateRes = await httpJson(
      baseUrl1,
      '/v1/results?from=2026-11-20&to=2026-11-10',
      { token: ownerSession.token, workspaceId: wsAlphaId },
    );
    check(invertedDateRes.status === 400, 'Inverted date range from > to returns 400 INVALID_INPUT');

    const latestOnly = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?versionScope=LATEST', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      latestOnly.totalCount === 2 &&
        latestOnly.items.every(i => i.isLatestVersion) &&
        latestOnly.items.some(i => i.id === op1v4Id) &&
        latestOnly.items.some(i => i.id === op2v2.id),
      'versionScope=LATEST returns exactly the latest version per mission (op1v4 and op2v2)',
    );

    const previousOnly = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?versionScope=PREVIOUS', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      previousOnly.totalCount === 4 && previousOnly.items.every(i => !i.isLatestVersion),
      'versionScope=PREVIOUS returns only the 4 superseded versions',
    );

    const exactV2 = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl1, '/v1/results?version=2', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      exactV2.totalCount === 2 && exactV2.items.every(i => i.version === 2),
      'version=2 returns exact version 2 documents across missions',
    );

    // ── Latest-vs-Previous Navigation & Version Comparison ──
    const v4Detail = atlasLibraryDetailSchema.parse(
      (
        await httpJson(baseUrl1, `/v1/results/${op1v4Id}`, {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      v4Detail.isLatestVersion === true &&
        v4Detail.previousVersionDocumentId === op1v3.id &&
        v4Detail.nextVersionDocumentId === null &&
        v4Detail.versions.length === 4,
      'Latest version detail exposes full 4-version history and previousVersionDocumentId=v3',
    );
    check(
      v4Detail.comparison !== null &&
        v4Detail.comparison.baseVersion === 3 &&
        v4Detail.comparison.targetVersion === 4 &&
        v4Detail.comparison.baseStatus === 'READY_FOR_REVIEW' &&
        v4Detail.comparison.targetStatus === 'DELIVERABLE' &&
        v4Detail.comparison.statusChanged === true,
      'Default comparison on v4 diffs v3 READY_FOR_REVIEW -> v4 DELIVERABLE',
    );

    const v2Detail = atlasLibraryDetailSchema.parse(
      (
        await httpJson(baseUrl1, `/v1/results/${op1v2.id}`, {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      v2Detail.isLatestVersion === false &&
        v2Detail.latestDocumentId === op1v4Id &&
        v2Detail.previousVersionDocumentId === op1v1.id &&
        v2Detail.nextVersionDocumentId === op1v3.id,
      'Historical version v2 exposes previous (v1), newer (v3), and latest (v4) pointers',
    );

    const multiHopDetail = atlasLibraryDetailSchema.parse(
      (
        await httpJson(baseUrl1, `/v1/results/${op1v4Id}?compareWith=${op1v1.id}`, {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      multiHopDetail.comparison !== null &&
        multiHopDetail.comparison.baseVersion === 1 &&
        multiHopDetail.comparison.targetVersion === 4 &&
        multiHopDetail.comparison.verifiedDelta === 1 &&
        multiHopDetail.comparison.addedFindings.length === 1,
      'Explicit compareWith=v1 computes multi-hop v1 DRAFT -> v4 DELIVERABLE delta',
    );

    // ── Unconfigured S3 Export Fail-Closed (503 NOT_CONFIGURED) ──
    const unconfExportRes = await httpJson(
      baseUrl1,
      `/v1/operations/${op1.id}/documents/${op1v4Id}/export/pdf`,
      {
        method: 'POST',
        token: ownerSession.token,
        workspaceId: wsAlphaId,
      },
    );
    check(
      unconfExportRes.status === 503,
      'Export fails closed with 503 NOT_CONFIGURED when S3 artifact store is absent',
    );

    await appUnconfigured.close();
    appUnconfigured = undefined;

    // ── Boot NestJS with Real S3ArtifactStore against Local S3 HTTP Fixture ──
    s3Fixture = await startLocalS3Fixture();
    process.env.QEYNOX_ARTIFACT_ENDPOINT = s3Fixture.endpoint;
    process.env.QEYNOX_ARTIFACT_BUCKET = 'qeynox-qa-atlas';
    process.env.QEYNOX_ARTIFACT_REGION = 'us-east-1';
    process.env.QEYNOX_ARTIFACT_ACCESS_KEY = 'qa-access-key';
    process.env.QEYNOX_ARTIFACT_SECRET_KEY = 'qa-secret-key';
    process.env.QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION = 'false';

    appWithS3 = await NestFactory.create(AppModule, { logger: false });
    appWithS3.useGlobalFilters(new DomainExceptionFilter());
    await appWithS3.listen(0, '127.0.0.1');
    const addr2 = appWithS3.getHttpServer().address() as AddressInfo;
    const baseUrl2 = `http://127.0.0.1:${addr2.port}`;

    // P22 BIS: capture the exact bytes and digest of each successful export. The reconciliation
    // seed below must be byte-identical to what the export produced, not a lookup by content type.
    let exportedJsonBytes: Buffer | undefined;
    let exportedJsonSha: string | undefined;
    for (const fmt of ['pdf', 'html', 'json'] as const) {
      const expRes = await httpJson(
        baseUrl2,
        `/v1/operations/${op1.id}/documents/${op1v4Id}/export/${fmt}`,
        {
          method: 'POST',
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        },
      );
      check(expRes.status === 201, `POST export/${fmt} succeeds with 201`);
      const expBody = expRes.body as { artifactId: string; sha256: string };
      const grantRes = await httpJson(
        baseUrl2,
        `/v1/operations/${op1.id}/documents/${op1v4Id}/artifacts/${expBody.artifactId}`,
        {
          token: memberSession.token, // Workspace MEMBER can download internal workspace artifacts!
          workspaceId: wsAlphaId,
        },
      );
      check(grantRes.status === 200, `Workspace MEMBER can request signed S3 URL for ${fmt}`);
      const grantUrl = (grantRes.body as { url: string }).url;
      check(
        grantUrl.startsWith(s3Fixture.endpoint) &&
          grantUrl.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256') &&
          grantUrl.includes('X-Amz-Expires=180'),
        `Signed URL for ${fmt} is a real AWS SigV4 180s presigned read URL`,
      );
      const downloaded = Buffer.from(await (await fetch(grantUrl)).arrayBuffer());
      check(
        sha256Hex(downloaded) === expBody.sha256,
        `Downloaded ${fmt} bytes over presigned S3 URL match SHA-256 digest`,
      );
      if (fmt === 'json') {
        exportedJsonBytes = downloaded;
        exportedJsonSha = expBody.sha256;
      }
    }
    check(
      Boolean(exportedJsonBytes && exportedJsonSha && exportedJsonBytes.byteLength > 0 && exportedJsonSha === sha256Hex(exportedJsonBytes)),
      'exact JSON export bytes and digest captured for the reconciliation seed',
    );

    // Verify stored PDF bytes in S3 start with %PDF-1.
    const pdfEntry = [...s3Fixture.objects.values()].find(o => o.contentType === 'application/pdf');
    check(
      Boolean(pdfEntry && pdfEntry.content.subarray(0, 7).toString('latin1') === '%PDF-1.'),
      'Stored S3 PDF artifact is a real PDF document',
    );

    // Insert a PENDING_UPLOAD row backed by the EXACT bytes, digest and document version of the
    // successful JSON export (P22 BIS): reconciliation re-derives exportJson(document) and
    // digest-compares, so the seed must be byte-identical to what the export produced.
    const pendingRowId = newId();
    const pendingKey = `workspaces/${wsAlphaId}/operations/${op1.id}/results/${op1v4Id}/${pendingRowId}.json`;
    s3Fixture.objects.set(`qeynox-qa-atlas/${pendingKey}`, {
      content: exportedJsonBytes!,
      contentType: 'application/json',
      sha256: exportedJsonSha!,
    });
    await connection.db.insert(artifactObjects).values({
      id: pendingRowId,
      documentId: op1v4Id,
      workspaceId: wsAlphaId,
      operationId: op1.id,
      key: pendingKey,
      sha256: exportedJsonSha!,
      contentType: 'application/json',
      size: exportedJsonBytes!.byteLength,
      state: 'PENDING_UPLOAD',
      createdAt: '2026-11-18T12:30:00.000Z',
    });

    const withPendingPage = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl2, '/v1/results?state=DELIVERABLE', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      withPendingPage.artifactStoreConfigured === true &&
        withPendingPage.items[0]?.availableExports.join(',') === 'pdf,html,json' &&
        withPendingPage.items[0]?.pendingExportCount === 2,
      `Library card surfaces availableExports=[pdf,html,json] AND pendingExportCount=2 (1 from unconfigured write-ahead + 1 seeded)`,
    );

    const reconcileRes = await httpJson(
      baseUrl2,
      `/v1/operations/${op1.id}/documents/reconcile`,
      {
        method: 'POST',
        token: ownerSession.token,
        workspaceId: wsAlphaId,
      },
    );
    const reconcileBody = reconcileRes.body as {
      recovered: string[];
      pending: string[];
      conflicts: string[];
    };
    check(reconcileRes.status === 201, 'POST /reconcile responds 201');
    check(reconcileBody.recovered.includes(pendingRowId), 'reconcile recovers the seeded S3-backed PENDING_UPLOAD artifact (recovered=' + JSON.stringify(reconcileBody.recovered) + ', conflicts=' + JSON.stringify(reconcileBody.conflicts) + ')');
    check(reconcileBody.recovered.length === 2, 'reconcile recovers exactly 2 artifacts (recovered=' + JSON.stringify(reconcileBody.recovered) + ', pending=' + JSON.stringify(reconcileBody.pending) + ', conflicts=' + JSON.stringify(reconcileBody.conflicts) + ')');
    check(reconcileBody.conflicts.length === 0, 'reconcile reports no conflicts (conflicts=' + JSON.stringify(reconcileBody.conflicts) + ')');

    const afterReconcilePage = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl2, '/v1/results?state=DELIVERABLE', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      afterReconcilePage.items[0]?.pendingExportCount === 0,
      'After reconciliation, pendingExportCount drops to 0',
    );

    // ── P22 BIS · negative case: mismatched bytes are rejected, never promoted ──────────────────
    // A PENDING_UPLOAD row whose recorded bytes/digest do not match the deterministic re-export
    // is a conflict: it stays PENDING_UPLOAD and its stored object is never overwritten.
    const mismatchRowId = newId();
    const mismatchKey = `workspaces/${wsAlphaId}/operations/${op1.id}/results/${op1v4Id}/${mismatchRowId}.json`;
    const mismatchBytes = Buffer.from('QeyNox QA mismatched artifact bytes ' + randomUUID());
    const mismatchSha = sha256Hex(mismatchBytes);
    s3Fixture.objects.set(`qeynox-qa-atlas/${mismatchKey}`, {
      content: mismatchBytes,
      contentType: 'application/json',
      sha256: mismatchSha,
    });
    await connection.db.insert(artifactObjects).values({
      id: mismatchRowId,
      documentId: op1v4Id,
      workspaceId: wsAlphaId,
      operationId: op1.id,
      key: mismatchKey,
      sha256: mismatchSha,
      contentType: 'application/json',
      size: mismatchBytes.byteLength,
      state: 'PENDING_UPLOAD',
      createdAt: '2026-11-18T12:31:00.000Z',
    });
    const mismatchReconcileRes = await httpJson(
      baseUrl2,
      `/v1/operations/${op1.id}/documents/reconcile`,
      {
        method: 'POST',
        token: ownerSession.token,
        workspaceId: wsAlphaId,
      },
    );
    const mismatchReconcileBody = mismatchReconcileRes.body as {
      recovered: string[];
      pending: string[];
      conflicts: string[];
    };
    check(
      mismatchReconcileRes.status === 201 &&
        mismatchReconcileBody.conflicts.includes(mismatchRowId) &&
        !mismatchReconcileBody.recovered.includes(mismatchRowId),
      'reconcile rejects a mismatched-bytes PENDING_UPLOAD as a conflict and never promotes it',
    );
    const [mismatchRowAfter] = await connection.db
      .select()
      .from(artifactObjects)
      .where(eq(artifactObjects.id, mismatchRowId));
    check(
      mismatchRowAfter?.state === 'PENDING_UPLOAD',
      'the mismatched-bytes row stays PENDING_UPLOAD after reconciliation',
    );
    const mismatchObjectAfter = s3Fixture.objects.get(`qeynox-qa-atlas/${mismatchKey}`);
    check(
      Boolean(mismatchObjectAfter) && mismatchObjectAfter!.sha256 === mismatchSha && mismatchObjectAfter!.content.equals(mismatchBytes),
      'the mismatched stored object bytes are never overwritten by reconciliation',
    );
    const postNegativePage = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl2, '/v1/results?state=DELIVERABLE', {
          token: ownerSession.token,
          workspaceId: wsAlphaId,
        })
      ).body,
    );
    check(
      postNegativePage.items[0]?.pendingExportCount === 1,
      'pendingExportCount reflects only the rejected mismatched row (1)',
    );

    // ── Controlled Result Sharing: Gates, Expiry, Sanitization & Revocation ──
    // 1. Unreviewed documents (DRAFT / PARTIAL / READY_FOR_REVIEW) CANNOT be shared externally
    for (const unreviewedId of [op1v1.id, op1v2.id, op1v3.id]) {
      const deniedShare = await httpJson(baseUrl2, `/v1/results/${unreviewedId}/shares`, {
        method: 'POST',
        token: ownerSession.token,
        workspaceId: wsAlphaId,
        body: { label: 'Should fail', expiresInHours: 24 },
      });
      check(
        deniedShare.status === 409,
        `Sharing non-DELIVERABLE document ${unreviewedId} fails closed with 409 INVALID_STATE`,
      );
    }

    // 2. Out-of-bounds expiry fails closed with 400 INVALID_INPUT
    const badExpiryRes = await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
      method: 'POST',
      token: ownerSession.token,
      workspaceId: wsAlphaId,
      body: { expiresInHours: 9999 },
    });
    check(badExpiryRes.status === 400, 'expiresInHours > 720 returns 400 INVALID_INPUT');

    // 3. OWNER creates controlled share link on DELIVERABLE v4
    const createShareRes = await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
      method: 'POST',
      token: ownerSession.token,
      workspaceId: wsAlphaId,
      body: { label: 'Board Memo Q4', expiresInHours: 48 },
    });
    check(createShareRes.status === 201, 'OWNER creates share link on DELIVERABLE document (201)');
    const createdShare = createdResultShareSchema.parse(createShareRes.body);
    check(
      createdShare.share.state === 'ACTIVE' &&
        createdShare.share.label === 'Board Memo Q4' &&
        createdShare.sharePath === `/results/shared/${createdShare.token}`,
      'Created share returns ACTIVE summary and one-time capability token',
    );

    // Verify DB stores ONLY SHA-256 hash, never raw token, and operation_events never logs raw token
    const [dbShareRow] = await connection.db
      .select()
      .from(resultShareLinks)
      .where(eq(resultShareLinks.id, createdShare.share.id));
    check(
      Boolean(dbShareRow) &&
        dbShareRow!.tokenHash === sha256Hex(createdShare.token) &&
        dbShareRow!.tokenHash !== createdShare.token,
      'PostgreSQL stores SHA-256 token_hash and never the raw share token',
    );
    const opEvents = await connection.db
      .select()
      .from(events)
      .where(eq(events.operationId, op1.id));
    check(
      opEvents.some(e => e.kind === 'RESULT_SHARE_CREATED') &&
        !JSON.stringify(opEvents).includes(createdShare.token),
      'RESULT_SHARE_CREATED event is recorded and never leaks raw token',
    );

    // 4. Unauthenticated external reader resolves valid share link
    const publicRead1 = await httpJson(
      baseUrl2,
      `/v1/public/shared-results/${createdShare.token}`,
    );
    check(publicRead1.status === 200, 'Public GET /v1/public/shared-results/:token returns 200');
    const sharedView = sharedAtlasResultViewSchema.parse(publicRead1.body);
    check(
      sharedView.document.id === op1v4Id &&
        sharedView.deliverable === true &&
        sharedView.verificationPosture === 'VERIFIED_DELIVERABLE',
      'Public shared view renders canonical DELIVERABLE document and posture',
    );
    const rawSharedJson = JSON.stringify(publicRead1.body);
    check(
      !rawSharedJson.includes(wsAlphaId) && !rawSharedJson.includes(alphaOwnerId),
      'Public shared response strips internal workspaceId and reviewer user UUID',
    );

    // ADMIN lists shares and sees accessCount === 1
    const adminSharesRes = await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
      token: adminSession.token,
      workspaceId: wsAlphaId,
    });
    check(adminSharesRes.status === 200, 'Workspace ADMIN can list share links');
    const shareList = (adminSharesRes.body as unknown[]).map(x => resultShareSummarySchema.parse(x));
    check(
      shareList.length === 1 && shareList[0]?.accessCount === 1 && shareList[0]?.lastAccessedAt !== null,
      'Share accessCount and lastAccessedAt increment on public view',
    );

    // 5. ADMIN revokes share link -> immediate 403 DENIED on public route & 409 CONFLICT on re-revoke
    const revokeRes = await httpJson(
      baseUrl2,
      `/v1/results/${op1v4Id}/shares/${createdShare.share.id}/revoke`,
      {
        method: 'POST',
        token: adminSession.token,
        workspaceId: wsAlphaId,
      },
    );
    check(revokeRes.status === 201, 'Workspace ADMIN revokes active share link (201)');

    const publicAfterRevoke = await httpJson(
      baseUrl2,
      `/v1/public/shared-results/${createdShare.token}`,
    );
    check(
      publicAfterRevoke.status === 403,
      'Revoked share link immediately fails closed with 403 DENIED',
    );

    const doubleRevokeRes = await httpJson(
      baseUrl2,
      `/v1/results/${op1v4Id}/shares/${createdShare.share.id}/revoke`,
      {
        method: 'POST',
        token: ownerSession.token,
        workspaceId: wsAlphaId,
      },
    );
    check(doubleRevokeRes.status === 409, 'Double revocation returns 409 CONFLICT');

    // 6. Expired share link fails closed with 403 DENIED
    const expiringShare = createdResultShareSchema.parse(
      (
        await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
          method: 'POST',
          token: ownerSession.token,
          workspaceId: wsAlphaId,
          body: { label: 'Short-lived link', expiresInHours: 1 },
        })
      ).body,
    );
    await connection.db
      .update(resultShareLinks)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(resultShareLinks.id, expiringShare.share.id));

    const expiredReadRes = await httpJson(
      baseUrl2,
      `/v1/public/shared-results/${expiringShare.token}`,
    );
    check(expiredReadRes.status === 403, 'Expired share link fails closed with 403 DENIED');

    const unknownTokenRes = await httpJson(
      baseUrl2,
      `/v1/public/shared-results/${'x'.repeat(43)}`,
    );
    check(unknownTokenRes.status === 404, 'Unknown share token returns 404 NOT_FOUND');

    // ── Workspace Role Permissions (MEMBER vs ADMIN/OWNER) & Cross-Tenant Isolation ──
    const memberListRes = await httpJson(baseUrl2, '/v1/results', {
      token: memberSession.token,
      workspaceId: wsAlphaId,
    });
    check(memberListRes.status === 200, 'Workspace MEMBER can browse /v1/results');
    const memberPage = atlasLibraryPageSchema.parse(memberListRes.body);
    check(
      memberPage.totalCount === 6 && memberPage.canManageShares === false,
      'Workspace MEMBER sees workspace results with canManageShares=false',
    );

    const memberDetailRes = await httpJson(baseUrl2, `/v1/results/${op1v4Id}`, {
      token: memberSession.token,
      workspaceId: wsAlphaId,
    });
    check(memberDetailRes.status === 200, 'Workspace MEMBER can read /v1/results/:documentId');

    const memberListShares = await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
      token: memberSession.token,
      workspaceId: wsAlphaId,
    });
    check(memberListShares.status === 403, 'Workspace MEMBER is denied GET /shares (403)');

    const memberCreateShare = await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
      method: 'POST',
      token: memberSession.token,
      workspaceId: wsAlphaId,
      body: { expiresInHours: 24 },
    });
    check(memberCreateShare.status === 403, 'Workspace MEMBER is denied POST /shares (403)');

    const memberRevokeShare = await httpJson(
      baseUrl2,
      `/v1/results/${op1v4Id}/shares/${expiringShare.share.id}/revoke`,
      {
        method: 'POST',
        token: memberSession.token,
        workspaceId: wsAlphaId,
      },
    );
    check(memberRevokeShare.status === 403, 'Workspace MEMBER is denied POST /revoke (403)');

    // Cross-tenant Outsider (Workspace Beta OWNER targeting Workspace Alpha resources)
    const betaSpoofHeaderRes = await httpJson(baseUrl2, '/v1/results', {
      token: betaOwnerSession.token,
      workspaceId: wsAlphaId, // Spoofed x-qeynox-workspace header!
    });
    check(
      betaSpoofHeaderRes.status === 403,
      'Outsider spoofing x-qeynox-workspace header is rejected with 403 DENIED',
    );

    const betaOwnLibrary = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl2, '/v1/results', {
          token: betaOwnerSession.token,
          workspaceId: wsBetaId,
        })
      ).body,
    );
    check(
      betaOwnLibrary.totalCount === 1 && betaOwnLibrary.items[0]?.id === betaDoc.id,
      'Beta OWNER sees only Beta workspace document',
    );

    const betaFilterAlphaOp = atlasLibraryPageSchema.parse(
      (
        await httpJson(baseUrl2, `/v1/results?operationId=${op1.id}`, {
          token: betaOwnerSession.token,
          workspaceId: wsBetaId,
        })
      ).body,
    );
    check(
      betaFilterAlphaOp.totalCount === 0 && betaFilterAlphaOp.items.length === 0,
      'Filtering by Alpha operationId from Beta workspace returns 0 items',
    );

    const betaReadAlphaDoc = await httpJson(baseUrl2, `/v1/results/${op1v4Id}`, {
      token: betaOwnerSession.token,
      workspaceId: wsBetaId,
    });
    const betaReadFakeDoc = await httpJson(baseUrl2, `/v1/results/${newId()}`, {
      token: betaOwnerSession.token,
      workspaceId: wsBetaId,
    });
    check(
      betaReadAlphaDoc.status === 404 && betaReadAlphaDoc.status === betaReadFakeDoc.status,
      'Cross-tenant GET /v1/results/:alphaDoc returns 404 NOT_FOUND with zero existence oracle',
    );

    const betaShareAlphaDoc = await httpJson(baseUrl2, `/v1/results/${op1v4Id}/shares`, {
      method: 'POST',
      token: betaOwnerSession.token,
      workspaceId: wsBetaId,
      body: { expiresInHours: 24 },
    });
    check(
      betaShareAlphaDoc.status === 404,
      'Cross-tenant POST /v1/results/:alphaDoc/shares returns 404 NOT_FOUND',
    );

    console.log(`  PART 2 PASSED: cumulative ${assertions} assertions`);
    console.log(`A20 GLOBAL ATLAS LIBRARY QA PASSED: ${assertions} assertions.`);
  } finally {
    await appUnconfigured?.close().catch(() => undefined);
    await appWithS3?.close().catch(() => undefined);
    await s3Fixture?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('A20 Global Atlas Library QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
