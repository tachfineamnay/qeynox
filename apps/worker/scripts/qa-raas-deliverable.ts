/**
 * TASK 05 RAAS deliverable QA (isolated database + one real read-only World Bank call).
 *
 * Objective -> Research -> Evidence -> Verification -> Result:
 * - a documented World Bank indicator read is mediated by ToolBroker and captured as source,
 *   evidence and immutable snapshot metadata (real provider value, no fabricated data);
 * - the claim is bound to its step capability and to the exact captured response digest;
 * - policy evaluation requires evidence-backed sources, freshness and contradiction handling and
 *   still demands human review;
 * - the reviewed result document is assembled with citations, approved, delivered as a new
 *   immutable version and exported as JSON/HTML through the existing artifact store contract.
 *
 * The in-memory artifact store and backdated/contradiction records used for negative tests are
 * QA fixtures only; they are never presented as delivered provider evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  approvals, artifactObjects, attempts, claims, commercialOrders, evidences, identityMemberships,
  identityUsers, identityWorkspaces, operations, resultDocuments, sourceSnapshots, sources,
} from '@qeynox/persistence';
import {
  ArtifactDelivery, ClaimsService, CommerceService, ConfigurationService, OperationControlService,
  OperationExecutionService, PlanningService, ResultAssembler, ResultDeliveryService, StepProgression,
  exportHtml, exportJson, type ArtifactStorePort, type ObjectReceipt, type ResultDocument,
} from '@qeynox/application';
import {
  PgToolLedger, ToolBroker, createConfiguredToolRegistry, egressPolicyFromEnv, type ConnectorCall, type PermissionContext,
} from '@qeynox/tools';
import { DomainError, type ID, type Principal, type Source } from '@qeynox/domain';
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
class QaMemoryArtifactStore implements ArtifactStorePort {
  private readonly objects = new Map<string, { content: Uint8Array; contentType: string }>();
  async put(key: string, content: Uint8Array, contentType: string): Promise<ObjectReceipt> {
    this.objects.set(key, { content, contentType });
    return { key, sha256: createHash('sha256').update(content).digest('hex'), size: content.byteLength };
  }
  async signedRead(key: string): Promise<string> {
    if (!this.objects.has(key)) throw new Error('QA artifact object missing');
    return 'qa-memory://' + encodeURIComponent(key);
  }
  content(key: string): Uint8Array | undefined { return this.objects.get(key)?.content; }
}
class UnconfiguredArtifactStore implements ArtifactStorePort {
  async put(): Promise<never> { throw new DomainError('NOT_CONFIGURED', 'Artifact store not configured'); }
  async signedRead(): Promise<never> { throw new DomainError('NOT_CONFIGURED', 'Artifact store not configured'); }
}

async function main(): Promise<void> {
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const pool = connection.pool;
    const store = new QeyNoxStore(db);
    const ownerUserId = randomUUID(), memberUserId = randomUUID(), workspaceId = randomUUID();
    await db.insert(identityUsers).values([
      { id: ownerUserId, email: 'qa-raas-owner-' + ownerUserId + '@example.invalid' },
      { id: memberUserId, email: 'qa-raas-member-' + memberUserId + '@example.invalid' },
    ]);
    await db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA RAAS Workspace', createdBy: ownerUserId });
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: ownerUserId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberUserId, workspaceId, role: 'MEMBER', status: 'ACTIVE' },
    ]);
    const owner: Principal = { userId: ownerUserId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const member: Principal = { userId: memberUserId as ID, workspaceId: workspaceId as ID, roles: ['MEMBER'] };

    process.env.QEYNOX_OPERATOR_USER_IDS = ownerUserId;
    process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
    process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
    process.env.QEYNOX_EGRESS_ALLOWED_HOSTS = 'api.worldbank.org';
    const validFrom = new Date(Date.now() - 86_400_000).toISOString();
    const configuration = new ConfigurationService(store);
    await configuration.apply(owner, {
      idempotencyKey: 'qa-raas-config-1',
      entries: [
        {
          domain: 'TOOL', connectorId: 'world-bank', version: '1', status: 'ACTIVE',
          manifest: {
            description: 'QA activation of the reviewed World Bank Indicators API v2 adapter',
            provider: 'World Bank', regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'], mode: 'READ_ONLY',
            licenseNotes: 'QA verification only; reuse and attribution terms require operator review',
            termsUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
            freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' },
            rateLimit: { maxPerMinute: 5 }, tools: [{ name: 'indicator', version: '1' }],
          },
        },
        {
          domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA Indicator Research',
          purpose: 'QA-only capability definition for a real sourced research deliverable.',
          scope: ['QA RAAS scope'], allowedTools: ['world-bank:indicator@1'], privacyScopes: [],
          inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 3, maximumToolCalls: 2,
        },
        {
          domain: 'AGENT_PROFILE', slot: 1, version: 1, status: 'ACTIVE', title: 'QA RAAS Agent',
          systemInstructions: 'QA-only research agent: propose provider reads through QeyNox tools and never invent data.',
          skillRefs: [], allowedTools: ['world-bank:indicator@1'], permittedContextKeys: [], maxOutputTokens: 256, maxIterations: 2,
        },
        {
          domain: 'BUSINESS_CAPABILITY', slot: 2, version: 1, status: 'ACTIVE', name: 'QA Unrelated Capability',
          purpose: 'QA-only second capability used to verify verification-policy capability binding.',
          scope: ['QA RAAS negative scope'], allowedTools: [], privacyScopes: [], inputSchemaVersion: 1,
          outputSchemaVersion: 1, maximumSteps: 2, maximumToolCalls: 1,
        },
        {
          domain: 'VERIFICATION_POLICY', capabilityId: 'capability-slot-1-v1', version: 1, status: 'ACTIVE',
          minimumSources: 1, maxAgeDays: 30, approvedProviders: ['world-bank'], humanReviewRequired: true, validFrom,
        },
        {
          domain: 'VERIFICATION_POLICY', capabilityId: 'capability-slot-2-v1', version: 1, status: 'ACTIVE',
          minimumSources: 1, maxAgeDays: 30, approvedProviders: ['world-bank'], humanReviewRequired: true, validFrom,
        },
        {
          domain: 'RAAS_OFFER', offerId: 'qa-raas-offer', version: 1, status: 'ACTIVE', label: 'QA RAAS Offer',
          capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA RAAS scope'], exclusions: [],
          regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-raas-terms', currency: 'USD', amountMinor: 0,
          taxPolicy: 'CONFIGURED', isExplicitlyFree: true,
        },
        {
          domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD',
          maxMoneyMinor: 1000, maxAgentCalls: 10, maxToolCalls: 10, maxDurationSeconds: 600, maxConcurrent: 2,
          unitMaxMinor: { hermes: 10, 'world-bank:indicator@1': 0 },
        },
      ],
    } as never);

    // --- Objective and research operation. ---
    const operation = await store.createOperation(owner, 'QA traceable indicator deliverable', 'Produce one traceable, citation-backed indicator finding for the United States', []);
    const planning = new PlanningService(store);
    const plan = await planning.create(owner, operation.id, operation.version, [{
      title: 'Read World Bank indicator', description: 'Read the documented World Bank GDP indicator for the United States',
      capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH',
    }]);
    const ready = await store.getOperation(owner, operation.id);
    const commerce = new CommerceService(store);
    const quote = await commerce.quote(owner, operation.id, 'qa-raas-offer', plan.revision.id) as { id: string };
    const acceptedOrder = await commerce.accept(owner, quote.id as ID, 'qa-raas-acceptance-0001');
    assert(acceptedOrder.state === 'AUTHORIZED', 'explicitly free QA offer authorized fulfilment');
    const execution = new OperationExecutionService(store);
    const started = await execution.start(owner, operation.id, ready.version, 'qa-raas-start-0001') as { attemptId: ID };
    assert(typeof started.attemptId === 'string', 'research step attempt created');

    const registry = await createConfiguredToolRegistry(db, { worldBankEnabled: true, egress: egressPolicyFromEnv() });
    const broker = new ToolBroker(registry, new PgToolLedger(db));
    const call: ConnectorCall = {
      operationId: operation.id, planRevisionId: plan.revision.id, stepAttemptId: started.attemptId,
      capabilityId: 'capability-slot-1-v1' as ID, connectorId: 'world-bank', toolName: 'indicator', version: '1',
      input: { country: 'USA', indicator: 'NY.GDP.MKTP.CD', mostRecent: 2 },
      idempotencyKey: 'qa-raas-research-1', intentId: randomUUID() as ID,
    };
    const permission: PermissionContext = {
      principal: owner, operationId: operation.id, planRevisionId: plan.revision.id, stepAttemptId: started.attemptId,
      capabilityId: 'capability-slot-1-v1' as ID, profileId: 'profile-business-1-v1' as ID, profileVersion: 1,
      allowedConnectorTools: ['world-bank:indicator@1'], consentScopes: [], approvedRequests: [],
      remainingCostUnits: 0, remainingToolCalls: 1,
    };
    const providerResult = await broker.invoke(call, permission);
    const providerValue = providerResult.value as { provider: string; country: string; indicator: string; observations: { date: string; value: number | null }[] };
    assert(providerValue.provider === 'world-bank', 'research observation came from the reviewed provider');
    assert(providerValue.observations.length > 0, 'live provider returned at least one observation');
    const observation = providerValue.observations[0]!;
    assert(typeof observation.date === 'string' && (typeof observation.value === 'number' || observation.value === null), 'provider observation has a documented date/value shape');
    const sourceId = randomUUID() as ID, evidenceId = randomUUID() as ID;
    const sourceFingerprint = providerResult.provenance.responseDigest;
    const sourceRecord = {
      id: sourceId, workspaceId: owner.workspaceId, operationId: operation.id,
      uri: providerResult.provenance.sourceUri, provider: providerResult.provenance.provider,
      title: 'World Bank indicator ' + providerValue.indicator, retrievedAt: providerResult.provenance.retrievedAt,
      fingerprint: sourceFingerprint,
    };
    await store.recordSource(sourceRecord);
    await store.recordEvidence({
      id: evidenceId, operationId: operation.id, sourceId, stepAttemptId: started.attemptId,
      statement: 'World Bank Indicators API reported ' + providerValue.indicator + ' for ' + providerValue.country + ' in ' + observation.date + ': ' + String(observation.value) + ' (current US$).',
      observedAt: new Date().toISOString(), status: 'UNVERIFIED', limitations: ['Provider response has not been independently reviewed'],
    });
    await db.insert(sourceSnapshots).values({ id: randomUUID(), workspaceId: workspaceId, operationId: operation.id, sourceId, provider: providerResult.provenance.provider, retrievedAt: providerResult.provenance.retrievedAt, sha256: sourceFingerprint, citationUri: providerResult.provenance.sourceUri, createdAt: new Date().toISOString() });
    const claimsService = new ClaimsService(store);
    const claimStatement = 'World Bank Indicators API reported GDP (current US$) for the United States in ' + observation.date + ' as ' + String(observation.value) + '.';
    const claim = await claimsService.register(owner, { operationId: operation.id, attemptId: started.attemptId, statement: claimStatement, kind: 'PROVIDER_OBSERVATION' });

    // --- Evidence linkage cannot rely on source count alone. ---
    await expectDomainError('INVALID_INPUT', () => claimsService.attach(owner, claim.id, sourceId, 'SUPPORTS'), 'support link without observation evidence');
    await expectDomainError('INVALID_INPUT', () => claimsService.attach(owner, claim.id, sourceId, 'SUPPORTS', evidenceId, '0'.repeat(64)), 'support link with a non-matching response digest');
    await claimsService.attach(owner, claim.id, sourceId, 'SUPPORTS', evidenceId, sourceFingerprint);
    const linked = await db.select().from(claims).where(eq(claims.id, claim.id));
    assert(linked.length === 1, 'claim persisted');

    // --- Verification: capability binding, policy evaluation, human review. ---
    await expectDomainError('DENIED', () => claimsService.assess(owner, { claimId: claim.id, capabilityId: 'capability-slot-2-v1' as ID, policyVersion: 1, reason: 'QA wrong capability check' }), 'policy capability mismatch');
    const policyAssessment = await claimsService.assess(owner, { claimId: claim.id, capabilityId: 'capability-slot-1-v1' as ID, policyVersion: 1, reason: 'QA policy evaluation' });
    assert(policyAssessment.status === 'NEEDS_HUMAN_REVIEW', 'policy assessment does not promote structural links to human-verified fact');
    assert(policyAssessment.sourceIds.includes(sourceId), 'assessment records the evidence-backed source');
    assert(policyAssessment.rationale.includes('evidence-backed sources') && policyAssessment.rationale.includes('publication freshness unknown'), 'assessment records source support and freshness limitation');
    await expectDomainError('DENIED', () => claimsService.assess(member, { claimId: claim.id, capabilityId: 'capability-slot-1-v1' as ID, policyVersion: 1, reason: 'QA member review attempt', reviewerDecision: 'SUPPORTED' }), 'unprivileged review');
    const humanAssessment = await claimsService.assess(owner, {
      claimId: claim.id, capabilityId: 'capability-slot-1-v1' as ID, policyVersion: 1,
      reason: 'QA reviewer verified the cited World Bank response for the generated deliverable', reviewerDecision: 'SUPPORTED',
    });
    assert(humanAssessment.status === 'SUPPORTED' && humanAssessment.method === 'HUMAN_REVIEW', 'human reviewer promoted the evidence-backed claim');
    const claimRow = (await db.select().from(claims).where(eq(claims.id, claim.id)))[0];
    assert(claimRow?.status === 'SUPPORTED', 'claim status is SUPPORTED after review');

    // --- Step progression, review approval and result assembly. ---
    const attemptRow = (await db.select().from(attempts).where(eq(attempts.id, started.attemptId)))[0];
    assert(attemptRow?.state === 'PENDING', 'research attempt waits for worker claim');
    const runningAttempt = { ...attemptRow.payload, state: 'RUNNING' as const, startedAt: new Date().toISOString(), version: attemptRow.payload.version + 1 };
    await db.update(attempts).set({ state: 'RUNNING', payload: runningAttempt }).where(and(eq(attempts.id, started.attemptId), eq(attempts.state, 'PENDING')));
    const progression = new StepProgression(store);
    const progressionState = await progression.complete(started.attemptId, { text: claim.statement, sourceId, evidenceId, quality: 'UNVERIFIED' }, 'UNVERIFIED');
    assert(progressionState === 'AWAITING_REVIEW', 'all plan steps completed and human review requested');
    const waiting = await store.getOperation(owner, operation.id);
    assert(waiting.status === 'WAITING_APPROVAL', 'operation waits for explicit result review');
    const approvalRows = await db.select().from(approvals).where(and(eq(approvals.operationId, operation.id), eq(approvals.status, 'PENDING')));
    assert(approvalRows.length === 1 && approvalRows[0]!.payload.purpose === 'RESULT_REVIEW', 'RESULT_REVIEW approval created');
    const documents = new ResultAssembler(store);
    const document = await documents.assemble(owner, operation.id, plan.revision.id, 'United States GDP indicator finding', ['QA RAAS scope'], []);
    assert(document.status === 'READY_FOR_REVIEW', 'document is READY_FOR_REVIEW only with supported, cited findings');
    assert(document.citations.length === 1 && document.citations[0]!.uri?.includes('api.worldbank.org/v2/country/USA/indicator/NY.GDP.MKTP.CD'), 'document carries the real provider citation URI');
    assert(document.citations[0]!.fingerprint === sourceFingerprint && document.citations[0]!.retrievedAt.length > 0, 'document citation preserves digest and retrieval time');
    assert(document.findings[0]?.status === 'SUPPORTED' && document.findings[0].citations.length === 1, 'finding is supported with an explicit citation');
    const deliveryService = new ResultDeliveryService(store);
    await expectDomainError('DENIED', () => deliveryService.deliver(owner, operation.id, document.id, approvalRows[0]!.id as ID), 'delivery before approval');
    const controls = new OperationControlService(store);
    const decided = await controls.decideApproval(owner, approvalRows[0]!.id as ID, 'APPROVED', operation.id);
    assert(decided.status === 'APPROVED', 'human RESULT_REVIEW approval recorded');
    const delivered = await deliveryService.deliver(owner, operation.id, document.id, approvalRows[0]!.id as ID);
    assert(delivered.status === 'DELIVERABLE' && delivered.operationStatus === 'COMPLETED', 'deliverable appended and operation completed');
    assert(delivered.documentId !== document.id && delivered.previousDocumentId === document.id, 'delivery appends an immutable document version');
    const releasedRow = (await db.select().from(resultDocuments).where(eq(resultDocuments.id, delivered.documentId)))[0];
    const released = releasedRow?.document as unknown as ResultDocument;
    assert(released.status === 'DELIVERABLE' && released.priorId === document.id && released.reviewedBy === ownerUserId, 'released version records review and supersession');
    assert(released.findings.every(f => f.status === 'SUPPORTED') && released.citations.length === 1, 'deliverable keeps supported findings and citations');
    const originalRow = (await db.select().from(resultDocuments).where(eq(resultDocuments.id, document.id)))[0];
    assert(originalRow?.state === 'READY_FOR_REVIEW', 'reviewed document version is retained in history');
    const orderRow = (await db.select().from(commercialOrders).where(eq(commercialOrders.operationId, operation.id)))[0];
    assert(orderRow?.state === 'DELIVERED', 'authorized order marked DELIVERED only after review');
    assert((await store.getOperation(owner, operation.id)).status === 'COMPLETED', 'operation history records COMPLETED');

    // --- Artifact exports through the existing storage contract. ---
    const unconfiguredArtifacts = new ArtifactDelivery(store, new UnconfiguredArtifactStore());
    await expectDomainError('NOT_CONFIGURED', () => unconfiguredArtifacts.save(owner, released, 'json', exportJson(released)), 'artifact export without configured storage');
    const pending = await db.select().from(artifactObjects).where(and(eq(artifactObjects.documentId, delivered.documentId), eq(artifactObjects.state, 'PENDING_UPLOAD')));
    assert(pending.length === 1, 'failed upload leaves PENDING_UPLOAD metadata, not a false AVAILABLE state');
    const memoryStore = new QaMemoryArtifactStore();
    const artifacts = new ArtifactDelivery(store, memoryStore);
    const jsonContent = exportJson(released), htmlContent = exportHtml(released);
    const jsonArtifact = await artifacts.save(owner, released, 'json', jsonContent);
    const htmlArtifact = await artifacts.save(owner, released, 'html', htmlContent);
    assert(jsonArtifact.sha256 === createHash('sha256').update(jsonContent).digest('hex'), 'JSON export digest is verified');
    assert(htmlArtifact.sha256 === createHash('sha256').update(htmlContent).digest('hex'), 'HTML export digest is verified');
    const available = await db.select().from(artifactObjects).where(and(eq(artifactObjects.documentId, delivered.documentId), eq(artifactObjects.state, 'AVAILABLE')));
    assert(available.length === 2, 'both exports become AVAILABLE only after verified upload');
    const grant = await artifacts.readGrant(owner, operation.id, delivered.documentId, jsonArtifact.artifactId);
    assert(grant.startsWith('qa-memory://'), 'signed read grant comes from the configured storage port');
    const html = Buffer.from(htmlContent).toString('utf8');
    assert(html.includes('https://api.worldbank.org/v2/country/USA/indicator/NY.GDP.MKTP.CD'), 'HTML export renders the real provider citation URI');
    assert(html.includes(observation.date) && html.includes(String(observation.value)), 'HTML export contains the actual provider observation date/value');
    assert(html.includes(sourceFingerprint), 'HTML export contains the response digest citation');
    const exportedJson = JSON.parse(Buffer.from(jsonContent).toString('utf8')) as ResultDocument;
    assert(exportedJson.citations[0]?.provider === 'world-bank' && exportedJson.status === 'DELIVERABLE', 'JSON export is a traceable DELIVERABLE document');

    // --- Post-delivery negative verification cases (never presented as delivered evidence). ---
    const staleClaim = await claimsService.register(owner, { operationId: operation.id, attemptId: started.attemptId, statement: 'QA stale-source negative fixture', kind: 'QA_NEGATIVE' });
    const sourceRow = (await db.select().from(sources).where(eq(sources.id, sourceId)))[0]!;
    const originalSource = sourceRow.payload as { retrievedAt: string };
    await db.update(sources).set({ payload: { ...sourceRow.payload, retrievedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() } as unknown as Source }).where(eq(sources.id, sourceId));
    await claimsService.attach(owner, staleClaim.id, sourceId, 'SUPPORTS', evidenceId, sourceFingerprint);
    const staleAssessment = await claimsService.assess(owner, { claimId: staleClaim.id, capabilityId: 'capability-slot-1-v1' as ID, policyVersion: 1, reason: 'QA stale source policy check' });
    assert(staleAssessment.status === 'STALE', 'expired source cannot support a claim');
    await db.update(sources).set({ payload: sourceRow.payload }).where(eq(sources.id, sourceId));
    assert(originalSource.retrievedAt.length > 0, 'real source retrieval timestamp restored after the negative fixture');
    const contradictionClaim = await claimsService.register(owner, { operationId: operation.id, attemptId: started.attemptId, statement: 'QA contradiction negative fixture', kind: 'QA_NEGATIVE' });
    await claimsService.attach(owner, contradictionClaim.id, sourceId, 'SUPPORTS', evidenceId, sourceFingerprint);
    await claimsService.attach(owner, contradictionClaim.id, sourceId, 'CONTRADICTS', evidenceId, sourceFingerprint);
    const contradictionAssessment = await claimsService.assess(owner, { claimId: contradictionClaim.id, capabilityId: 'capability-slot-1-v1' as ID, policyVersion: 1, reason: 'QA contradiction policy check' });
    assert(contradictionAssessment.status === 'CONFLICTING', 'qualifying contradicting evidence blocks support');
    const unsupportedClaim = await claimsService.register(owner, { operationId: operation.id, attemptId: started.attemptId, statement: 'QA reviewer-without-evidence negative fixture', kind: 'QA_NEGATIVE' });
    await expectDomainError('INVALID_STATE', () => claimsService.assess(owner, { claimId: unsupportedClaim.id, capabilityId: 'capability-slot-1-v1' as ID, policyVersion: 1, reason: 'QA reviewer must not support unsourced claim', reviewerDecision: 'SUPPORTED' }), 'reviewer cannot support an unevidenced claim');

    console.log('REAL_DELIVERABLE', JSON.stringify({
      operationId: operation.id,
      documentId: delivered.documentId,
      claim: claimStatement,
      citationUri: released.citations[0]?.uri,
      responseDigest: sourceFingerprint,
      retrievedAt: released.citations[0]?.retrievedAt,
      observation: { indicator: providerValue.indicator, country: providerValue.country, date: observation.date, value: observation.value },
      exports: { jsonSha256: jsonArtifact.sha256, htmlSha256: htmlArtifact.sha256 },
    }));
    console.log('RAAS deliverable QA PASSED:', assertions, 'assertions');
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('RAAS deliverable QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});





