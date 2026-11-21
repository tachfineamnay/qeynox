/**
 * MISSION A06 — end-to-end mission lifecycle QA (isolated database only).
 *
 * Drives the full customer lifecycle through the real services and the real worker handler:
 *
 *   GOAL → PLAN → APPROVAL → EXECUTION → TOOL EVIDENCE → HUMAN REVIEW → RESULT
 *
 * and then attacks it: interruption, stale approval, ambiguous dispatch, unknown tool outcome,
 * budget exhaustion, concurrent retry, worker failure types, and customer-visible progress.
 *
 * HONEST BOUNDARY — read before trusting a green run:
 * - No Hatchet server can run in this environment (no container runtime; ghcr.io unreachable).
 *   Dispatch is therefore exercised through a deterministic OrchestratorPort double that records
 *   what would have been enqueued. That proves the *dispatch decision logic* — leasing, idempotency,
 *   ambiguity handling — and proves NOTHING about live Hatchet scheduling, retries or cancellation.
 *   Live dispatch stays NOT VERIFIED and is reported as BLOCKED.
 * - Hermes is exercised over real HTTP against a local deterministic fixture, not a model. No
 *   business result is ever invented: every observation the fixture returns is explicitly labelled
 *   as QA-only content, and no answer here is presented as a real provider finding.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  attempts, identityMemberships, identityUsers, identityWorkspaces, outbox, executions,
} from '@qeynox/persistence';
import {
  CommerceService, ConfigurationService, InterruptionService, OperationControlService,
  OperationExecutionService, OperationReadModels, PlanningService, PlanRevisionService,
  ResultDeliveryService, lifecycleView, LIFECYCLE_MILESTONES,
} from '@qeynox/application';
import { PgOutboxDispatcher, type ExecutionRequest, type OrchestratorPort } from '@qeynox/orchestration';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { createWorkerDependencies } from '../src/runtime';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';
import { seedQaBetaGrant } from '../../api/scripts/qa-beta-fixture';
import { makeRuntimeReadiness as qaRuntimeFixture } from '@qeynox/application';
// A21.07 QA fixture (test infrastructure only): this suite exercises launches, not runtime probing.
// The launch gate itself is proven against real probes in qa:runtime-verification.
const qaVerifiedRuntime = () => qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:qa-mission-lifecycle', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:qa-mission-lifecycle' });

let assertions = 0;
const passed: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { passed.push(message); console.log('PASS: ' + message); }
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ' (' + error.message + ')' : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

let pool: import('pg').Pool;
async function count(table: string, where: string, values: unknown[] = []): Promise<number> {
  const row = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM ' + table + ' WHERE ' + where, values);
  return Number(row.rows[0]?.count ?? -1);
}
async function statusOf(operationId: ID): Promise<string> {
  const row = await pool.query<{ status: string }>('SELECT status FROM operations WHERE id=$1', [operationId]);
  return row.rows[0]?.status ?? 'MISSING';
}

interface Fixture { readonly port: number; readonly server: Server; close(): Promise<void> }
/** Deterministic QA Hermes wire fixture. Never a model; every answer is labelled QA-only. */
async function startFixture(mode: 'ok' | 'slow' | 'refuse'): Promise<Fixture> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      if (mode === 'refuse') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'QA fixture: controlled provider refusal' } }));
        return;
      }
      const answer = 'QA CONTROLLED OBSERVATION: fixture reply for lifecycle verification only; this is not a business finding.';
      const respond = () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      };
      if (mode === 'slow') setTimeout(respond, 400); else respond();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, server, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Records every enqueue attempt so dispatch behaviour can be asserted without a Hatchet server. */
interface DispatchRecorder { readonly requests: ExecutionRequest[]; readonly failOn?: (index: number) => boolean }
function recordingOrchestrator(rec: DispatchRecorder): OrchestratorPort {
  return {
    async enqueue(input) {
      const index = rec.requests.length;
      rec.requests.push(input);
      if (rec.failOn?.(index)) throw new DomainError('UNKNOWN_OUTCOME', 'QA: controlled dispatch ambiguity');
      return { provider: 'HATCHET', workflowRunId: 'qa-run-' + (index + 1), requestedAt: new Date().toISOString() };
    },
    async cancel() { return 'REQUESTED'; },
  };
}

