/**
 * TASK 04 external-connector QA (isolated database + real read-only World Bank call).
 *
 * Verifies: operator-configured ToolRegistry activation only for reviewed providers; egress
 * policy/SSRF guards; provider rate limiting; ToolBroker permission, consent, budget and
 * provenance paths; source snapshots; disabled generic HTTP and unconfigured MCP boundaries;
 * and one mediated agent run whose broker tool call reads the documented World Bank Indicators
 * API over HTTPS. No provider response is fabricated: values surfaced in evidence come from the
 * live provider call. The local HTTP fixture is only the Hermes wire endpoint (deterministic
 * agent text), never a data provider.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  approvals, capabilities as capabilityTable, claims, engineSelections, evidences, executions,
  identityMemberships, identityUsers, identityWorkspaces, operationBudgets, resultDocuments,
  sourceSnapshots, sources, stepOutputs, toolLedger, toolIntents, usageLedger,
} from '@qeynox/persistence';
import { ConfigurationService, OperationExecutionService, PlanningService, CommerceService } from '@qeynox/application';
import {
  EgressPolicy, HttpJsonConnector, PgToolLedger, ToolBroker, UnconfiguredMcpGateway,
  createConfiguredToolRegistry, providerEnvironmentFromEnv, worldBankManifest,
  type ConnectorCall, type McpGateway, type PermissionContext,
} from '@qeynox/tools';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { createWorkerDependencies } from '../src/runtime';
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

interface FixtureRequest { readonly body: Record<string, unknown> }
interface HermesFixture { readonly port: number; readonly requests: FixtureRequest[]; readonly server: Server; close(): Promise<void> }
async function startHermesFixture(): Promise<HermesFixture> {
  const requests: FixtureRequest[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* non-JSON fixture request */ }
      requests.push({ body });
      response.setHeader('content-type', 'application/json');
      if (requests.length === 1) {
        response.end(JSON.stringify({
          id: 'qa-tool-proposal',
          choices: [{
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                kind: 'tool_proposals',
                summary: 'Requesting one World Bank indicator observation through ToolBroker',
                actions: [{
                  connectorId: 'world-bank', toolName: 'indicator', version: '1',
                  reason: 'Read the documented recent GDP indicator for the United States',
                  input: { country: 'USA', indicator: 'NY.GDP.MKTP.CD', mostRecent: 2 },
                }],
              }),
            },
          }],
          usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
        }));
        return;
      }
      response.end(JSON.stringify({
        id: 'qa-final',
        choices: [{ finish_reason: 'stop', message: { content: 'QA broker-mediated observation completed; no provider data was invented by the model.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  return { server, port: (server.address() as AddressInfo).port, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))) };
}
function toolPermission(base: Omit<PermissionContext, 'allowedConnectorTools' | 'capabilityId' | 'remainingToolCalls'>, overrides: Partial<PermissionContext> = {}): PermissionContext {
  return { ...base, allowedConnectorTools: ['world-bank:indicator@1'], capabilityId: 'capability-slot-1-v1' as ID, remainingToolCalls: 1, ...overrides };
}
function outputValue(value: unknown): { provider?: string; observations?: { date?: string; value?: number | null }[] } {
  return value as { provider?: string; observations?: { date?: string; value?: number | null }[] };
}

async function main(): Promise<void> {
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let fixture: HermesFixture | undefined;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDependencies>> | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);
    const ownerUserId = randomUUID(), workspaceId = randomUUID();
    await db.insert(identityUsers).values({ id: ownerUserId, email: 'qa-connector-' + ownerUserId + '@example.invalid' });
    await db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA Connector Workspace', createdBy: ownerUserId });
    await db.insert(identityMemberships).values({ id: randomUUID(), userId: ownerUserId, workspaceId, role: 'OWNER', status: 'ACTIVE' });
    const owner: Principal = { userId: ownerUserId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const attestation = new EgressPolicy({ attested: true, allowedHosts: ['api.worldbank.org'] });

    // No provider is registered without explicit operator configuration.
    const emptyRegistry = await createConfiguredToolRegistry(db, providerEnvironmentFromEnv());
    assert(emptyRegistry.available().length === 0, 'no provider is registered by default');

    process.env.QEYNOX_OPERATOR_USER_IDS = ownerUserId;
    process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
    process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
    process.env.QEYNOX_EGRESS_ALLOWED_HOSTS = 'api.worldbank.org';
    const configuration = new ConfigurationService(store);
    const configured = await configuration.apply(owner, {
      idempotencyKey: 'qa-connector-config-1',
      entries: [
        {
          domain: 'TOOL', connectorId: 'world-bank', version: '1', status: 'ACTIVE',
          manifest: {
            description: 'QA activation of the reviewed World Bank Indicators API v2 adapter',
            provider: 'World Bank', regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'], mode: 'READ_ONLY',
            licenseNotes: 'QA verification only; reuse and attribution terms require operator review',
            termsUrl: worldBankManifest.termsUrl,
            freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' },
            rateLimit: { maxPerMinute: 1 },
            tools: [{ name: 'indicator', version: '1' }],
          },
        },
        {
          domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA Indicator Capability',
          purpose: 'QA-only capability definition for verified provider connector mediation.',
          scope: ['QA connector scope'], allowedTools: ['world-bank:indicator@1'], privacyScopes: [],
          inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 3, maximumToolCalls: 2,
        },
        {
          domain: 'AGENT_PROFILE', slot: 1, version: 1, status: 'ACTIVE', title: 'QA Connector Agent',
          systemInstructions: 'QA-only connector agent: propose provider reads only through QeyNox tools and never invent provider data.',
          skillRefs: [], allowedTools: ['world-bank:indicator@1'], permittedContextKeys: [], maxOutputTokens: 256, maxIterations: 2,
        },
        {
          domain: 'RAAS_OFFER', offerId: 'qa-connector-offer', version: 1, status: 'ACTIVE', label: 'QA Connector Offer',
          capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA connector scope'], exclusions: [],
          regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-connector-terms', currency: 'USD', amountMinor: 0,
          taxPolicy: 'CONFIGURED', isExplicitlyFree: true,
        },
        {
          domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD',
          maxMoneyMinor: 1000, maxAgentCalls: 10, maxToolCalls: 10, maxDurationSeconds: 600, maxConcurrent: 2,
          unitMaxMinor: { hermes: 10, 'world-bank:indicator@1': 0 },
        },
      ],
    } as never);
    assert(configured.changes.length === 5, 'operator configuration activated the reviewed provider');

    fixture = await startHermesFixture();
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:' + fixture.port;
    process.env.HERMES_API_KEY = 'qa-hermes-key-' + randomUUID();
    process.env.HERMES_MODEL = 'qa-hermes-model';
    process.env.HERMES_NATIVE_TOOLS_ISOLATED = 'true';
    workerDeps = await createWorkerDependencies();
    assert(workerDeps.toolRegistry.available().includes('world-bank:indicator@1'), 'ToolRegistry registered the configured reviewed provider');
    assert(workerDeps.toolRegistry.manifest('world-bank').rateLimit.maxPerMinute === 1, 'operator-tightened provider rate limit applied');

    // Provider activation gates fail closed.
    await expectDomainError('NOT_CONFIGURED', () => createConfiguredToolRegistry(db, { worldBankEnabled: false, egress: attestation }), 'configured provider with deployment switch off');
    const unattested = new EgressPolicy({ attested: false, allowedHosts: ['api.worldbank.org'] });
    await expectDomainError('NOT_CONFIGURED', () => createConfiguredToolRegistry(db, { worldBankEnabled: true, egress: unattested }), 'registry built while egress attestation is absent');

    // Configuration can only use reviewed adapters: an unsupported configured provider fails closed.
    await configuration.apply(owner, {
      idempotencyKey: 'qa-connector-unknown-provider',
      entries: [{
        domain: 'TOOL', connectorId: 'qa-unknown-provider', version: '1', status: 'ACTIVE',
        manifest: {
          description: 'QA configuration for an unsupported provider identity', provider: 'QA Unsupported',
          regions: ['GLOBAL'], operations: ['QA_OPERATION'], mode: 'READ_ONLY', licenseNotes: 'QA fixture only',
          freshness: { ttlSeconds: 0, publishedAtSource: 'UNKNOWN' }, rateLimit: { maxPerMinute: 1 },
          tools: [{ name: 'query', version: '1' }],
        },
      }],
    } as never);
    await expectDomainError('NOT_CONFIGURED', () => createConfiguredToolRegistry(db, { worldBankEnabled: true, egress: attestation }), 'configured provider without a reviewed adapter');
    await configuration.apply(owner, {
      idempotencyKey: 'qa-connector-unknown-provider-disable',
      entries: [{
        domain: 'TOOL', connectorId: 'qa-unknown-provider', version: '1', status: 'DISABLED',
        manifest: {
          description: 'QA configuration for an unsupported provider identity', provider: 'QA Unsupported',
          regions: ['GLOBAL'], operations: ['QA_OPERATION'], mode: 'READ_ONLY', licenseNotes: 'QA fixture only',
          freshness: { ttlSeconds: 0, publishedAtSource: 'UNKNOWN' }, rateLimit: { maxPerMinute: 1 },
          tools: [{ name: 'query', version: '1' }],
        },
      }],
    } as never);

    // --- SSRF / egress guards, disabled HTTP and MCP boundaries. ---
    const policy = new EgressPolicy({ attested: true, allowedHosts: ['api.worldbank.org'] });
    policy.assertAllowed(new URL('https://api.worldbank.org/v2/country/USA/indicator/NY.GDP.MKTP.CD?format=json'));
    assertions++;
    await expectDomainError('DENIED', () => policy.assertAllowed(new URL('https://evil.example/steal')), 'allowlisted-host SSRF attempt');
    await expectDomainError('DENIED', () => policy.assertAllowed(new URL('http://api.worldbank.org/v2/country/USA/indicator/NY.GDP.MKTP.CD')), 'plain-HTTP provider endpoint');
    await expectDomainError('DENIED', () => policy.assertAllowed(new URL('https://user:pass@api.worldbank.org/x')), 'credentials embedded in provider URL');
    await expectDomainError('DENIED', () => policy.assertAllowed(new URL('https://api.worldbank.org:8443/x')), 'non-standard provider port');
    await expectDomainError('NOT_CONFIGURED', () => new EgressPolicy({ attested: false, allowedHosts: ['api.worldbank.org'] }).assertAllowed(new URL('https://api.worldbank.org/x')), 'unattested egress policy');
    const httpJson = new HttpJsonConnector('qa-http', 'https://example.invalid', undefined, []);
    await expectDomainError('NOT_CONFIGURED', () => httpJson.invoke('query', '1', {}, { principal: owner, operationId: 'op' as ID, stepAttemptId: 'attempt' as ID, signal: new AbortController().signal }), 'generic HTTP connector remains disabled');
    const mcpGateway: McpGateway = new UnconfiguredMcpGateway();
    await expectDomainError('UNSUPPORTED', () => mcpGateway.call({ server: 'qa', tool: 'qa', version: '1', input: {} }, new AbortController().signal), 'unconfigured MCP gateway');

    // --- Real read-only provider call through ToolBroker and rate limiting. ---
    const operating = await store.createOperation(owner, 'QA connector operation', 'Read one documented World Bank indicator through mediator policy', []);
    const planning = new PlanningService(store);
    const plan = await planning.create(owner, operating.id, operating.version, [{
      title: 'Read provider observation', description: 'Read a documented World Bank indicator via ToolBroker',
      capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH',
    }]);
    const readyOperation = await store.getOperation(owner, operating.id);
    const commerce = new CommerceService(store);
    const quote = await commerce.quote(owner, operating.id, 'qa-connector-offer', plan.revision.id) as { id: string };
    await commerce.accept(owner, quote.id as ID, 'qa-connector-acceptance-0001');
    const execution = new OperationExecutionService(store);
    const started = await execution.start(owner, operating.id, readyOperation.version, 'qa-connector-start-0001') as { attemptId: ID };
    assert(typeof started.attemptId === 'string', 'QA operation started with an attempt');

    const registry = await createConfiguredToolRegistry(db, { worldBankEnabled: true, egress: policy });
    const broker = new ToolBroker(registry, new PgToolLedger(db));
    const basePermission = {
      principal: owner, operationId: operating.id, planRevisionId: plan.revision.id,
      stepAttemptId: started.attemptId, profileId: 'qa-profile-business' as ID, profileVersion: 1,
      consentScopes: [], approvedRequests: [], remainingCostUnits: 0,
    } as const;
    const callFor = (key: string): ConnectorCall => ({
      operationId: operating.id, planRevisionId: plan.revision.id, stepAttemptId: started.attemptId,
      capabilityId: 'capability-slot-1-v1' as ID, connectorId: 'world-bank', toolName: 'indicator', version: '1',
      input: { country: 'USA', indicator: 'NY.GDP.MKTP.CD', mostRecent: 2 }, idempotencyKey: 'qa-broker-' + key, intentId: randomUUID() as ID,
    });
    const providerResult = await broker.invoke(callFor('direct-1'), toolPermission(basePermission));
    const providerValue = outputValue(providerResult.value);
    assert(providerValue.provider === 'world-bank', 'provider result identifies the reviewed provider');
    assert(Array.isArray(providerValue.observations) && providerValue.observations.length > 0, 'live provider returned at least one observation');
    assert(typeof providerResult.provenance.sourceUri === 'string' && new URL(providerResult.provenance.sourceUri).hostname === 'api.worldbank.org', 'provenance source URI is the documented provider host');
    assert(providerResult.provenance.responseDigest.length === 64, 'provenance records a response digest');
    const firstObservation = providerValue.observations?.[0];
    console.log('WORLD_BANK_LIVE_OBSERVATION', JSON.stringify({ indicator: 'NY.GDP.MKTP.CD', country: 'USA', date: firstObservation?.date, value: firstObservation?.value, sourceUri: providerResult.provenance.sourceUri }));

    await expectDomainError('BUDGET_EXHAUSTED', () => broker.invoke(callFor('direct-2'), toolPermission(basePermission)), 'provider rate limit');
    await expectDomainError('DENIED', () => broker.invoke(callFor('denied-tool-allowlist'), toolPermission(basePermission, { allowedConnectorTools: [] })), 'profile/capability tool allowlist');
    await expectDomainError('DENIED', () => broker.invoke(callFor('denied-capability'), toolPermission(basePermission, { capabilityId: 'capability-slot-9-v1' as ID })), 'tool capability scope');
    await expectDomainError('DENIED', () => broker.invoke(callFor('denied-tool-budget'), toolPermission(basePermission, { remainingToolCalls: 0 })), 'tool call budget');
    await expectDomainError('NOT_CONFIGURED', () => broker.invoke({ ...callFor('unknown-tool'), toolName: 'unknown' }, toolPermission(basePermission)), 'unknown provider tool');
    await expectDomainError('NOT_CONFIGURED', () => broker.invoke({ ...callFor('unknown-connector'), connectorId: 'qa-missing-provider' }, toolPermission(basePermission)), 'unknown provider connector');

    // --- Mediated agent run: Hermes proposes, ToolBroker performs the real provider read. ---
    const outcome = await workerDeps.handler({
      workspaceId: owner.workspaceId, operationId: operating.id, planRevisionId: plan.revision.id,
      stepAttemptId: started.attemptId, idempotencyKey: 'qa-connector-step-1',
    }, { workflowRunId: 'qa-connector-run-1' });
    assert(outcome.outcome === 'COMPLETED' && outcome.detail === 'AWAITING_REVIEW', 'mediated agent run completed and awaits review');
    const finalOperation = await store.getOperation(owner, operating.id);
    assert(finalOperation.status === 'WAITING_APPROVAL', 'operation reached human review after the provider read');

    const ledgerRows = await db.select().from(toolLedger).where(eq(toolLedger.operationId, operating.id));
    assert(ledgerRows.length >= 2, 'ToolBroker ledger records every mediated provider intent');
    assert(ledgerRows.every(row => row.outcome === 'COMPLETED' && row.connector === 'world-bank'), 'all mediated provider intents completed against the reviewed connector');
    const intentRows = await db.select().from(toolIntents).where(eq(toolIntents.operationId, operating.id));
    assert(intentRows.length === ledgerRows.length, 'every tool intent is persisted with its payload');
    const sourceRows = await db.select().from(sources).where(eq(sources.operationId, operating.id));
    assert(sourceRows.length === 1 && sourceRows[0]!.payload.provider === 'world-bank', 'provider response recorded as a captured source');
    assert(typeof sourceRows[0]!.payload.uri === 'string' && new URL(sourceRows[0]!.payload.uri!).hostname === 'api.worldbank.org', 'captured source preserves the provider citation URI');
    const snapshotRows = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.operationId, operating.id));
    assert(snapshotRows.length === 1, 'immutable source snapshot metadata persisted');
    assert(snapshotRows[0]!.sha256?.length === 64 && snapshotRows[0]!.citationUri?.includes('api.worldbank.org'), 'source snapshot stores digest and citation URI');
    const evidenceRows = await db.select().from(evidences).where(eq(evidences.operationId, operating.id));
    assert(evidenceRows.length >= 1 && evidenceRows.every(row => row.payload.status === 'UNVERIFIED'), 'provider observations remain unverified evidence');
    const claimRows = await db.select().from(claims).where(eq(claims.operationId, operating.id));
    assert(claimRows.length === 1 && claimRows[0]!.status === 'UNVERIFIED', 'agent finding recorded without fabricated verification');
    assert(await db.select().from(stepOutputs).where(eq(stepOutputs.operationId, operating.id)).then(rows => rows.length) === 1, 'step output persisted once');
    assert((await db.select().from(engineSelections).where(eq(engineSelections.operationId, operating.id))).length === 1, 'immutable engine selection persisted');
    assert((await db.select().from(approvals).where(eq(approvals.operationId, operating.id))).length === 1, 'human result review approval created');
    assert((await db.select().from(resultDocuments).where(eq(resultDocuments.operationId, operating.id))).length === 1, 'result document assembled');
    const budgets = await db.select().from(operationBudgets).where(eq(operationBudgets.operationId, operating.id));
    assert(budgets[0]?.usedToolCalls === 1, 'the mediated agent tool call counted against the operation budget');
    assert((await db.select().from(usageLedger).where(eq(usageLedger.operationId, operating.id))).length === 3, 'engine and tool reservations settle in the usage ledger');
    const executionsRows = await db.select().from(executions).where(eq(executions.operationId, operating.id));
    assert(executionsRows.length === 0, 'direct QA handler run does not fabricate a Hatchet execution link');
    // The tool intent payload carries the parsed provider input, and the model never supplies provider data.
    const providerIntent = intentRows.find(row => row.payload.toolName === 'world-bank:indicator@1');
    assert(providerIntent !== undefined && typeof (providerIntent.payload.payload as { country?: unknown }).country === 'string', 'broker intent persisted the fixed tool schema input');
    assert(fixture.requests.length === 2, 'agent loop used exactly one tool proposal round plus one final answer');

    // Disabling configuration removes the provider from the registry.
    await configuration.apply(owner, {
      idempotencyKey: 'qa-connector-disable',
      entries: [{
        domain: 'TOOL', connectorId: 'world-bank', version: '1', status: 'DISABLED',
        manifest: {
          description: 'QA activation of the reviewed World Bank Indicators API v2 adapter', provider: 'World Bank',
          regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'], mode: 'READ_ONLY',
          licenseNotes: 'QA verification only; reuse and attribution terms require operator review',
          termsUrl: worldBankManifest.termsUrl,
          freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' }, rateLimit: { maxPerMinute: 1 },
          tools: [{ name: 'indicator', version: '1' }],
        },
      }],
    } as never);
    const disabledRegistry = await createConfiguredToolRegistry(db, { worldBankEnabled: true, egress: policy });
    assert(disabledRegistry.available().length === 0, 'disabled provider configuration is not registered');

    console.log('Connector QA PASSED:', assertions, 'assertions');
  } finally {
    await workerDeps?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Connector QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});




