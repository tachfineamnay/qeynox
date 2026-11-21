import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, gt, sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  isWorkspaceAdministrator,
  isWorkspaceRole,
  newId,
  type ID,
  type Operation,
  type Principal,
} from '@qeynox/domain';
import {
  atlasLibraryQuerySchema,
  createResultShareSchema,
  type AtlasArtifactSummary,
  type AtlasExportFormat,
  type AtlasFailedOperationSummary,
  type AtlasLibraryCard,
  type AtlasLibraryDetail,
  type AtlasLibraryPage,
  type AtlasLibraryQuery,
  type AtlasMissionFilterOption,
  type AtlasProvenanceSummary,
  type AtlasVerificationPosture,
  type AtlasVersionComparison,
  type AtlasVersionSummary,
  type CreatedResultShare,
  type CreateResultShareInput,
  type ResultShareState,
  type ResultShareSummary,
  type SharedAtlasResultView,
} from '@qeynox/contracts';
import {
  QeyNoxStore,
  artifactObjects,
  events,
  identityAudit,
  operations,
  resultDocuments,
  resultShareLinks,
} from '@qeynox/persistence';
import { formatFromContentType } from './artifacts';
import {
  classifyDocument,
  classifyFinding,
  documentVerdict,
  isVerifiableUri,
  type DocumentClassification,
} from './result-classification';
import type { ResultCitation, ResultDocument } from './result-document';

const DEFAULT_LIBRARY_LIMIT = 12;
const MAX_LIBRARY_LIMIT = 50;
const MAX_ACTIVE_SHARES_PER_DOCUMENT = 20;

export interface AtlasPageCursor {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeAtlasCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function decodeAtlasCursor(value: string): AtlasPageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('shape');
    }
    if (Number.isNaN(Date.parse(parsed.createdAt)) || !/^[A-Za-z0-9_-]{4,120}$/.test(parsed.id)) {
      throw new Error('value');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new DomainError('INVALID_INPUT', 'Invalid pagination cursor');
  }
}

/**
 * Derives truthful verification posture from persisted document state and finding classification.
 * Never claims PARTIALLY_VERIFIED when zero findings are verified, and never claims
 * VERIFIED_DELIVERABLE unless the document is DELIVERABLE with zero unresolved/unassessed items.
 */
export function deriveVerificationPosture(
  doc: Pick<ResultDocument, 'status'>,
  classification: DocumentClassification,
): AtlasVerificationPosture {
  const { VERIFIED, UNRESOLVED, AWAITING_ASSESSMENT } = classification.counts;
  if (VERIFIED === 0) return 'UNVERIFIED';
  if (UNRESOLVED === 0 && AWAITING_ASSESSMENT === 0) {
    if (doc.status === 'DELIVERABLE') return 'VERIFIED_DELIVERABLE';
    if (doc.status === 'READY_FOR_REVIEW') return 'AWAITING_REVIEW';
  }
  return 'PARTIALLY_VERIFIED';
}

function redactCredentialUri(uri?: string): string | undefined {
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    if (!url.username && !url.password) return uri;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return uri;
  }
}

export function summarizeProvenance(doc: ResultDocument): AtlasProvenanceSummary {
  const seen = new Map<string, ResultCitation>();
  for (const citation of doc.citations ?? []) {
    const key = `${citation.sourceId}|${citation.uri ?? ''}`;
    if (!seen.has(key)) seen.set(key, citation);
  }
  for (const finding of doc.findings ?? []) {
    for (const citation of finding.citations ?? []) {
      const key = `${citation.sourceId}|${citation.uri ?? ''}`;
      if (!seen.has(key)) seen.set(key, citation);
    }
  }
  const all = [...seen.values()];
  const providers: string[] = [];
  const providerSet = new Set<string>();
  let latestRetrievedAt: string | null = null;
  let verifiableCitationCount = 0;
  for (const citation of all) {
    if (isVerifiableUri(citation.uri)) verifiableCitationCount++;
    const provider = citation.provider?.trim();
    if (provider && !providerSet.has(provider)) {
      providerSet.add(provider);
      providers.push(provider);
    }
    if (citation.retrievedAt && !Number.isNaN(Date.parse(citation.retrievedAt))) {
      if (latestRetrievedAt === null || citation.retrievedAt > latestRetrievedAt) {
        latestRetrievedAt = citation.retrievedAt;
      }
    }
  }
  return {
    citationCount: all.length,
    verifiableCitationCount,
    providers,
    latestRetrievedAt,
  };
}

/**
 * Deterministic comparison between two persisted ResultDocument versions of the same mission.
 * Always orients base = lower version, target = higher version so deltas represent forward evolution.
 */
