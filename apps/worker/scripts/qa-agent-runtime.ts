/**
 * TASK 03 agent-runtime QA (isolated database only).
 *
 * Verifies the installed Hatchet SDK contract, Hatchet dispatch/run-ID/cancellation adapters,
 * the Hermes wire adapter and its fail-closed isolation gate, real multi-step worker execution
 * with step progression/evidence/approvals, outbox dispatch and recovery, and Soul/Pilot wiring
 * to versioned agent profiles.
 *
 * No Hatchet server, Hermes model server or external provider is available in this environment:
 * - Hatchet adapters are verified against the installed SDK's declared contract through a
 *   deterministic contract double (clearly labelled); live dispatch stays NOT VERIFIED.
 * - Hermes is exercised over real HTTP against a local deterministic QA fixture, not a model.
 * The QA fixture and contract double are test harnesses, never product fallbacks.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  attempts, approvals, identityMemberships, identityUsers, identityWorkspaces,
  operationBudgets, resultDocuments,
} from '@qeynox/persistence';
import {
  CommerceService, ConfigurationService, OperationControlService, OperationExecutionService,
  PlanningService, RecoveryService,
} from '@qeynox/application';
import { AgentProfileStore, CapabilityRegistry, PilotService, SoulService } from '@qeynox/roles';
import { HermesAdapter, type EngineRequest, type AgentProfile } from '@qeynox/engine';
import { HatchetAdapter, PgOutboxDispatcher, createHatchetInspector, createHatchetRuntime, type ExecutionRequest, type OrchestratorPort } from '@qeynox/orchestration';
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
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
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
async function count(table: string, where: string, values: unknown[] = []): Promise<number> {
  const row = await pg.query<{ count: string }>('SELECT count(*)::text AS count FROM ' + table + ' WHERE ' + where, values);
  return Number(row.rows[0]?.count ?? -1);
}

let pg: import('pg').Pool;

interface CapturedRequest { readonly body: Record<string, unknown>; readonly authorization?: string }
interface Fixture { readonly port: number; readonly requests: CapturedRequest[]; readonly server: Server; close(): Promise<void> }
function extractTask(user: string): string {
  try {
    const parsed = JSON.parse(user) as { task?: unknown };
    return typeof parsed.task === 'string' ? parsed.task : user.slice(0, 120);
  } catch { return user.slice(0, 120); }
}
async function startFixture(mode: 'ok' | 'tool_calls'): Promise<Fixture> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* non-JSON fixture request */ }
      requests.push({ body, authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      if (mode === 'tool_calls') {
        response.end(JSON.stringify({
          id: 'qa-tool-call', choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }));
        return;
      }
      const messages = (body.messages as { role?: string; content?: string }[] | undefined) ?? [];
      const user = messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
      response.end(JSON.stringify({
        id: 'qa-completion-' + requests.length,
        choices: [{ message: { content: 'QA CONTROLLED OBSERVATION: ' + extractTask(user) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    server, port: (server.address() as AddressInfo).port, requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}
function profile(role: AgentProfile['role'], title: string): AgentProfile {
  return {
    id: ('qa-profile-' + role) as ID, role, version: 1, title,
    systemInstructions: 'QA-only ' + title + ' instructions: report only recorded observations; never invoke native tools.',
    skillRefs: [], allowedTools: [], permittedContextKeys: ['timezone'], maxOutputTokens: 256, maxIterations: 2,
  };
}
function engineRequest(profileValue: AgentProfile, workspaceId: ID, operationId: ID, attemptId: ID, message: string, context: Record<string, unknown> = {}): EngineRequest {
  return { workspaceId, operationId, stepAttemptId: attemptId, profile: profileValue, userMessage: message, context, correlationId: randomUUID() };
}
function lastUserContext(fixture: Fixture): Record<string, unknown> {
  const request = fixture.requests.at(-1);
  assert(request !== undefined, 'fixture received a Hermes request');
  const messages = (request!.body.messages as { role?: string; content?: string }[] | undefined) ?? [];
  const user = messages.filter(message => message.role === 'user').at(-1)?.content ?? '{}';
  try {
    const parsed = JSON.parse(user) as { context?: Record<string, unknown> };
    return parsed.context ?? {};
  } catch { return {}; }
}

async function main(): Promise<void> {
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let okFixture: Fixture | undefined;
  let toolFixture: Fixture | undefined;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDependencies>> | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated');

    connection = connectDatabase(qa.url);
    pg = connection.pool;
    const store = new QeyNoxStore(connection.db);
    const db = connection.db;
    const ownerUserId = randomUUID(), workspaceId = randomUUID();
    await db.insert(identityUsers).values({ id: ownerUserId, email: 'qa-agent-' + ownerUserId + '@example.invalid' });
    await db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA Agent Workspace', createdBy: ownerUserId });
    await db.insert(identityMemberships).values({ id: randomUUID(), userId: ownerUserId, workspaceId, role: 'OWNER', status: 'ACTIVE' });
    const owner: Principal = { userId: ownerUserId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };

    // --- Operator configuration: capability, business/soul/pilot profiles, free offer, budget. ---
    process.env.QEYNOX_OPERATOR_USER_IDS = ownerUserId;
    const configuration = new ConfigurationService(store);
    const configured = await configuration.apply(owner, {
      idempotencyKey: 'qa-agent-runtime-config-1',
      entries: [
        {
          domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA Agent Capability',
          purpose: 'QA-only capability definition for controlled agent runtime workflow verification.',
          scope: ['QA runtime scope'], allowedTools: [], privacyScopes: [], inputSchemaVersion: 1,
          outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2,
        },
        {
          domain: 'AGENT_PROFILE', slot: 1, version: 1, status: 'ACTIVE', title: 'QA Business Agent',
          systemInstructions: 'QA-only business profile: summarize only recorded observations and never use native tools.',
          skillRefs: [], allowedTools: [], permittedContextKeys: [], maxOutputTokens: 256, maxIterations: 2,
        },
        {
          domain: 'SOUL_PROFILE', version: 1, status: 'ACTIVE', title: 'QA Soul Profile',
          systemInstructions: 'QA-only soul profile: answer from consented context only and never use native tools.',
          skillRefs: [], allowedTools: [], permittedContextKeys: ['timezone'], maxOutputTokens: 256, maxIterations: 2,
        },
        {
          domain: 'PILOT_PROFILE', version: 1, status: 'ACTIVE', title: 'QA Pilot Profile',
          systemInstructions: 'QA-only pilot profile: advise from recorded operation state only and never use native tools.',
          skillRefs: [], allowedTools: [], permittedContextKeys: [], maxOutputTokens: 256, maxIterations: 2,
        },
        {
          domain: 'RAAS_OFFER', offerId: 'qa-runtime-offer', version: 1, status: 'ACTIVE', label: 'QA Runtime Offer',
          capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA runtime scope'], exclusions: [],
          regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-runtime-terms', currency: 'USD', amountMinor: 0,
          taxPolicy: 'CONFIGURED', isExplicitlyFree: true,
        },
        {
          domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD',
          maxMoneyMinor: 1000, maxAgentCalls: 10, maxToolCalls: 10, maxDurationSeconds: 600, maxConcurrent: 2,
          unitMaxMinor: { hermes: 10 },
        },
      ],
    } as never);
    assert(configured.changes.length === 6, 'operator configuration applied for the QA workflow');

    // --- Installed Hatchet SDK contract (no server/token provided; offline contract verification). ---
    const hatchetPrototype = HatchetClient.prototype as unknown as Record<string, unknown>;
    assert(typeof (HatchetClient as unknown as { init?: unknown }).init === 'function', 'installed SDK: HatchetClient.init exists');
    assert(typeof hatchetPrototype.task === 'function', 'installed SDK: client.task exists');
    assert(typeof hatchetPrototype.worker === 'function', 'installed SDK: client.worker exists');
    const runsDescriptor = Object.getOwnPropertyDescriptor(HatchetClient.prototype, 'runs');
    assert(runsDescriptor?.get !== undefined, 'installed SDK: client.runs accessor exists');
    delete process.env.HATCHET_CLIENT_TOKEN;
    await expectDomainError('NOT_CONFIGURED', () => createHatchetRuntime(async () => ({ outcome: 'COMPLETED' as const })), 'Hatchet runtime without a token');
    assert(createHatchetInspector() === undefined, 'Hatchet run inspection stays unsupported without a token');

    const contractEnqueued: ExecutionRequest[] = [];
    let cancelledRunId = '';
    const contractTask = { runNoWait: async (input: ExecutionRequest) => ({ getWorkflowRunId: async () => 'qa-sdk-run-' + (contractEnqueued.push(input)) }) };
    const contractClient = { runs: { cancel: async (options: { ids?: string[] }) => { cancelledRunId = options.ids?.[0] ?? ''; return {}; } } };
    const contractAdapter = new HatchetAdapter({ client: contractClient, task: contractTask } as unknown as ConstructorParameters<typeof HatchetAdapter>[0]);
    const sdkExecution = await contractAdapter.enqueue({ workspaceId: owner.workspaceId, operationId: 'op-1' as ID, planRevisionId: 'rev-1' as ID, stepAttemptId: 'attempt-1' as ID, idempotencyKey: 'qa-contract-key' });
    assert(sdkExecution.workflowRunId === 'qa-sdk-run-1', 'run-ID mapping uses WorkflowRunRef.getWorkflowRunId');
    assert(await contractAdapter.cancel('qa-sdk-run-1') === 'REQUESTED', 'cancellation calls the documented runs.cancel contract');
    assert(cancelledRunId === 'qa-sdk-run-1', 'cancellation targets the observed run ID');
    const missingRefAdapter = new HatchetAdapter({ client: contractClient, task: { runNoWait: async () => ({}) } } as unknown as ConstructorParameters<typeof HatchetAdapter>[0]);
    await expectDomainError('UNSUPPORTED', () => missingRefAdapter.enqueue({ workspaceId: owner.workspaceId, operationId: 'op-2' as ID, planRevisionId: 'rev-2' as ID, stepAttemptId: 'attempt-2' as ID, idempotencyKey: 'qa-contract-key-2' }), 'missing run identity fails closed');

    // --- Hermes fail-closed gates and native-tool rejection (real HTTP, deterministic QA fixture). ---
    okFixture = await startFixture('ok');
    toolFixture = await startFixture('tool_calls');
    const hermesApiKey = 'qa-hermes-key-' + randomUUID();
    const hermesBase = { apiKey: hermesApiKey, model: 'qa-hermes-model', timeoutMs: 5000 };
    const okBaseUrl = 'http://127.0.0.1:' + okFixture.port;
    const denialRequest = () => engineRequest(profile('soul', 'QA Hermes Gate'), owner.workspaceId, 'op-hermes' as ID, 'attempt-hermes' as ID, 'QA isolation gate check');
    await expectDomainError('NOT_CONFIGURED', () => new HermesAdapter({ ...hermesBase, baseUrl: okBaseUrl, nativeToolsIsolated: false, egressAttested: true }).invoke(denialRequest()), 'Hermes without native-tool isolation');
    await expectDomainError('NOT_CONFIGURED', () => new HermesAdapter({ ...hermesBase, baseUrl: okBaseUrl, nativeToolsIsolated: true, egressAttested: false }).invoke(denialRequest()), 'Hermes without egress attestation');
    await expectDomainError('DENIED', () => new HermesAdapter({ ...hermesBase, baseUrl: 'http://127.0.0.1:' + toolFixture!.port, nativeToolsIsolated: true, egressAttested: true }).invoke(denialRequest()), 'Hermes native tool call');
    const directOutcome = await new HermesAdapter({ ...hermesBase, baseUrl: okBaseUrl, nativeToolsIsolated: true, egressAttested: true }).invoke(denialRequest());
    assert(directOutcome.status === 'COMPLETED' && directOutcome.content.startsWith('QA CONTROLLED OBSERVATION:'), 'Hermes adapter parses the documented chat-completions wire response');
    assert(okFixture.requests.at(-1)?.authorization === 'Bearer ' + hermesApiKey, 'Hermes adapter sends the configured bearer credential');

    // --- Real worker execution of a two-step dependency plan. ---
    process.env.HERMES_API_BASE_URL = okBaseUrl;
    process.env.HERMES_API_KEY = hermesApiKey;
    process.env.HERMES_MODEL = 'qa-hermes-model';
    process.env.HERMES_NATIVE_TOOLS_ISOLATED = 'true';
    process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';

    const planning = new PlanningService(store);
    const capabilityId = 'capability-slot-1-v1' as ID;
    const operation = await store.createOperation(owner, 'QA multi-step agent operation', 'Controlled multi-step workflow for agent runtime certification', []);
    const plan = await planning.create(owner, operation.id, operation.version, [
      { title: 'Collect QA observation', description: 'Collect the first QA observation for the controlled workflow', capabilityId, dependsOnIndices: [], intent: 'RESEARCH' },
      { title: 'Analyze QA observation', description: 'Analyze the collected QA observation for the controlled workflow', capabilityId, dependsOnIndices: [0], intent: 'ANALYZE' },
    ]);
    const ready = await store.getOperation(owner, operation.id);
    const commerce = new CommerceService(store);
    const quote = await commerce.quote(owner, operation.id, 'qa-runtime-offer', plan.revision.id) as { id: string };
    const accepted = await commerce.accept(owner, quote.id as ID, 'qa-runtime-acceptance-0001');
    assert(accepted.state === 'AUTHORIZED', 'explicitly free offer authorizes the QA workflow');
    workerDeps = await createWorkerDependencies();
    assert(typeof workerDeps.handler === 'function' && typeof workerDeps.close === 'function', 'worker dependencies constructed with a shutdown hook');
    const execution = new OperationExecutionService(store);
    const started = await execution.start(owner, operation.id, ready.version, 'qa-runtime-start-0001') as { attemptId: ID; alreadyAccepted: boolean };
    assert(!started.alreadyAccepted && typeof started.attemptId === 'string', 'execution start created the first step attempt');
    assert(await count('outbox', 'operation_id=$1 AND state=$2', [operation.id, 'PENDING']) === 1, 'execution start queued exactly one dispatch intent');
    const duplicateStart = await execution.start(owner, operation.id, ready.version, 'qa-runtime-start-0001') as { attemptId: ID; alreadyAccepted: boolean };
    assert(duplicateStart.alreadyAccepted && duplicateStart.attemptId === started.attemptId, 'duplicate execution start is idempotent');

    const dispatchedRunIds: string[] = [];
    const qaOrchestrator: OrchestratorPort = {
      enqueue: async () => {
        const workflowRunId = 'qa-run-' + (dispatchedRunIds.length + 1);
        dispatchedRunIds.push(workflowRunId);
        return { provider: 'HATCHET', workflowRunId, requestedAt: new Date().toISOString() };
      },
      cancel: async () => 'UNSUPPORTED',
    };
    const dispatcher = new PgOutboxDispatcher(pg, qaOrchestrator);
    assert(await dispatcher.dispatchOnce() === 1, 'outbox dispatcher delivered the first step intent');
    assert(await count('execution_links', 'operation_id=$1', [operation.id]) === 1, 'dispatch recorded one execution link');
    const outboxState = await pg.query<{ state: string }>('SELECT state FROM outbox WHERE operation_id=$1 ORDER BY created_at LIMIT 1', [operation.id]);
    assert(outboxState.rows[0]?.state === 'SENT', 'dispatched outbox intent is marked SENT');

    const requestFor = (attemptId: ID, key: string): ExecutionRequest => ({ workspaceId: owner.workspaceId, operationId: operation.id, planRevisionId: plan.revision.id, stepAttemptId: attemptId, idempotencyKey: key });
    const firstOutcome = await workerDeps.handler(requestFor(started.attemptId, 'qa-runtime-step-1'), { workflowRunId: dispatchedRunIds[0]! });
    assert(firstOutcome.outcome === 'COMPLETED' && firstOutcome.detail === 'NEXT_QUEUED', 'worker completed step 1 and queued the dependent step');
    assert(await count('step_outputs', 'operation_id=$1', [operation.id]) === 1, 'step 1 output persisted');
    assert(await count('outbox', 'operation_id=$1 AND state=$2', [operation.id, 'PENDING']) === 1, 'step progression queued the second step intent');
    const secondAttempt = await db.select().from(attempts).where(and(eq(attempts.operationId, operation.id), eq(attempts.state, 'PENDING'))).limit(1);
    assert(secondAttempt.length === 1, 'dependent second attempt is pending');
    await expectDomainError('INVALID_STATE', () => workerDeps!.handler(requestFor(started.attemptId, 'qa-runtime-step-1-replay'), { workflowRunId: dispatchedRunIds[0]! }), 'completed attempt cannot be executed twice');

    assert(await dispatcher.dispatchOnce() === 1, 'outbox dispatcher delivered the second step intent');
    assert(await count('execution_links', 'operation_id=$1', [operation.id]) === 2, 'dispatch recorded both execution links');
    assert(dispatchedRunIds.length === 2 && dispatchedRunIds[1]! === 'qa-run-2', 'each dispatch received a distinct run ID');
    const secondOutcome = await workerDeps.handler(requestFor(secondAttempt[0]!.id as ID, 'qa-runtime-step-2'), { workflowRunId: dispatchedRunIds[1]! });
    assert(secondOutcome.outcome === 'COMPLETED' && secondOutcome.detail === 'AWAITING_REVIEW', 'worker completed the final step and requested human review');
    assert(await dispatcher.dispatchOnce() === 0, 'no duplicate dispatch remains');

    const completedOperation = await store.getOperation(owner, operation.id);
    assert(completedOperation.status === 'WAITING_APPROVAL', 'operation awaits human review after the last step');
    assert(await count('step_outputs', 'operation_id=$1', [operation.id]) === 2, 'both step outputs persisted');
    assert(await count('claims', 'operation_id=$1', [operation.id]) === 2, 'both agent findings recorded as unverified claims');
    assert(await count('evidence', 'operation_id=$1', [operation.id]) === 2, 'both observations recorded as unverified evidence');
    assert(await count('engine_selections', 'operation_id=$1', [operation.id]) === 2, 'each attempt bound one immutable engine/profile selection');
    assert(await count('result_documents', 'operation_id=$1', [operation.id]) === 1, 'result document assembled for review');
    const documentRow = await db.select().from(resultDocuments).where(eq(resultDocuments.operationId, operation.id)).limit(1);
    const documentState = (documentRow[0]?.document as { status?: string } | undefined)?.status;
    assert(documentRow.length === 1 && (documentState === 'PARTIAL' || documentState === 'DRAFT'), 'unsupported claims keep the result document out of DELIVERABLE');
    const pendingApproval = await db.select().from(approvals).where(and(eq(approvals.operationId, operation.id), eq(approvals.status, 'PENDING'))).limit(1);
    assert(pendingApproval.length === 1, 'exactly one RESULT_REVIEW approval is pending');
    const budgetRow = await db.select().from(operationBudgets).where(eq(operationBudgets.operationId, operation.id)).limit(1);
    assert(budgetRow[0]?.usedAgentCalls === 2, 'budget recorded exactly two engine calls');
    assert(await count('usage_ledger', 'operation_id=$1', [operation.id]) === 2, 'both engine reservations settled in the usage ledger');
    assert(await count('usage_reservations', 'operation_id=$1 AND state=$2', [operation.id, 'SETTLED']) === 2, 'both reservations settled');

    // --- Approvals, recovery and cancellation semantics are preserved. ---
    const controls = new OperationControlService(store);
    const decided = await controls.decideApproval(owner, pendingApproval[0]!.id as ID, 'APPROVED', operation.id);
    assert(decided.status === 'APPROVED', 'human result review decision recorded');

    await pg.query(
      "INSERT INTO outbox(id,workspace_id,operation_id,idempotency_key,topic,payload,state,attempts,next_attempt_at,created_at) VALUES($1,$2,$3,$4,'EXECUTE_STEP',$5,'UNKNOWN',1,$6,$6)",
      ['qa-unknown-outbox-' + randomUUID(), workspaceId, operation.id, 'qa-unknown-key-' + randomUUID(), JSON.stringify({}), new Date().toISOString()],
    );
    const recovery = new RecoveryService(store);
    const incidents = await recovery.reconcileDispatchUnknown(owner, operation.id);
    assert(incidents.length === 1 && incidents[0]!.status === 'OPEN', 'ambiguous dispatch became an open recovery incident');
    await expectDomainError('UNSUPPORTED', () => recovery.inspectRun(owner, operation.id, 'qa-run-1'), 'run observation fails closed without a Hatchet client');
    const abandoned = await recovery.action(owner, incidents[0]!.id as ID, 'ABANDON', 'QA: controlled recovery verification');
    assert(abandoned.status === 'ABANDONED', 'operator can abandon an ambiguous incident record');
    await pg.query(
      "INSERT INTO outbox(id,workspace_id,operation_id,idempotency_key,topic,payload,state,attempts,next_attempt_at,created_at) VALUES($1,$2,$3,$4,'EXECUTE_STEP',$5,'UNKNOWN',1,$6,$6)",
      ['qa-unknown-outbox-2-' + randomUUID(), workspaceId, operation.id, 'qa-unknown-key-2-' + randomUUID(), JSON.stringify({}), new Date().toISOString()],
    );
    const secondIncidents = await recovery.reconcileDispatchUnknown(owner, operation.id);
    await expectDomainError('UNKNOWN_OUTCOME', () => recovery.action(owner, secondIncidents[0]!.id as ID, 'RETRY_SAFE_READ', 'QA: must not replay ambiguous dispatch'), 'ambiguous dispatch is never retried blindly');

    // --- Soul and Pilot are wired to versioned profiles and the replaceable Hermes port. ---
    const profiles = new AgentProfileStore(db);
    const engine = new HermesAdapter({ baseUrl: okBaseUrl, apiKey: hermesApiKey, model: 'qa-hermes-model', timeoutMs: 5000, nativeToolsIsolated: true, egressAttested: true });
    const soul = new SoulService(store, profiles, engine);
    const consent = await soul.grantConsent(owner, 'QA context verification', ['context:read', 'context:write']);
    await soul.saveFact(owner, 'timezone', 'UTC', consent.id);
    await soul.saveFact(owner, 'secret-note', 'must-not-reach-engine', consent.id);
    const visible = await soul.viewContext(owner);
    assert(visible.length === 2, 'consented context visible to its owner');
    const soulOutcome = await soul.converse(owner, 'QA soul message', operation.id, started.attemptId);
    assert(soulOutcome.status === 'COMPLETED', 'Soul conversation used the active versioned soul profile through the engine port');
    const soulContext = lastUserContext(okFixture);
    assert(soulContext.timezone === 'UTC', 'soul profile permitted context reached the engine');
    assert(soulContext['secret-note'] === undefined, 'non-permitted context keys are filtered before engine invocation');
    const soulRequest = okFixture.requests.at(-1);
    const soulSystem = ((soulRequest!.body.messages as { role?: string; content?: string }[])[0]?.content) ?? '';
    assert(soulSystem.includes('QA-only soul profile'), 'soul invocation used the configured soul profile instructions');

    const pilot = new PilotService(store, new CapabilityRegistry(await store.getCapabilities()), profiles, engine);
    const nextAction = await pilot.nextAction(owner, operation.id);
    assert(nextAction.action === 'REVIEW_APPROVAL', 'pilot reports the recorded operation state');
    const pilotOutcome = await pilot.proposeBusinessStep(owner, operation.id, started.attemptId, capabilityId, 'QA pilot question');
    assert(pilotOutcome.status === 'COMPLETED', 'Pilot proposal invoked the active versioned pilot profile through the engine port');
    const pilotRequest = okFixture.requests.at(-1);
    const pilotSystem = ((pilotRequest!.body.messages as { role?: string; content?: string }[])[0]?.content) ?? '';
    assert(pilotSystem.includes('QA-only pilot profile'), 'pilot invocation used the configured pilot profile instructions');

    const latest = await store.getOperation(owner, operation.id);
    const interrupted = await controls.interrupt(owner, operation.id, latest.version);
    assert(interrupted.status === 'INTERRUPT_REQUESTED', 'interrupt records a request without claiming runtime cancellation');
    assert((await store.getOperation(owner, operation.id)).status === 'INTERRUPT_REQUESTED', 'interrupted operation state is explicit, not falsely cancelled');

    console.log('Agent runtime QA PASSED:', assertions, 'assertions');
  } finally {
    await workerDeps?.close().catch(() => undefined);
    await okFixture?.close().catch(() => undefined);
    await toolFixture?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Agent runtime QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});