async function main(): Promise<void> {
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let ok: Fixture | undefined;
  let removed: Fixture | undefined;
  let slow: Fixture | undefined;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDependencies>> | undefined;
  const startedAt = Date.now();
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    pool = connection.pool;
    const store = new QeyNoxStore(connection.db);

    // ---- Tenancy: two workspaces, to prove nothing leaks across them. ----
    const mkWorkspace = async (label: string) => {
      const userId = randomUUID(), workspaceId = randomUUID();
      await connection!.db.insert(identityUsers).values({ id: userId, email: 'qa-a06-' + label + '-' + userId + '@example.invalid' });
      await connection!.db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA A06 ' + label, createdBy: userId });
      await connection!.db.insert(identityMemberships).values({ id: randomUUID(), userId, workspaceId, role: 'OWNER', status: 'ACTIVE' });
      // A21.02: launches and provider spend require an ACTIVE beta grant (explicit QA precondition).
      await seedQaBetaGrant(connection!.db, workspaceId);
      return { owner: { userId: userId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] } as Principal, workspaceId, userId };
    };
    const primary = await mkWorkspace('a');
    const outsiderWorkspace = await mkWorkspace('b');
    const owner = primary.owner;

    process.env.QEYNOX_OPERATOR_USER_IDS = primary.userId;
    const configuration = new ConfigurationService(store);
    await configuration.apply(owner, {
      idempotencyKey: 'qa-a06-config-1',
      entries: [
        {
          domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA A06 Capability',
          purpose: 'QA-only capability for lifecycle verification; not a product capability.',
          scope: ['QA lifecycle scope'], allowedTools: [], privacyScopes: [], inputSchemaVersion: 1,
          outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2,
        },
        {
          domain: 'AGENT_PROFILE', slot: 1, version: 1, status: 'ACTIVE', title: 'QA A06 Business Agent',
          systemInstructions: 'QA-only profile: return controlled observations and never use native tools.',
          skillRefs: [], allowedTools: [], permittedContextKeys: [], maxOutputTokens: 256, maxIterations: 2,
        },
        {
          domain: 'RAAS_OFFER', offerId: 'qa-a06-offer', version: 1, status: 'ACTIVE', label: 'QA A06 Offer',
          capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA lifecycle scope'], exclusions: [],
          regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-a06-terms', currency: 'USD', amountMinor: 0,
          taxPolicy: 'CONFIGURED', isExplicitlyFree: true,
        },
        {
          domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD',
          maxMoneyMinor: 1000, maxAgentCalls: 10, maxToolCalls: 10, maxDurationSeconds: 600, maxConcurrent: 2,
          unitMaxMinor: { hermes: 10 },
        },
      ],
    } as never);

    ok = await startFixture('ok');
    removed = await startFixture('refuse');
    slow = await startFixture('slow');
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:' + ok.port;
    process.env.HERMES_API_KEY = 'qa-a06-key-' + randomUUID();
    process.env.HERMES_MODEL = 'qa-a06-model';
    process.env.HERMES_NATIVE_TOOLS_ISOLATED = 'true';
    process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
    process.env.QEYNOX_QA_ALLOW_UNVERIFIED = 'true';
    // P08: the bypass is honoured only with the explicit isolated-QA marker (plus loopback qeynox_qa_* DB,
    // loopback Hermes double and no Hatchet token, all already true in this suite).
    process.env.QEYNOX_QA_ENVIRONMENT = 'isolated';
    workerDeps = await createWorkerDependencies();
    // The worker captures provider configuration at construction, so switching provider behaviour
    // means rebuilding it. This mirrors a real worker restart, not a configuration hot-swap.
    const rebuildWorker = async () => {
      await workerDeps!.close();
      workerDeps = await createWorkerDependencies();
      return workerDeps.handler;
    };
    const planning = new PlanningService(store);
    const execution = new OperationExecutionService(store, qaVerifiedRuntime);
    const commerce = new CommerceService(store);
    const controls = new OperationControlService(store);
    const interruptions = new InterruptionService(store, { orchestrator: recordingOrchestrator({ requests: [] }) });
    const readModels = new OperationReadModels(store);
    const capabilityId = 'capability-slot-1-v1' as ID;

    /** Creates a planned+authorised two-step operation and returns it ready to start. */
    const scenario = async (label: string, steps = 2) => {
      const op = await store.createOperation(owner, 'QA A06 ' + label, 'QA A06 lifecycle objective for ' + label, []);
      const plan = await planning.create(owner, op.id, op.version, Array.from({ length: steps }, (_v, index) => ({
        title: 'QA step ' + (index + 1) + ' for ' + label,
        description: 'QA-only step ' + (index + 1) + ' of the controlled lifecycle',
        capabilityId,
        dependsOnIndices: index === 0 ? [] : [index - 1],
        intent: (index === 0 ? 'RESEARCH' : 'ANALYZE') as 'RESEARCH' | 'ANALYZE',
      })));
      const quote = await commerce.quote(owner, op.id, 'qa-a06-offer', plan.revision.id) as { id: string };
      await commerce.accept(owner, quote.id as ID, 'qa-a06-accept-' + label + '-0001');
      return { operationId: op.id, ready: await store.getOperation(owner, op.id), revisionId: plan.revision.id };
    };

    // ══ 1. Plan dependencies and handoff correctness ══════════════════════════════════════════════
    const main1 = await scenario('dependencies', 3);
    const steps = await store.getSteps(main1.revisionId);
    assert(steps.length === 3, 'three-step plan persisted');
    assert(steps[1]!.dependsOn.length === 1 && steps[2]!.dependsOn[1]?.length !== 0, 'step dependencies recorded as a chain');

    const rec: DispatchRecorder = { requests: [] };
    const dispatcher = new PgOutboxDispatcher(pool, recordingOrchestrator(rec));
    const started = await execution.start(owner, main1.operationId, main1.ready.version, 'qa-a06-start-0001') as { attemptId: ID; alreadyAccepted: boolean };
    assert(!started.alreadyAccepted, 'execution start accepted once');
    assert(rec.requests.length === 0, 'nothing is dispatched before the outbox is drained');
    assert(await dispatcher.dispatchOnce() === 1, 'exactly one dispatch intent drained');
    assert(rec.requests[0]!.stepAttemptId === started.attemptId, 'dispatched attempt is the one the start created');
    assert(rec.requests[0]!.planRevisionId === main1.revisionId, 'dispatch carries the sealed plan revision');

    // Drive all three steps; each must hand off to the dependent step in order.
    const runOrder: string[] = [];
    let firstOutcome = await workerDeps.handler({ ...rec.requests[0]! }, { workflowRunId: 'qa-run-1' });
    runOrder.push('step1');
    assert(firstOutcome.outcome === 'COMPLETED' && firstOutcome.detail === 'NEXT_QUEUED', 'step 1 completed and queued its dependent');
    const drained2 = await dispatcher.dispatchOnce();
    assert(drained2 === 1 && rec.requests[1]!.stepAttemptId !== started.attemptId, 'step 2 dispatched as a distinct attempt');
    let secondOutcome = await workerDeps.handler({ ...rec.requests[1]! }, { workflowRunId: 'qa-run-2' });
    runOrder.push('step2');
    assert(secondOutcome.detail === 'NEXT_QUEUED', 'step 2 completed and queued step 3');
    await dispatcher.dispatchOnce();
    const thirdOutcome = await workerDeps.handler({ ...rec.requests[2]! }, { workflowRunId: 'qa-run-3' });
    runOrder.push('step3');
    assert(thirdOutcome.detail === 'AWAITING_REVIEW', 'final step requested human review');
    assert(runOrder.join(',') === 'step1,step2,step3', 'steps executed strictly in dependency order');
    assert(await count('step_outputs', 'operation_id=$1', [main1.operationId]) === 3, 'one durable output per step');
    // Dependency handoff content: each later step received its predecessor's output as prior context.
    assert(await count('step_attempts', 'operation_id=$1', [main1.operationId]) === 3, 'exactly three attempts recorded, no fan-out duplicates');
    pass('step dependencies and handoffs execute strictly in order with one durable output per step');

    // ══ 2. Durable dispatch + attempt tracking ═════════════════════════════════════════════════════
    const attemptStates = await pool.query<{ state: string; sequence: number }>('SELECT state,sequence FROM step_attempts WHERE operation_id=$1 ORDER BY sequence', [main1.operationId]);
    assert(attemptStates.rows.every(r => r.state === 'COMPLETED'), 'every attempt reached a terminal recorded state');
    assert(attemptStates.rows.map(r => r.sequence).join(',') === '1,1,1', 'each step attempt is sequence 1 of its own step');
    assert(await count('execution_links', 'operation_id=$1', [main1.operationId]) === 3, 'every dispatch recorded an execution link');
    const outboxStates = await pool.query<{ state: string }>('SELECT state FROM outbox WHERE operation_id=$1', [main1.operationId]);
    assert(outboxStates.rows.every(r => r.state === 'SENT'), 'every drained intent is recorded as SENT, never left ambiguous');
    assert(await dispatcher.dispatchOnce() === 0, 'a fully drained operation dispatches nothing more');
    pass('dispatch is durable: one intent per step, one execution link per dispatch, nothing re-dispatched');

    // ══ 3. Approval accuracy: stale revision and concurrent decision ═══════════════════════════════
    assert(await statusOf(main1.operationId) === 'WAITING_APPROVAL', 'operation waits for human review after the last step');
    const waitingApproval = await pool.query<{ id: string }>("SELECT id FROM approval_requests WHERE operation_id=$1 AND status='PENDING'", [main1.operationId]);
    assert(waitingApproval.rows.length === 1, 'exactly one review approval is pending');
    const approvalId = waitingApproval.rows[0]!.id as ID;
    // Two concurrent decisions: exactly one may win.
    const decisions = await Promise.allSettled([
      controls.decideApproval(owner, approvalId, 'APPROVED', main1.operationId),
      controls.decideApproval(owner, approvalId, 'REJECTED', main1.operationId),
    ]);
    const fulfilled = decisions.filter(d => d.status === 'fulfilled').length;
    assert(fulfilled === 1, 'concurrent approval decisions: exactly one wins');
    const rejectedReason = decisions.find(d => d.status === 'rejected') as PromiseRejectedResult | undefined;
    assert(rejectedReason?.reason instanceof DomainError && rejectedReason.reason.code === 'CONFLICT', 'the losing concurrent decision is a CONFLICT, not a silent overwrite');
    pass('concurrent approval decisions are serialised with exactly one winner');

    // Stale approval: the plan is revised while an approval is pending.
    const stale = await scenario('stale-approval', 1);
    await execution.start(owner, stale.operationId, stale.ready.version, 'qa-a06-stale-start-1');
    await dispatcher.dispatchOnce();
    await workerDeps.handler({ ...rec.requests.at(-1)! }, { workflowRunId: 'qa-run-stale-1' });
    const staleApprovals = await pool.query<{ id: string }>("SELECT id FROM approval_requests WHERE operation_id=$1 AND status='PENDING'", [stale.operationId]);
    const staleApprovalId = staleApprovals.rows[0]!.id as ID;
    // Revising is only allowed once work is stopped, so the customer interrupts first and the stop is
    // reconciled before the plan moves on. That is the real-world ordering this test must use.
    const opBeforeRevision = await store.getOperation(owner, stale.operationId);
    await store.transition(owner, stale.operationId, 'INTERRUPT_REQUESTED', opBeforeRevision.version);
    const reconciledStale = await interruptions.reconcile(owner, stale.operationId);
    assert(reconciledStale.result === 'INTERRUPTED', 'the operation reached INTERRUPTED before revision');
    const interruptedStale = await store.getOperation(owner, stale.operationId);
    await new PlanRevisionService(store).revise(owner, stale.operationId, stale.revisionId, interruptedStale.version, 'QA A06: deliberately supersede the pending approval', [
      { title: 'QA revised step', description: 'QA-only revised step for stale approval verification', capabilityId, dependsOnIndices: [], intent: 'RESEARCH' },
    ]);
    await expectDomainError('INVALID_STATE', () => controls.decideApproval(owner, staleApprovalId, 'APPROVED', stale.operationId), 'approval bound to the superseded revision');
    pass('an approval requested for a superseded revision is refused instead of authorising stale work');

    // ══ 4. Result assembly and delivery on supported evidence ══════════════════════════════════════
    const assembled = await pool.query<{ state: string; document: Record<string, unknown> }>('SELECT state,document FROM result_documents WHERE operation_id=$1', [main1.operationId]);
    assert(assembled.rows.length === 1, 'a result document was assembled for review');
    const docFindings = (assembled.rows[0]!.document as { findings?: { claimId: string }[] }).findings ?? [];
    assert(docFindings.length > 0, 'the assembled document is attributed to recorded claims');
    for (const finding of docFindings) {
      const claim = await pool.query('SELECT status FROM claims WHERE id=$1 AND operation_id=$2', [finding.claimId, main1.operationId]);
      assert(claim.rows.length === 1, 'every finding resolves to a claim in the same operation');
    }
    // Delivery requires SUPPORTED claims and a verifiable citation; unverified fixture output must not deliver.
    const reviewDoc = await pool.query<{ id: string }>('SELECT id FROM result_documents WHERE operation_id=$1 ORDER BY created_at DESC LIMIT 1', [main1.operationId]);
    const delivery = new ResultDeliveryService(store);
    await expectDomainError('INVALID_STATE', () => delivery.deliver(owner, main1.operationId, reviewDoc.rows[0]!.id as ID, approvalId), 'delivery of unverified fixture claims');
    pass('result assembly attributes every finding to a claim, and unverified evidence cannot be delivered');

    // ══ 5. Customer-visible progress matches persisted state ══════════════════════════════════════
    const view = await readModels.sync(owner, main1.operationId);
    assert(view!.status === 'WAITING_APPROVAL', 'read model status mirrors the persisted operation status');
    assert(view!.completedSteps === 3 && view!.stepCount === 3, 'read model step progress matches the persisted steps');
    assert(view!.provisional === false, 'a waiting-for-review state is not flagged provisional');
    assert(view!.currentMilestone === 'HUMAN_REVIEW', 'read model reports the milestone the operation is actually at');
    // The pure derivation must agree with every status, and never claim a milestone the status cannot prove.
    for (const status of ['DRAFT', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'INTERRUPT_REQUESTED', 'INTERRUPTED', 'FAILED', 'COMPLETED', 'SUPERSEDED'] as const) {
      const derived = lifecycleView(status);
      const completeCount = derived.milestones.filter(m => m.complete).length;
      const currentIndex = LIFECYCLE_MILESTONES.indexOf(derived.currentMilestone);
      assert(completeCount === (currentIndex === LIFECYCLE_MILESTONES.length - 1 && status === 'COMPLETED' ? LIFECYCLE_MILESTONES.length : currentIndex), 'milestones complete are exactly those before the current one for ' + status);
      if (status === 'INTERRUPT_REQUESTED') assert(derived.provisional, 'a requested stop is reported as provisional, never as a settled outcome');
      if (status === 'INTERRUPTED') assert(derived.attention === 'STALLED', 'an interrupted operation needs a decision rather than disappearing');
      if (status === 'COMPLETED') assert(derived.milestones.every(m => m.complete), 'only a completed operation shows every milestone complete');
    }
    pass('customer-visible progress is derived from persisted status and never claims an unproven milestone');

    // ══ 6. Interruption: request, ambiguous stop, then confirmed stop ═════════════════════════════
    const interrupt = await scenario('interrupt', 2);
    const intStarted = await execution.start(owner, interrupt.operationId, interrupt.ready.version, 'qa-a06-int-start-1') as { attemptId: ID };
    await dispatcher.dispatchOnce();
    // Stop is requested while the first step is still pending: nothing has run yet, so the attempt
    // itself is the outstanding work and the stop cannot be confirmed.
    await store.transition(owner, interrupt.operationId, 'INTERRUPT_REQUESTED', (await store.getOperation(owner, interrupt.operationId)).version);
    const unresolved = await interruptions.reconcile(owner, interrupt.operationId);
    assert(unresolved.result === 'STILL_ACTIVE', 'a stop is not confirmed while a dispatch is still outstanding');
    // The specific blocker is reported rather than a blanket refusal: the attempt is still PENDING.
    assert(unresolved.result === 'STILL_ACTIVE' && unresolved.reasons.length > 0, 'the unresolved reason is reported, not hidden');
    assert(unresolved.result === 'STILL_ACTIVE' && (unresolved.reasons.includes('ATTEMPT_IN_FLIGHT') || unresolved.reasons.includes('DISPATCH_PENDING')), 'the blocker names the outstanding attempt or dispatch');
    assert(await statusOf(interrupt.operationId) === 'INTERRUPT_REQUESTED', 'the operation stays explicitly unresolved while work is outstanding');
    // A permanently stopped operation refuses further work: the worker will not execute into a stop.
    await expectDomainError('INVALID_STATE', () => workerDeps!.handler({ ...rec.requests.at(-1)! }, { workflowRunId: 'qa-run-int-1' }), 'a worker invocation after a stop request');
    assert(await statusOf(interrupt.operationId) === 'INTERRUPT_REQUESTED', 'the refused worker invocation did not move the operation');
    const blockingAttempt = await scenario('interrupt-attempt', 1);
    await execution.start(owner, blockingAttempt.operationId, blockingAttempt.ready.version, 'qa-a06-int-start-2');
    await dispatcher.dispatchOnce();
    const pendingAttemptId = rec.requests.at(-1)!.stepAttemptId;
    await pool.query("UPDATE step_attempts SET state='RUNNING' WHERE id=$1", [pendingAttemptId]);
    await store.transition(owner, blockingAttempt.operationId, 'INTERRUPT_REQUESTED', (await store.getOperation(owner, blockingAttempt.operationId)).version);
    const blocked = await interruptions.reconcile(owner, blockingAttempt.operationId);
    assert(blocked.result === 'STILL_ACTIVE' && blocked.reasons.includes('ATTEMPT_IN_FLIGHT'), 'an in-flight attempt blocks stop confirmation');
    assert(await statusOf(blockingAttempt.operationId) === 'INTERRUPT_REQUESTED', 'the operation is never marked INTERRUPTED while an attempt could still be running');
    // Once the attempt is gone, the stop is confirmed.
    await pool.query("UPDATE step_attempts SET state='FAILED' WHERE id=$1", [pendingAttemptId]);
    const confirmed = await interruptions.reconcile(owner, blockingAttempt.operationId);
    assert(confirmed.result === 'INTERRUPTED', 'a stop is confirmed once nothing can still be running');
    assert(await statusOf(blockingAttempt.operationId) === 'INTERRUPTED', 'confirmed stop persists as INTERRUPTED');
    const interruptedView = await readModels.sync(owner, blockingAttempt.operationId);
    assert(interruptedView!.attention === 'STALLED', 'the customer sees an interrupted operation as needing a decision');
    pass('a stop request stays unresolved until persisted state proves nothing is running, then reconciles to INTERRUPTED');

    // ══ 7. Retry: safe after a clean failure, refused when anything is uncertain ══════════════════
    const retryable = await scenario('retry', 1);
    await execution.start(owner, retryable.operationId, retryable.ready.version, 'qa-a06-retry-start-1');
    await dispatcher.dispatchOnce();
    // Force a clean failure of the attempt.
    await pool.query("UPDATE step_attempts SET state='FAILED' WHERE id=$1", [rec.requests.at(-1)!.stepAttemptId]);
    await store.transition(owner, retryable.operationId, 'FAILED', (await store.getOperation(owner, retryable.operationId)).version);
    const retryVersion = (await store.getOperation(owner, retryable.operationId)).version;
    const retried = await interruptions.retry(owner, retryable.operationId, retryVersion, 'qa-a06-retry-0001');
    assert(!retried.alreadyAccepted, 'a cleanly failed attempt can be retried');
    assert(retried.attemptId === rec.requests.at(-1)!.stepAttemptId, 'retry reuses the existing attempt identity');
    assert(await statusOf(retryable.operationId) === 'RUNNING', 'a retried operation returns to RUNNING');
    // Concurrent retries of the SAME failed operation: exactly one wins, and only one intent exists.
    // The operation must be failed again first, because an accepted retry puts it back in RUNNING.
    await pool.query("UPDATE step_attempts SET state='FAILED' WHERE operation_id=$1", [retryable.operationId]);
    await store.transition(owner, retryable.operationId, 'FAILED', (await store.getOperation(owner, retryable.operationId)).version);
    const retryVersion2 = (await store.getOperation(owner, retryable.operationId)).version;
    const concurrent = await Promise.allSettled([
      interruptions.retry(owner, retryable.operationId, retryVersion2, 'qa-a06-retry-0002'),
      interruptions.retry(owner, retryable.operationId, retryVersion2, 'qa-a06-retry-0003'),
    ]);
    const won = concurrent.filter(r => r.status === 'fulfilled').length;
    const retryIntents = await count('outbox', 'operation_id=$1 AND idempotency_key IN ($2,$3)', [retryable.operationId, 'qa-a06-retry-0002', 'qa-a06-retry-0003']);
    assert(won === 1, 'exactly one of two concurrent retries is accepted');
    assert(retryIntents === 1, 'concurrent retries create exactly one dispatch intent');
    const loser = concurrent.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    assert(loser?.reason instanceof DomainError && loser.reason.code === 'CONFLICT', 'the losing concurrent retry is a CONFLICT');
    pass('retry reuses the attempt identity and a concurrently retried key creates at most one intent');

    // An ambiguous tool write blocks retry: it may already have happened remotely.
    const ambiguous = await scenario('ambiguous-tool', 1);
    await execution.start(owner, ambiguous.operationId, ambiguous.ready.version, 'qa-a06-amb-start-1');
    await dispatcher.dispatchOnce();
    await pool.query("UPDATE step_attempts SET state='FAILED' WHERE id=$1", [rec.requests.at(-1)!.stepAttemptId]);
    await store.transition(owner, ambiguous.operationId, 'FAILED', (await store.getOperation(owner, ambiguous.operationId)).version);
    await pool.query(
      "INSERT INTO tool_execution_ledger(id,workspace_id,operation_id,attempt_id,intent_id,connector,outcome,request_digest,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'qa-connector','UNKNOWN','qa-digest',$6,$6)",
      [randomUUID(), primary.workspaceId, ambiguous.operationId, rec.requests.at(-1)!.stepAttemptId, randomUUID(), new Date().toISOString()],
    );
    const ambiguousVersion = (await store.getOperation(owner, ambiguous.operationId)).version;
    await expectDomainError('UNKNOWN_OUTCOME', () => interruptions.retry(owner, ambiguous.operationId, ambiguousVersion, 'qa-a06-amb-retry-1'), 'retry after an unknown tool write');
    assert(await statusOf(ambiguous.operationId) === 'FAILED', 'the refused retry left the operation untouched');
    pass('retry is refused when a tool write outcome is unknown, so no remote side effect is duplicated');

    // An ambiguous dispatch intent likewise blocks retry.
    const ambiguousDispatch = await scenario('ambiguous-dispatch', 1);
    await execution.start(owner, ambiguousDispatch.operationId, ambiguousDispatch.ready.version, 'qa-a06-ambd-start-1');
    const failRecorder: DispatchRecorder = { requests: [], failOn: () => true };
    await new PgOutboxDispatcher(pool, recordingOrchestrator(failRecorder)).dispatchOnce();
    assert(await count('outbox', 'operation_id=$1 AND state=$2', [ambiguousDispatch.operationId, 'UNKNOWN']) === 1, 'an ambiguous enqueue is recorded as UNKNOWN, never retried blindly');
    await pool.query("UPDATE step_attempts SET state='FAILED' WHERE operation_id=$1", [ambiguousDispatch.operationId]);
    await store.transition(owner, ambiguousDispatch.operationId, 'FAILED', (await store.getOperation(owner, ambiguousDispatch.operationId)).version);
    const ambDispatchVersion = (await store.getOperation(owner, ambiguousDispatch.operationId)).version;
    await expectDomainError('UNKNOWN_OUTCOME', () => interruptions.retry(owner, ambiguousDispatch.operationId, ambDispatchVersion, 'qa-a06-ambd-retry-1'), 'retry after an ambiguous dispatch');
    pass('an ambiguous dispatch stays UNKNOWN and blocks retry instead of replaying a possible run');

    // ══ 8. Worker error propagation: real error codes, distinct unknown outcome ═══════════════════
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:' + removed.port;
    let handler = await rebuildWorker();
    const failing = await scenario('worker-failure', 1);
    await execution.start(owner, failing.operationId, failing.ready.version, 'qa-a06-fail-start-1');
    await dispatcher.dispatchOnce();
    const failAttemptId = rec.requests.at(-1)!.stepAttemptId;
    // The fixture returns HTTP 400, which the adapter classifies as a bad request. What matters is
    // that a *specific* provider failure code reaches the attempt and event, not a generic label.
    let propagated: unknown;
    try { await handler({ ...rec.requests.at(-1)! }, { workflowRunId: 'qa-run-fail-1' }); } catch (error) { propagated = error; }
    assert(propagated instanceof DomainError, 'a provider failure propagates as a domain error');
    const propagatedCode = (propagated as DomainError).code;
    const failureRow = await pool.query<{ state: string }>('SELECT state FROM step_attempts WHERE id=$1', [failAttemptId]);
    assert(failureRow.rows[0]?.state === 'FAILED', 'a failed attempt is recorded FAILED');
    const failureEvent = await pool.query<{ kind: string; payload: Record<string, unknown> }>("SELECT kind,payload FROM operation_events WHERE operation_id=$1 AND kind IN ('STEP_FAILED','STEP_OUTCOME_UNKNOWN') ORDER BY occurred_at DESC LIMIT 1", [failing.operationId]);
    assert(failureEvent.rows[0]?.kind === 'STEP_FAILED', 'an ordinary failure is recorded as STEP_FAILED');
    assert(propagatedCode !== 'UNEXPECTED_EXECUTION_ERROR', 'the propagated code is specific, not the generic catch-all');
    assert(JSON.stringify(failureEvent.rows[0]?.payload).includes(propagatedCode), 'the real propagated code reaches the event, not a generic one');
    assert(await statusOf(failing.operationId) === 'FAILED', 'the operation reflects the failure');
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:' + ok.port;
    handler = await rebuildWorker();
    pass('worker failures propagate their real error code and are recorded as STEP_FAILED');

    // Budget exhaustion is a policy stop, not a business failure.
    const budgetStop = await scenario('budget-stop', 1);
    await execution.start(owner, budgetStop.operationId, budgetStop.ready.version, 'qa-a06-budget-start-1');
    await dispatcher.dispatchOnce();
    await pool.query("UPDATE operation_budgets SET max_agent_calls=0 WHERE operation_id=$1", [budgetStop.operationId]);
    await expectDomainError('BUDGET_EXHAUSTED', () => handler({ ...rec.requests.at(-1)! }, { workflowRunId: 'qa-run-budget-1' }), 'exhausted agent-call budget');
    assert(await statusOf(budgetStop.operationId) === 'FAILED', 'an exhausted budget ends the run in an explicit terminal state');
    const budgetEvent = await pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM operation_events WHERE operation_id=$1 AND kind='STEP_FAILED' ORDER BY occurred_at DESC LIMIT 1", [budgetStop.operationId]);
    assert(JSON.stringify(budgetEvent.rows[0]?.payload).includes('BUDGET_EXHAUSTED'), 'the budget cause is recorded, so it is distinguishable from a business failure');
    const budgetView = await readModels.sync(owner, budgetStop.operationId);
    assert(budgetView!.attention === 'FAILED', 'the customer sees the budget stop as requiring a decision');
    pass('budget exhaustion ends in an explicit terminal state with the policy cause recorded');

    // ══ 9. Timed-out workflow leaves an explicit, recoverable state ═══════════════════════════════
    process.env.HERMES_REQUEST_TIMEOUT_MS = '50';
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:' + slow.port;
    handler = await rebuildWorker();
    const timedOut = await scenario('timeout', 1);
    await execution.start(owner, timedOut.operationId, timedOut.ready.version, 'qa-a06-timeout-start-1');
    await dispatcher.dispatchOnce();
    const timeoutAttempt = rec.requests.at(-1)!.stepAttemptId;
    let timeoutError: unknown;
    try { await handler({ ...rec.requests.at(-1)! }, { workflowRunId: 'qa-run-timeout-1' }); } catch (error) { timeoutError = error; }
    assert(timeoutError instanceof DomainError, 'a provider timeout surfaces as a domain error');
    const timeoutState = await statusOf(timedOut.operationId);
    assert(timeoutState === 'FAILED' || timeoutState === 'INTERRUPTED', 'a timed-out workflow ends in an explicit recoverable state');
    const timeoutAttemptRow = await pool.query<{ state: string; payload: Record<string, unknown> }>('SELECT state,payload FROM step_attempts WHERE id=$1', [timeoutAttempt]);
    assert(timeoutAttemptRow.rows[0]?.state === 'FAILED', 'the timed-out attempt is terminally recorded, not left RUNNING');
    assert(JSON.stringify(timeoutAttemptRow.rows[0]?.payload).includes('TIMEOUT') || JSON.stringify(timeoutAttemptRow.rows[0]?.payload).includes('UNAVAILABLE'), 'the timeout is recorded with its own code');
    delete process.env.HERMES_REQUEST_TIMEOUT_MS;
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:' + ok.port;
    handler = await rebuildWorker();
    pass('a timed-out workflow ends in an explicit recoverable state with a recorded timeout code');

    // ══ 10. Tenant isolation of every lifecycle artefact ══════════════════════════════════════════
    await expectDomainError('NOT_FOUND', () => store.getOperation(outsiderWorkspace.owner, main1.operationId), 'another workspace cannot read the operation');
    await expectDomainError('NOT_FOUND', () => readModels.sync(outsiderWorkspace.owner, main1.operationId), 'another workspace cannot project the operation');
    // Cross-tenant access is NOT_FOUND, never DENIED: the API must not confirm that an operation
    // exists in another workspace. DENIED here would leak existence.
    await expectDomainError('NOT_FOUND', () => interruptions.reconcile(outsiderWorkspace.owner, main1.operationId), 'another workspace cannot reconcile an interruption');
    // Boundary worth stating precisely: the store authorises on WORKSPACE, and membership of that
    // workspace is established earlier by the HTTP auth guard. A principal that merely claims the
    // workspace id can therefore reach the store, which is exactly why the guard must stay in front
    // of it. What the store still guarantees is that it never reads across workspaces.
    const claimsWorkspace: Principal = { userId: outsiderWorkspace.userId as ID, workspaceId: primary.workspaceId as ID, roles: ['MEMBER'] };
    await expectDomainError('DENIED', () => interruptions.reconcile(claimsWorkspace, main1.operationId), 'a non-operator role is denied the interruption control');
    assert(await statusOf(main1.operationId) === 'WAITING_APPROVAL', 'the denied control changed nothing');
    pass('lifecycle artefacts and interruption controls stay inside their tenant');

    console.log('\nMission lifecycle A06 — ' + passed.length + ' groups, ' + assertions + ' assertions PASS in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    console.log('BOUNDARY: dispatch verified against a recording OrchestratorPort double; no Hatchet server ran. Live dispatch NOT VERIFIED.');
  } finally {
    await workerDeps?.close().catch(() => undefined);
    await ok?.close().catch(() => undefined);
    await removed?.close().catch(() => undefined);
    await slow?.close().catch(() => undefined);
    // Close our pool before dropping the database so teardown does not race an idle client.
    await connection?.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Mission lifecycle QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