export function compareResultVersions(
  first: ResultDocument,
  second: ResultDocument,
): AtlasVersionComparison | null {
  if (first.id === second.id) return null;
  const [base, target] = first.version <= second.version ? [first, second] : [second, first];
  const baseClass = classifyDocument(base);
  const targetClass = classifyDocument(target);
  const baseProvenance = summarizeProvenance(base);
  const targetProvenance = summarizeProvenance(target);

  const baseByClaim = new Map(
    (base.findings ?? []).map(finding => [finding.claimId, { finding, classified: classifyFinding(finding) }]),
  );
  const targetByClaim = new Map(
    (target.findings ?? []).map(finding => [finding.claimId, { finding, classified: classifyFinding(finding) }]),
  );

  const addedFindings: AtlasVersionComparison['addedFindings'] = [];
  const removedFindings: AtlasVersionComparison['removedFindings'] = [];
  const changedFindings: AtlasVersionComparison['changedFindings'] = [];

  for (const [claimId, entry] of targetByClaim) {
    const prior = baseByClaim.get(claimId);
    if (!prior) {
      addedFindings.push({
        claimId,
        statement: entry.finding.statement,
        status: entry.finding.status,
        findingClass: entry.classified.findingClass,
      });
    } else if (
      prior.finding.status !== entry.finding.status ||
      prior.classified.findingClass !== entry.classified.findingClass
    ) {
      changedFindings.push({
        claimId,
        statement: entry.finding.statement,
        fromStatus: prior.finding.status,
        toStatus: entry.finding.status,
        fromClass: prior.classified.findingClass,
        toClass: entry.classified.findingClass,
      });
    }
  }

  for (const [claimId, entry] of baseByClaim) {
    if (!targetByClaim.has(claimId)) {
      removedFindings.push({
        claimId,
        statement: entry.finding.statement,
        status: entry.finding.status,
        findingClass: entry.classified.findingClass,
      });
    }
  }

  const baseScope = new Set(base.scope ?? []);
  const targetScope = new Set(target.scope ?? []);
  const scopeAdded = [...targetScope].filter(item => !baseScope.has(item));
  const scopeRemoved = [...baseScope].filter(item => !targetScope.has(item));

  return {
    baseDocumentId: base.id,
    baseVersion: base.version,
    baseStatus: base.status,
    baseCreatedAt: base.createdAt,
    targetDocumentId: target.id,
    targetVersion: target.version,
    targetStatus: target.status,
    targetCreatedAt: target.createdAt,
    statusChanged: base.status !== target.status,
    verifiedDelta: targetClass.counts.VERIFIED - baseClass.counts.VERIFIED,
    unresolvedDelta: targetClass.counts.UNRESOLVED - baseClass.counts.UNRESOLVED,
    awaitingDelta: targetClass.counts.AWAITING_ASSESSMENT - baseClass.counts.AWAITING_ASSESSMENT,
    citationDelta: targetProvenance.citationCount - baseProvenance.citationCount,
    addedFindings,
    removedFindings,
    changedFindings,
    scopeAdded,
    scopeRemoved,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => '\\' + ch);
}

function parseDateBound(raw: string | undefined, endOfDay: boolean): string | undefined {
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const parsed = new Date(raw + suffix);
    if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(raw)) {
      throw new DomainError('INVALID_INPUT', 'Invalid calendar date filter');
    }
    return parsed.toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError('INVALID_INPUT', 'Invalid date filter');
  }
  return parsed.toISOString();
}

function hashShareToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function shareStateOf(
  row: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
): ResultShareState {
  if (row.revokedAt !== null) return 'REVOKED';
  if (row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

export interface AtlasLibraryServiceOptions {
  readonly artifactStoreConfigured?: () => boolean;
  readonly now?: () => Date;
}

export class AtlasLibraryService {
  private readonly isArtifactStoreConfigured: () => boolean;
  private readonly now: () => Date;

  constructor(
    private readonly store: QeyNoxStore,
    options: AtlasLibraryServiceOptions = {},
  ) {
    this.isArtifactStoreConfigured = options.artifactStoreConfigured ?? (() => false);
    this.now = options.now ?? (() => new Date());
  }

  private requirePrincipal(principal: Principal | undefined): Principal {
    if (!principal || !principal.userId || !principal.workspaceId || !principal.roles.length) {
      throw new DomainError('DENIED', 'Authenticated workspace session required');
    }
    return principal;
  }

  private canManageShares(actor: Principal): boolean {
    return actor.roles.some(role => isWorkspaceRole(role) && isWorkspaceAdministrator(role));
  }

  private requireShareAdministrator(actor: Principal): void {
    if (!this.canManageShares(actor)) {
      throw new DomainError(
        'DENIED',
        'Workspace owner or administrator role is required to manage shared result links',
      );
    }
  }

  async listLibrary(
    principal: Principal | undefined,
    rawQuery: unknown = {},
  ): Promise<AtlasLibraryPage> {
    const actor = this.requirePrincipal(principal);
    const parsed = atlasLibraryQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError('INVALID_INPUT', 'Invalid Atlas library query parameters');
    }
    const query: AtlasLibraryQuery = parsed.data;
    const fromIso = parseDateBound(query.from, false);
    const toIso = parseDateBound(query.to, true);
    if (fromIso && toIso && fromIso > toIso) {
      throw new DomainError('INVALID_INPUT', 'Invalid date range: start date exceeds end date');
    }
    const cursor = query.cursor ? decodeAtlasCursor(query.cursor) : undefined;
    const limit = Math.min(MAX_LIBRARY_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIBRARY_LIMIT));

    const baseConditions: SQL[] = [eq(resultDocuments.workspaceId, actor.workspaceId)];
    if (query.operationId) {
      baseConditions.push(eq(resultDocuments.operationId, query.operationId));
    }
    if (query.state) {
      baseConditions.push(eq(resultDocuments.state, query.state));
    }
    if (query.operationStatus) {
      baseConditions.push(eq(operations.status, query.operationStatus));
    }
    if (query.version !== undefined) {
      baseConditions.push(eq(resultDocuments.version, query.version));
    }
    if (query.versionScope === 'LATEST') {
      baseConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM result_documents rd_newer
          WHERE rd_newer.workspace_id = ${resultDocuments.workspaceId}
            AND rd_newer.operation_id = ${resultDocuments.operationId}
            AND rd_newer.version > ${resultDocuments.version}
        )`,
      );
    } else if (query.versionScope === 'PREVIOUS') {
      baseConditions.push(
        sql`EXISTS (
          SELECT 1 FROM result_documents rd_newer
          WHERE rd_newer.workspace_id = ${resultDocuments.workspaceId}
            AND rd_newer.operation_id = ${resultDocuments.operationId}
            AND rd_newer.version > ${resultDocuments.version}
        )`,
      );
    }
    if (fromIso) {
      baseConditions.push(sql`${resultDocuments.createdAt} >= ${fromIso}`);
    }
    if (toIso) {
      baseConditions.push(sql`${resultDocuments.createdAt} <= ${toIso}`);
    }
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      baseConditions.push(
        sql`(
          (${resultDocuments.document}->>'title') ILIKE ${pattern} ESCAPE '\\'
          OR (${resultDocuments.document}->>'objective') ILIKE ${pattern} ESCAPE '\\'
          OR (${operations.payload}->>'title') ILIKE ${pattern} ESCAPE '\\'
          OR CAST(${resultDocuments.document}->'scope' AS text) ILIKE ${pattern} ESCAPE '\\'
          OR CAST(${resultDocuments.document}->'findings' AS text) ILIKE ${pattern} ESCAPE '\\'
          OR CAST(${resultDocuments.document}->'citations' AS text) ILIKE ${pattern} ESCAPE '\\'
        )`,
      );
    }

    const pageConditions: SQL[] = [...baseConditions];
    if (cursor) {
      pageConditions.push(
        sql`(
          ${resultDocuments.createdAt} < ${cursor.createdAt}
          OR (${resultDocuments.createdAt} = ${cursor.createdAt} AND ${resultDocuments.id} < ${cursor.id})
        )`,
      );
    }

    const [workspaceCountRow] = await this.store.db
      .select({ n: sql<number>`count(*)::int` })
      .from(resultDocuments)
      .where(eq(resultDocuments.workspaceId, actor.workspaceId));
    const workspaceDocumentCount = workspaceCountRow?.n ?? 0;

    const [filteredCountRow] = await this.store.db
      .select({ n: sql<number>`count(*)::int` })
      .from(resultDocuments)
      .innerJoin(
        operations,
        and(
          eq(operations.id, resultDocuments.operationId),
          eq(operations.workspaceId, resultDocuments.workspaceId),
        ),
      )
      .where(and(...baseConditions));
    const totalCount = filteredCountRow?.n ?? 0;

    const joinedRows = await this.store.db
      .select({
        docRow: resultDocuments,
        opPayload: operations.payload,
        opStatus: operations.status,
        opLastActivityAt: operations.lastActivityAt,
      })
      .from(resultDocuments)
      .innerJoin(
        operations,
        and(
          eq(operations.id, resultDocuments.operationId),
          eq(operations.workspaceId, resultDocuments.workspaceId),
        ),
      )
      .where(and(...pageConditions))
      .orderBy(desc(resultDocuments.createdAt), desc(resultDocuments.id))
      .limit(limit + 1);

    const hasMore = joinedRows.length > limit;
    const slice = hasMore ? joinedRows.slice(0, limit) : joinedRows;
    const lastRow = slice[slice.length - 1];
    const nextCursor = hasMore && lastRow ? encodeAtlasCursor(lastRow.docRow.createdAt, lastRow.docRow.id) : null;

    const pageOperationIds = [...new Set(slice.map(entry => entry.docRow.operationId))];
    const pageDocumentIds = slice.map(entry => entry.docRow.id);

    // Batch-load version chains for operations represented on this page
    const versionRows = pageOperationIds.length
      ? await this.store.db
          .select({
            id: resultDocuments.id,
            operationId: resultDocuments.operationId,
            version: resultDocuments.version,
          })
          .from(resultDocuments)
          .where(
            and(
              eq(resultDocuments.workspaceId, actor.workspaceId),
              inArray(resultDocuments.operationId, pageOperationIds),
            ),
          )
          .orderBy(desc(resultDocuments.version))
      : [];

    const versionsByOp = new Map<string, { id: string; version: number }[]>();
    for (const vRow of versionRows) {
      const list = versionsByOp.get(vRow.operationId) ?? [];
      list.push({ id: vRow.id, version: vRow.version });
      versionsByOp.set(vRow.operationId, list);
    }

    // Batch-load artifact metadata for documents on this page
    const artifactRows = pageDocumentIds.length
      ? await this.store.db
          .select({
            documentId: artifactObjects.documentId,
            contentType: artifactObjects.contentType,
            state: artifactObjects.state,
          })
          .from(artifactObjects)
          .where(
            and(
              eq(artifactObjects.workspaceId, actor.workspaceId),
              inArray(artifactObjects.documentId, pageDocumentIds),
            ),
          )
      : [];

    const exportsByDoc = new Map<string, { available: Set<AtlasExportFormat>; pending: number }>();
    for (const art of artifactRows) {
      const entry = exportsByDoc.get(art.documentId) ?? { available: new Set<AtlasExportFormat>(), pending: 0 };
      const format = formatFromContentType(art.contentType);
      if (art.state === 'AVAILABLE' && format) entry.available.add(format);
      else if (art.state === 'PENDING_UPLOAD') entry.pending++;
      exportsByDoc.set(art.documentId, entry);
    }

    // Batch-load active share counts for documents on this page
    const now = this.now();
    const activeShares = pageDocumentIds.length
      ? await this.store.db
          .select({
            documentId: resultShareLinks.documentId,
            n: sql<number>`count(*)::int`,
          })
          .from(resultShareLinks)
          .where(
            and(
              eq(resultShareLinks.workspaceId, actor.workspaceId),
              inArray(resultShareLinks.documentId, pageDocumentIds),
              isNull(resultShareLinks.revokedAt),
              gt(resultShareLinks.expiresAt, now),
            ),
          )
          .groupBy(resultShareLinks.documentId)
      : [];
    const shareCountByDoc = new Map(activeShares.map(row => [row.documentId, row.n]));

    const formatOrder: readonly AtlasExportFormat[] = ['pdf', 'html', 'json'];
    const items: AtlasLibraryCard[] = slice.map(({ docRow, opPayload, opStatus, opLastActivityAt }) => {
      const doc = docRow.document as unknown as ResultDocument;
      const classification = classifyDocument(doc);
      const provenance = summarizeProvenance(doc);
      const opVersions = versionsByOp.get(docRow.operationId) ?? [{ id: docRow.id, version: docRow.version }];
      const latestEntry = opVersions[0] ?? { id: docRow.id, version: docRow.version };
      const currentIdx = opVersions.findIndex(v => v.id === docRow.id);
      const previousEntry = currentIdx >= 0 ? opVersions[currentIdx + 1] : undefined;
      const exportSummary = exportsByDoc.get(docRow.id);
      const availableExports = exportSummary
        ? formatOrder.filter(fmt => exportSummary.available.has(fmt))
        : [];
      const timestamps = [docRow.createdAt, doc.reviewedAt, opLastActivityAt].filter(
        (ts): ts is string => typeof ts === 'string' && ts.length > 0,
      );
      const lastUpdatedAt = timestamps.sort()[timestamps.length - 1] ?? docRow.createdAt;

      return {
        id: docRow.id,
        operationId: docRow.operationId,
        operationTitle: opPayload.title,
        operationStatus: opStatus as AtlasLibraryCard['operationStatus'],
        operationLastErrorCode: opPayload.lastErrorCode ?? null,
        revisionId: docRow.revisionId,
        version: docRow.version,
        latestVersionForOperation: latestEntry.version,
        isLatestVersion: latestEntry.id === docRow.id,
        latestDocumentId: latestEntry.id,
        previousVersionDocumentId: previousEntry?.id ?? (doc.priorId ? String(doc.priorId) : null),
        title: doc.title,
        objective: doc.objective,
        status: docRow.state,
        verdict: documentVerdict(doc, classification),
        verificationPosture: deriveVerificationPosture(doc, classification),
        deliverable: classification.deliverable,
        counts: classification.counts,
        provenance,
        createdAt: docRow.createdAt,
        reviewedAt: doc.reviewedAt ?? null,
        lastUpdatedAt,
        availableExports,
        pendingExportCount: exportSummary?.pending ?? 0,
        activeShareCount: shareCountByDoc.get(docRow.id) ?? 0,
      };
    });

    // Workspace missions for filter dropdown + failed missions disclosure
    const workspaceOps = await this.store.db
      .select({
        id: operations.id,
        status: operations.status,
        lastActivityAt: operations.lastActivityAt,
        payload: operations.payload,
        documentCount: sql<number>`(
          SELECT count(*)::int FROM result_documents rd_cnt
          WHERE rd_cnt.workspace_id = ${operations.workspaceId}
            AND rd_cnt.operation_id = ${operations.id}
        )`,
        latestVersion: sql<number>`coalesce((
          SELECT max(rd_max.version)::int FROM result_documents rd_max
          WHERE rd_max.workspace_id = ${operations.workspaceId}
            AND rd_max.operation_id = ${operations.id}
        ), 0)`,
      })
      .from(operations)
      .where(eq(operations.workspaceId, actor.workspaceId))
      .orderBy(desc(operations.lastActivityAt))
      .limit(100);

    const missions: AtlasMissionFilterOption[] = workspaceOps.map(op => ({
      operationId: op.id,
      title: op.payload.title,
      status: op.status as AtlasMissionFilterOption['status'],
      documentCount: op.documentCount,
      latestVersion: op.latestVersion,
    }));

    const qLower = query.q?.toLowerCase();
    const failedOperations: AtlasFailedOperationSummary[] = workspaceOps
      .filter(op => {
        if (op.status !== 'FAILED') return false;
        if (query.operationId && op.id !== query.operationId) return false;
        if (query.operationStatus && query.operationStatus !== 'FAILED') return false;
        if (fromIso && op.lastActivityAt < fromIso) return false;
        if (toIso && op.lastActivityAt > toIso) return false;
        if (qLower && !op.payload.title.toLowerCase().includes(qLower) && !(op.payload.lastErrorCode ?? '').toLowerCase().includes(qLower)) {
          return false;
        }
        return true;
      })
      .map(op => ({
        operationId: op.id,
        title: op.payload.title,
        status: 'FAILED' as const,
        lastActivityAt: op.lastActivityAt,
        lastErrorCode: op.payload.lastErrorCode ?? null,
        documentCount: op.documentCount,
      }));

    return {
      items,
      totalCount,
      workspaceDocumentCount,
      nextCursor,
      limit,
      artifactStoreConfigured: this.isArtifactStoreConfigured(),
      canManageShares: this.canManageShares(actor),
      missions,
      failedOperations,
    };
  }

  async getDetail(
    principal: Principal | undefined,
    documentId: ID,
    compareWithId?: ID,
  ): Promise<AtlasLibraryDetail> {
    const actor = this.requirePrincipal(principal);
    const [row] = await this.store.db
      .select({
        docRow: resultDocuments,
        opPayload: operations.payload,
        opStatus: operations.status,
        opLastActivityAt: operations.lastActivityAt,
        opCurrentRevisionId: operations.currentRevisionId,
      })
      .from(resultDocuments)
      .innerJoin(
        operations,
        and(
          eq(operations.id, resultDocuments.operationId),
          eq(operations.workspaceId, resultDocuments.workspaceId),
        ),
      )
      .where(
        and(
          eq(resultDocuments.id, documentId),
          eq(resultDocuments.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new DomainError('NOT_FOUND', 'Result document not found');
    }

    const doc = row.docRow.document as unknown as ResultDocument;
    const classification = classifyDocument(doc);

    // Load all versions for this operation in this workspace
    const allVersionRows = await this.store.db
      .select()
      .from(resultDocuments)
      .where(
        and(
          eq(resultDocuments.workspaceId, actor.workspaceId),
          eq(resultDocuments.operationId, row.docRow.operationId),
        ),
      )
      .orderBy(desc(resultDocuments.version));

    const latestRow = allVersionRows[0] ?? row.docRow;
    const currentIndex = allVersionRows.findIndex(v => v.id === row.docRow.id);
    const nextNewerRow = currentIndex > 0 ? allVersionRows[currentIndex - 1] : undefined;
    const prevOlderRow = currentIndex >= 0 ? allVersionRows[currentIndex + 1] : undefined;

    const versions: AtlasVersionSummary[] = allVersionRows.map(vRow => {
      const vDoc = vRow.document as unknown as ResultDocument;
      const vClass = classifyDocument(vDoc);
      const vProv = summarizeProvenance(vDoc);
      return {
        id: vRow.id,
        version: vRow.version,
        status: vRow.state,
        title: vDoc.title,
        createdAt: vRow.createdAt,
        reviewedAt: vDoc.reviewedAt ?? null,
        isLatestVersion: vRow.id === latestRow.id,
        verificationPosture: deriveVerificationPosture(vDoc, vClass),
        counts: vClass.counts,
        citationCount: vProv.citationCount,
      };
    });

    // Resolve version comparison target:
    // 1. Explicit compareWithId (must belong to same operation & workspace)
    // 2. Immediately previous version when viewing latest/newer
    // 3. Latest version when viewing an older version
    let comparePartnerRow: (typeof allVersionRows)[number] | undefined;
    if (compareWithId) {
      comparePartnerRow = allVersionRows.find(v => v.id === compareWithId);
      if (!comparePartnerRow) {
        throw new DomainError('NOT_FOUND', 'Comparison version not found for this mission');
      }
    } else if (prevOlderRow) {
      comparePartnerRow = prevOlderRow;
    } else if (latestRow.id !== row.docRow.id) {
      comparePartnerRow = latestRow;
    }

    const comparison = comparePartnerRow
      ? compareResultVersions(doc, comparePartnerRow.document as unknown as ResultDocument)
      : null;

    // Load recorded artifact objects for this document
    const rawArtifacts = await this.store.db
      .select()
      .from(artifactObjects)
      .where(
        and(
          eq(artifactObjects.workspaceId, actor.workspaceId),
          eq(artifactObjects.documentId, row.docRow.id),
        ),
      )
      .orderBy(desc(artifactObjects.createdAt));

    const artifacts: AtlasArtifactSummary[] = [];
    for (const art of rawArtifacts) {
      const format = formatFromContentType(art.contentType);
      if (!format) continue;
      if (art.state !== 'AVAILABLE' && art.state !== 'PENDING_UPLOAD') continue;
      artifacts.push({
        id: art.id,
        format,
        contentType: art.contentType,
        sha256: art.sha256,
        size: art.size,
        state: art.state,
        createdAt: art.createdAt,
      });
    }

    const now = this.now();
    const [shareCountRow] = await this.store.db
      .select({ n: sql<number>`count(*)::int` })
      .from(resultShareLinks)
      .where(
        and(
          eq(resultShareLinks.workspaceId, actor.workspaceId),
          eq(resultShareLinks.documentId, row.docRow.id),
          isNull(resultShareLinks.revokedAt),
          gt(resultShareLinks.expiresAt, now),
        ),
      );

    const opPayload = row.opPayload as Operation;
    return {
      document: {
        id: doc.id,
        workspaceId: doc.workspaceId,
        operationId: doc.operationId,
        revisionId: doc.revisionId,
        version: doc.version,
        title: doc.title,
        objective: doc.objective,
        status: row.docRow.state,
        scope: [...(doc.scope ?? [])],
        findings: (doc.findings ?? []).map(f => ({
          claimId: f.claimId,
          statement: f.statement,
          status: f.status,
          sourceIds: [...(f.sourceIds ?? [])],
          attemptId: f.attemptId,
          limitations: [...(f.limitations ?? [])],
          citations: (f.citations ?? []).map(c => ({
            sourceId: c.sourceId,
            provider: c.provider,
            uri: c.uri,
            retrievedAt: c.retrievedAt,
            publishedAt: c.publishedAt,
            fingerprint: c.fingerprint,
          })),
        })),
        nextActions: [...(doc.nextActions ?? [])],
        limitations: [...(doc.limitations ?? [])],
        unresolved: [...(doc.unresolved ?? [])],
        citations: (doc.citations ?? []).map(c => ({
          sourceId: c.sourceId,
          provider: c.provider,
          uri: c.uri,
          retrievedAt: c.retrievedAt,
          publishedAt: c.publishedAt,
          fingerprint: c.fingerprint,
        })),
        createdAt: row.docRow.createdAt,
        priorId: doc.priorId,
        reviewedBy: doc.reviewedBy,
        reviewedAt: doc.reviewedAt,
        ...(doc.interpretations ? { interpretations: [...doc.interpretations] } : {}),
        ...(doc.businessPack ? { businessPack: { ...doc.businessPack } } : {}),
      },
      operation: {
        id: row.docRow.operationId,
        title: opPayload.title,
        status: row.opStatus as AtlasLibraryDetail['operation']['status'],
        lastActivityAt: row.opLastActivityAt,
        lastErrorCode: opPayload.lastErrorCode ?? null,
        currentRevisionId: row.opCurrentRevisionId ?? null,
      },
      verdict: documentVerdict(doc, classification),
      verificationPosture: deriveVerificationPosture(doc, classification),
      deliverable: classification.deliverable,
      counts: classification.counts,
      isLatestVersion: row.docRow.id === latestRow.id,
      latestDocumentId: latestRow.id,
      previousVersionDocumentId: prevOlderRow?.id ?? null,
      nextVersionDocumentId: nextNewerRow?.id ?? null,
      versions,
      comparison,
      artifacts,
      canExportNew: Boolean(row.opCurrentRevisionId && row.opCurrentRevisionId === row.docRow.revisionId),
      artifactStoreConfigured: this.isArtifactStoreConfigured(),
      canManageShares: this.canManageShares(actor),
      activeShareCount: shareCountRow?.n ?? 0,
    };
  }

  async listShares(
    principal: Principal | undefined,
    documentId: ID,
  ): Promise<readonly ResultShareSummary[]> {
    const actor = this.requirePrincipal(principal);
    const [docRow] = await this.store.db
      .select({ id: resultDocuments.id })
      .from(resultDocuments)
      .where(
        and(
          eq(resultDocuments.id, documentId),
          eq(resultDocuments.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);
    if (!docRow) {
      throw new DomainError('NOT_FOUND', 'Result document not found');
    }
    this.requireShareAdministrator(actor);

    const now = this.now();
    const rows = await this.store.db
      .select()
      .from(resultShareLinks)
      .where(
        and(
          eq(resultShareLinks.workspaceId, actor.workspaceId),
          eq(resultShareLinks.documentId, documentId),
        ),
      )
      .orderBy(desc(resultShareLinks.createdAt));

    return rows.map(row => ({
      id: row.id,
      documentId: row.documentId,
      operationId: row.operationId,
      label: row.label ?? null,
      state: shareStateOf(row, now),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      lastAccessedAt: row.lastAccessedAt ? row.lastAccessedAt.toISOString() : null,
      accessCount: row.accessCount,
    }));
  }

  async createShare(
    principal: Principal | undefined,
    documentId: ID,
    rawInput: unknown,
  ): Promise<CreatedResultShare> {
    const actor = this.requirePrincipal(principal);
    const [docRow] = await this.store.db
      .select()
      .from(resultDocuments)
      .where(
        and(
          eq(resultDocuments.id, documentId),
          eq(resultDocuments.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);
    if (!docRow) {
      throw new DomainError('NOT_FOUND', 'Result document not found');
    }
    this.requireShareAdministrator(actor);

    if (docRow.state !== 'DELIVERABLE') {
      throw new DomainError(
        'INVALID_STATE',
        'Only reviewed deliverable results can be shared externally',
      );
    }

    const parsed = createResultShareSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError('INVALID_INPUT', 'Invalid result share parameters');
    }
    const input: CreateResultShareInput = parsed.data;
    const now = this.now();

    const [activeCountRow] = await this.store.db
      .select({ n: sql<number>`count(*)::int` })
      .from(resultShareLinks)
      .where(
        and(
          eq(resultShareLinks.workspaceId, actor.workspaceId),
          eq(resultShareLinks.documentId, documentId),
          isNull(resultShareLinks.revokedAt),
          gt(resultShareLinks.expiresAt, now),
        ),
      );
    if ((activeCountRow?.n ?? 0) >= MAX_ACTIVE_SHARES_PER_DOCUMENT) {
      throw new DomainError('CONFLICT', 'Maximum active share links reached for this document');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashShareToken(token);
    const shareId = newId();
    const expiresAt = new Date(now.getTime() + input.expiresInHours * 3600 * 1000);
    const nowIso = now.toISOString();

    await this.store.db.transaction(async tx => {
      await tx.insert(resultShareLinks).values({
        id: shareId,
        workspaceId: actor.workspaceId,
        operationId: docRow.operationId,
        documentId: docRow.id,
        tokenHash,
        label: input.label ?? null,
        createdBy: actor.userId,
        createdAt: now,
        expiresAt,
        accessCount: 0,
      });
      const event = {
        id: newId(),
        workspaceId: actor.workspaceId,
        operationId: docRow.operationId as ID,
        kind: 'RESULT_SHARE_CREATED',
        actorId: actor.userId,
        data: {
          shareId,
          documentId: docRow.id,
          expiresAt: expiresAt.toISOString(),
          ...(input.label ? { label: input.label } : {}),
        },
        occurredAt: nowIso,
        eventVersion: 1,
      };
      await tx.insert(events).values({
        id: event.id,
        workspaceId: event.workspaceId,
        operationId: event.operationId,
        kind: event.kind,
        occurredAt: nowIso,
        payload: event,
      });
      await tx.insert(identityAudit).values({
        id: randomUUID(),
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        action: 'RESULT_SHARE_CREATE',
        outcome: 'SUCCESS',
      });
    });

    return {
      share: {
        id: shareId,
        documentId: docRow.id,
        operationId: docRow.operationId,
        label: input.label ?? null,
        state: 'ACTIVE',
        createdAt: nowIso,
        expiresAt: expiresAt.toISOString(),
        revokedAt: null,
        lastAccessedAt: null,
        accessCount: 0,
      },
      token,
      sharePath: `/results/shared/${token}`,
    };
  }

  async revokeShare(
    principal: Principal | undefined,
    documentId: ID,
    shareId: ID,
  ): Promise<ResultShareSummary> {
    const actor = this.requirePrincipal(principal);
    const [docRow] = await this.store.db
      .select({ id: resultDocuments.id, operationId: resultDocuments.operationId })
      .from(resultDocuments)
      .where(
        and(
          eq(resultDocuments.id, documentId),
          eq(resultDocuments.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);
    if (!docRow) {
      throw new DomainError('NOT_FOUND', 'Result document not found');
    }
    this.requireShareAdministrator(actor);

    const [existing] = await this.store.db
      .select()
      .from(resultShareLinks)
      .where(
        and(
          eq(resultShareLinks.id, shareId),
          eq(resultShareLinks.documentId, documentId),
          eq(resultShareLinks.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new DomainError('NOT_FOUND', 'Share link not found');
    }
    if (existing.revokedAt !== null) {
      throw new DomainError('CONFLICT', 'Share link is already revoked');
    }

    const now = this.now();
    const nowIso = now.toISOString();

    await this.store.db.transaction(async tx => {
      const updated = await tx
        .update(resultShareLinks)
        .set({ revokedAt: now, revokedBy: actor.userId })
        .where(
          and(
            eq(resultShareLinks.id, shareId),
            eq(resultShareLinks.workspaceId, actor.workspaceId),
            isNull(resultShareLinks.revokedAt),
          ),
        )
        .returning({ id: resultShareLinks.id });
      if (!updated.length) {
        throw new DomainError('CONFLICT', 'Share link is already revoked');
      }
      const event = {
        id: newId(),
        workspaceId: actor.workspaceId,
        operationId: docRow.operationId as ID,
        kind: 'RESULT_SHARE_REVOKED',
        actorId: actor.userId,
        data: { shareId, documentId },
        occurredAt: nowIso,
        eventVersion: 1,
      };
      await tx.insert(events).values({
        id: event.id,
        workspaceId: event.workspaceId,
        operationId: event.operationId,
        kind: event.kind,
        occurredAt: nowIso,
        payload: event,
      });
      await tx.insert(identityAudit).values({
        id: randomUUID(),
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        action: 'RESULT_SHARE_REVOKE',
        outcome: 'SUCCESS',
      });
    });

    return {
      id: existing.id,
      documentId: existing.documentId,
      operationId: existing.operationId,
      label: existing.label ?? null,
      state: 'REVOKED',
      createdAt: existing.createdAt.toISOString(),
      expiresAt: existing.expiresAt.toISOString(),
      revokedAt: nowIso,
      lastAccessedAt: existing.lastAccessedAt ? existing.lastAccessedAt.toISOString() : null,
      accessCount: existing.accessCount,
    };
  }

  async resolveSharedResult(rawToken: string): Promise<SharedAtlasResultView> {
    if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(rawToken)) {
      throw new DomainError('INVALID_INPUT', 'Invalid share token');
    }
    const tokenHash = hashShareToken(rawToken);
    const [shareRow] = await this.store.db
      .select()
      .from(resultShareLinks)
      .where(eq(resultShareLinks.tokenHash, tokenHash))
      .limit(1);
    if (!shareRow) {
      throw new DomainError('NOT_FOUND', 'Shared result link not found');
    }

    const now = this.now();
    if (shareRow.revokedAt !== null) {
      throw new DomainError('DENIED', 'Shared result link has been revoked');
    }
    if (shareRow.expiresAt.getTime() <= now.getTime()) {
      throw new DomainError('DENIED', 'Shared result link has expired');
    }

    const [docRow] = await this.store.db
      .select()
      .from(resultDocuments)
      .where(
        and(
          eq(resultDocuments.id, shareRow.documentId),
          eq(resultDocuments.workspaceId, shareRow.workspaceId),
        ),
      )
      .limit(1);
    if (!docRow || docRow.state !== 'DELIVERABLE') {
      throw new DomainError('NOT_FOUND', 'Shared result document unavailable');
    }

    await this.store.db
      .update(resultShareLinks)
      .set({
        accessCount: sql`${resultShareLinks.accessCount} + 1`,
        lastAccessedAt: now,
      })
      .where(eq(resultShareLinks.id, shareRow.id));

    const doc = docRow.document as unknown as ResultDocument;
    const classification = classifyDocument(doc);

    const sanitizeCitation = (citation: ResultCitation) => ({
      sourceId: citation.sourceId,
      provider: citation.provider,
      uri: redactCredentialUri(citation.uri),
      retrievedAt: citation.retrievedAt,
      publishedAt: citation.publishedAt,
      fingerprint: citation.fingerprint,
    });

    return {
      share: {
        id: shareRow.id,
        label: shareRow.label ?? null,
        createdAt: shareRow.createdAt.toISOString(),
        expiresAt: shareRow.expiresAt.toISOString(),
      },
      document: {
        id: doc.id,
        version: doc.version,
        title: doc.title,
        objective: doc.objective,
        status: docRow.state,
        scope: [...(doc.scope ?? [])],
        findings: (doc.findings ?? []).map(f => ({
          claimId: f.claimId,
          statement: f.statement,
          status: f.status,
          limitations: [...(f.limitations ?? [])],
          citations: (f.citations ?? []).map(sanitizeCitation),
        })),
        nextActions: [...(doc.nextActions ?? [])],
        limitations: [...(doc.limitations ?? [])],
        unresolved: [...(doc.unresolved ?? [])],
        citations: (doc.citations ?? []).map(sanitizeCitation),
        createdAt: docRow.createdAt,
        reviewedAt: doc.reviewedAt ?? null,
        hasPriorVersion: Boolean(doc.priorId || doc.version > 1),
        ...(doc.interpretations ? { interpretations: [...doc.interpretations] } : {}),
        ...(doc.businessPack ? { businessPack: { pack: doc.businessPack.pack, contractKey: doc.businessPack.contractKey } } : {}),
      },
      verdict: documentVerdict(doc, classification),
      verificationPosture: deriveVerificationPosture(doc, classification),
      deliverable: classification.deliverable,
      counts: classification.counts,
    };
  }
}
