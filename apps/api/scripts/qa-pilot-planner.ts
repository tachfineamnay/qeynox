import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  capabilities, agentProfiles, budgetPolicies, planRevisions, steps, events, outbox,
} from '@qeynox/persistence';
import {
  PlanProposalService, CapabilityRegistry, AgentProfileStore, type PlanProposalResult,
} from '@qeynox/roles';
import { peekWorkspaceBudget } from '../src/pilot/pilot.module';
import { DomainError, type Principal, type ID } from '@qeynox/domain';
import type { EnginePort, EngineOutcome } from '@qeynox/engine';

/**
 * MISSION A12 — Pilot plan proposals (isolated database only).
 *
 * Service level: scripted engines prove the degradation contract. HTTP level: the real endpoint with
 * the real HermesAdapter (not configured in QA) proves the unavailable path. No assertion depends on
 * a real model. The customer experience stays manual-capable: the proposal endpoint never writes a
 * plan, step, event or budget row — saving happens only through the existing plan endpoints.
 */

const PASS_LINES: string[] = [];
function pass(line: string): void { PASS_LINES.push(line); console.log('PASS: ' + line); }

const PROFILE = {
  id: 'profile-pilot-qa' as ID, role: 'pilot', version: 1, title: 'QA Pilot',
  systemInstructions: 'QA-only pilot instructions', skillRefs: [], allowedTools: [] as string[],
  permittedContextKeys: [] as string[], maxOutputTokens: 512, maxIterations: 1,
};

const CAP_A = { id: 'qa-cap-research-a12' as ID, slot: 1 as const, version: 1, status: 'ACTIVE' as const, name: 'QA Research Capability', purpose: 'QA-only research capability', scope: ['qa research scope'], allowedTools: ['world-bank:indicator@1'], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 2, maximumToolCalls: 2, privacyScopes: [] as string[] };
const CAP_B = { id: 'qa-cap-analysis-a12' as ID, slot: 2 as const, version: 1, status: 'ACTIVE' as const, name: 'QA Analysis Capability', purpose: 'QA-only analysis capability', scope: ['qa analysis scope'], allowedTools: [] as string[], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 1, maximumToolCalls: 0, privacyScopes: [] as string[] };

const qa = await createIsolatedQaDatabase();
process.env.DATABASE_URL = qa.url;
process.env.QEYNOX_ALLOW_REGISTRATION = 'true';

const validOutput = {
  summary: 'A focused draft for the recorded objective.',
  deliverables: ['A short evidence-backed brief'],
  assumptions: ['Sources stay public and citable'],
  questions: [] as string[],
  steps: [
    { title: 'Collect primary indicators', description: 'Gather the configured public indicators for the objective.', capabilityId: CAP_A.id, intent: 'RESEARCH', dependsOnIndices: [] as number[], expectedDeliverable: 'Raw indicator table with provenance' },
    { title: 'Assess feasibility', description: 'Cross-check the indicators against the recorded constraints.', capabilityId: CAP_B.id, intent: 'ANALYZE', dependsOnIndices: [0], expectedDeliverable: 'Feasibility memo' },
  ],
};

function fakeEngine(rec: { requests: { userMessage: string; context: Record<string, unknown>; stepAttemptId: string; profile: { role: string } }[] }, outcome: Record<string, unknown> | (() => Promise<EngineOutcome>)): EnginePort {
  return {
    isAvailable: () => ({ available: true, reason: 'READY' }),
    async invoke(request): Promise<EngineOutcome> {
      rec.requests.push({ userMessage: request.userMessage, context: request.context, stepAttemptId: request.stepAttemptId, profile: request.profile });
      if (typeof outcome === 'function') return outcome();
      return { status: 'COMPLETED', engine: 'qa-fake', content: JSON.stringify(validOutput), proposedTools: [], receivedAt: new Date().toISOString(), ...outcome } as EngineOutcome;
    },
  };
}

const started = Date.now();
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;

try {
  await runMigrations(qa.url);
  const connection = connectDatabase(qa.url);
  const store = new QeyNoxStore(connection.db);
  const pool = new pg.Pool({ connectionString: qa.url });

  const workspaceId = randomUUID();
  const userId = randomUUID();
  const owner: Principal = { userId: userId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
  const { identityUsers, identityWorkspaces, identityMemberships } = await import('@qeynox/persistence');
  await connection.db.insert(identityUsers).values({ id: userId, email: 'qa-a12-' + userId + '@example.invalid' });
  await connection.db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA A12 Workspace', createdBy: userId });
  await connection.db.insert(identityMemberships).values({ id: randomUUID(), userId, workspaceId, role: 'OWNER', status: 'ACTIVE' });
  await connection.db.insert(capabilities).values([
    { id: CAP_A.id, slot: CAP_A.slot, version: CAP_A.version, status: 'ACTIVE', payload: CAP_A },
    { id: CAP_B.id, slot: CAP_B.slot, version: CAP_B.version, status: 'ACTIVE', payload: CAP_B },
  ]);
  await connection.db.insert(agentProfiles).values({ id: PROFILE.id, roleKey: 'pilot', version: PROFILE.version, active: true, payload: PROFILE as unknown as Record<string, unknown> });
  await connection.db.insert(budgetPolicies).values({
    id: 'default', workspaceId, version: 1, status: 'ACTIVE',
    payload: { currency: 'USD', maxMoneyMinor: 1000, maxAgentCalls: 3, maxToolCalls: 3, maxDurationSeconds: 600, maxConcurrent: 1, unitMaxMinor: { hermes: 10, 'world-bank:indicator@1': 0 } },
    digest: 'qa-a12-budget-digest', configuredBy: userId,
  });

  const registry = new CapabilityRegistry(await store.getCapabilities());
  const proposals = (engine: EnginePort, now?: () => Date, timeoutMs?: number) =>
    new PlanProposalService(engine, async () => PROFILE as never, registry, {
      peekBudget: actor => peekWorkspaceBudget(store, actor),
      ...(now ? { now } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  const operation = await store.createOperation(owner, 'QA A12 mission', 'Find three reliable wholesale buyers for our argan oil in France', ['Public sources only']);
  const goal = { statement: 'Find three reliable wholesale buyers for our argan oil in France', constraints: ['Public sources only'] };

  const rowCount = async (table: string) => Number((await pool.query('SELECT count(*)::text AS n FROM ' + table)).rows[0].n);
  const before = { revisions: await rowCount('plan_revisions'), steps: await rowCount('work_steps'), events: await rowCount('operation_events'), outbox: await rowCount('outbox') };

  // ── 1. AI path: structured proposal, verified against configuration, nothing persisted ──────────
  const rec1 = { requests: [] as { userMessage: string; context: Record<string, unknown>; stepAttemptId: string; profile: { role: string } }[] };
  const readiness = new Map([
    [CAP_A.id, { operationalState: 'OPERATIONAL', isExecutable: true, missingProviders: [], missingPolicies: [] }],
    [CAP_B.id, { operationalState: 'BLOCKED', isExecutable: false, missingProviders: ['provider-x'], missingPolicies: [] }],
  ]);
  const ai = await proposals(fakeEngine(rec1, {})).proposePlan(owner, operation, goal, { attemptKey: 'a12-ai-attempt-1', locale: 'en' }, readiness);
  assert.equal(ai.source, 'AI');
  assert.equal(ai.aiGenerated, true);
  assert.equal(ai.reason, 'OK');
  assert.equal(ai.steps.length, 2);
  assert.equal(ai.steps[1]!.dependsOnIndices[0], 0, 'dependency indices survive validation');
  assert.equal(ai.questions.length, 0);
  assert.equal(ai.budget.configured, true);
  assert.equal(ai.budget.maxMoneyMinor, 1000);
  assert.equal(ai.capabilityNotes.length, 2);
  assert.equal(ai.capabilityNotes.find(n => n.capabilityId === CAP_B.id)?.operationalState, 'BLOCKED');
  assert.equal(ai.capabilityNotes.find(n => n.capabilityId === CAP_B.id)?.isExecutable, false);
  assert.equal(rec1.requests.length, 1);
  assert.deepEqual(rec1.requests[0]!.context, {}, 'proposal must not send consented facts to the model');
  assert.match(rec1.requests[0]!.stepAttemptId, /^pilot-proposal-/, 'placeholder ids are namespace-distinguishable');
  assert.equal(rec1.requests[0]!.profile.role, 'pilot');
  assert.ok(rec1.requests[0]!.userMessage.includes(CAP_A.id), 'the prompt lists the ACTIVE capability ids');
  assert.ok(rec1.requests[0]!.userMessage.includes('Find three reliable wholesale buyers'), 'the prompt carries the recorded objective');
  pass('AI proposal is labelled, bounded, readiness-aware and sends no memory context');

  // Nothing was persisted: the proposal endpoint is not a plan-writer.
  const after = { revisions: await rowCount('plan_revisions'), steps: await rowCount('work_steps'), events: await rowCount('operation_events'), outbox: await rowCount('outbox') };
  assert.deepEqual(after, before, 'proposing a plan must not write revisions, steps, events or outbox rows');
  pass('the proposal endpoint persists nothing — saving a plan remains the customer-facing endpoints');

  // ── 2. Retry of the same attempt key is free and identical ────────────────────────────────────
  const replay = await proposals(fakeEngine(rec1, {})).proposePlan(owner, operation, goal, { attemptKey: 'a12-ai-attempt-1', locale: 'en' }, readiness);
  assert.deepEqual(replay, ai);
  assert.equal(rec1.requests.length, 1, 'a retried attempt must not call the model twice');
  pass('a retried proposal attempt reuses the cached result without a second model call');

  // ── 3. Whole-proposal rejection on configuration violations ────────────────────────────────────
  const tooManyOnB = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [validOutput.steps[0], { ...validOutput.steps[1] }, { ...validOutput.steps[1], title: 'Third step' }] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-ceiling-1', locale: 'en' });
  assert.equal(tooManyOnB.reason, 'INVALID_PROPOSAL', 'capability maximumSteps ceiling rejects the whole proposal');
  assert.equal(tooManyOnB.steps.length, 0);
  const externalOnB = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [{ ...validOutput.steps[0], capabilityId: CAP_B.id, intent: 'EXTERNAL_ACTION', dependsOnIndices: [] }] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-external-1', locale: 'en' });
  assert.equal(externalOnB.reason, 'INVALID_PROPOSAL');
  const unknownCap = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [{ ...validOutput.steps[0], capabilityId: 'qa-cap-does-not-exist' }] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-unknown-1', locale: 'en' });
  assert.equal(unknownCap.reason, 'INVALID_PROPOSAL');
  const outOfRange = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [{ ...validOutput.steps[0], dependsOnIndices: [7] }] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-range-1', locale: 'en' });
  assert.equal(outOfRange.reason, 'INVALID_PROPOSAL');
  const selfDep = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [{ ...validOutput.steps[0], dependsOnIndices: [0] }] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-self-1', locale: 'en' });
  assert.equal(selfDep.reason, 'INVALID_PROPOSAL');
  const cyclic = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [
    { ...validOutput.steps[0], dependsOnIndices: [1] },
    { ...validOutput.steps[1], dependsOnIndices: [0] },
  ] }) })).proposePlan(owner, operation, goal, { attemptKey: 'a12-cycle-1', locale: 'en' });
  assert.equal(cyclic.reason, 'INVALID_PROPOSAL');
  pass('ceiling, capability, dependency and cycle violations reject the whole proposal — never a partial draft');

  // ── 4. External action with reviewed tools requires explicit approval, is allowed ───────────────
  const externalOk = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, steps: [{ ...validOutput.steps[0], intent: 'EXTERNAL_ACTION' }] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-external-ok-1', locale: 'en' });
  assert.equal(externalOk.reason, 'OK');
  assert.equal(externalOk.requiresApproval, true);
  pass('EXTERNAL_ACTION with reviewed tools is proposed with requiresApproval=true');

  // ── 5. Questions: at most three are shown even if the model returns more ───────────────────────
  const chatty = await proposals(fakeEngine({ requests: [] }, { content: JSON.stringify({ ...validOutput, questions: ['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?'] }) }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-chatty-1', locale: 'en' });
  assert.equal(chatty.reason, 'OK');
  assert.equal(chatty.questions.length, 3, 'at most three clarifying questions are presented');
  pass('the customer is asked at most three clarifying questions');

  // ── 6. Degradation contract: refusal, failure, empty, invalid, timeout, not-configured ──────────
  const refused = await proposals(fakeEngine({ requests: [] }, { content: "I'm sorry, but I can't draft that plan." }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-refusal-1', locale: 'en' });
  assert.equal(refused.reason, 'ENGINE_REFUSED'); assert.equal(refused.steps.length, 0);
  const failed = await proposals(fakeEngine({ requests: [] }, { status: 'FAILED', content: 'partial' }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-failed-1', locale: 'en' });
  assert.equal(failed.reason, 'ENGINE_UNAVAILABLE');
  const empty = await proposals(fakeEngine({ requests: [] }, { content: '   ' }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-empty-1', locale: 'en' });
  assert.equal(empty.reason, 'ENGINE_EMPTY');
  const noJson = await proposals(fakeEngine({ requests: [] }, { content: 'Sure! Here is a plan: first do X.' }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-nojson-1', locale: 'en' });
  assert.equal(noJson.reason, 'INVALID_PROPOSAL');
  const oversize = await proposals(fakeEngine({ requests: [] }, { content: '{"summary":"' + 'x'.repeat(30_000) + '"}' }))
    .proposePlan(owner, operation, goal, { attemptKey: 'a12-oversize-1', locale: 'en' });
  assert.equal(oversize.reason, 'INVALID_PROPOSAL');
  const offline = await proposals({
    isAvailable: () => ({ available: false, reason: 'NO_CREDENTIAL' }),
    async invoke(): Promise<EngineOutcome> { throw new DomainError('NOT_CONFIGURED', 'no key'); },
  }).proposePlan(owner, operation, goal, { attemptKey: 'a12-offline-1', locale: 'en' });
  assert.equal(offline.reason, 'ENGINE_NOT_CONFIGURED'); assert.equal(offline.aiGenerated, false);
  const tag = Date.now();
  const hanging: EnginePort = { isAvailable: () => ({ available: true, reason: 'READY' }), invoke: () => new Promise<EngineOutcome>(() => undefined) };
  const timed = Date.now();
  const timedOut = await proposals(hanging, undefined, 150).proposePlan(owner, operation, goal, { attemptKey: 'a12-timeout-' + tag, locale: 'en' });
  assert.equal(timedOut.reason, 'ENGINE_TIMEOUT');
  assert.ok(Date.now() - timed < 4000, 'a hung engine is bounded by the timeout race');
  for (const result of [refused, failed, empty, noJson, oversize, offline, timedOut]) {
    assert.equal(result.source, 'DETERMINISTIC_FALLBACK');
    assert.equal(result.aiGenerated, false);
    assert.equal(result.steps.length, 0);
  }
  pass('refusal, failure, empty, invalid, offline and timeout all degrade to an empty, honest fallback');

  // ── 7. Workspace without an ACTIVE budget policy reports the boundary as unknown, never invents one ─
  const workspaceId2 = randomUUID(), userId2 = randomUUID();
  const owner2: Principal = { userId: userId2 as ID, workspaceId: workspaceId2 as ID, roles: ['OWNER'] };
  await connection.db.insert(identityUsers).values({ id: userId2, email: 'qa-a12b-' + userId2 + '@example.invalid' });
  await connection.db.insert(identityWorkspaces).values({ id: workspaceId2, name: 'QA A12 No-Budget', createdBy: userId2 });
  await connection.db.insert(identityMemberships).values({ id: randomUUID(), userId: userId2, workspaceId: workspaceId2, role: 'OWNER', status: 'ACTIVE' });
  const op2 = await store.createOperation(owner2, 'QA A12 unbudgeted mission', 'Objective without an active budget policy', []);
  const noBudget = await proposals(fakeEngine({ requests: [] }, {})).proposePlan(owner2, op2, null, { attemptKey: 'a12-nobudget-1', locale: 'en' });
  assert.equal(noBudget.budget.configured, false, 'missing ACTIVE budget policy is reported as unknown');
  assert.equal(noBudget.reason, 'OK');
  pass('a missing workspace budget policy is reported as unknown, never as an invented ceiling');

  // ── 8. No ACTIVE capabilities → NO_CAPABILITIES, engine never called ─────────────────────────────
  const emptyRec = { requests: [] as never[] };
  const offlineRegistry = new CapabilityRegistry([{ ...CAP_A, status: 'DISABLED' as const }]);
  const emptySvc = new PlanProposalService(fakeEngine(emptyRec, {}), async () => PROFILE as never, offlineRegistry, { attemptCache: new Map() });
  const noCaps = await emptySvc.proposePlan(owner, operation, goal, { attemptKey: 'a12-nocaps-1', locale: 'en' });
  assert.equal(noCaps.reason, 'NO_CAPABILITIES');
  assert.equal(noCaps.steps.length, 0);
  assert.equal(emptyRec.requests.length, 0, 'the engine is not called when no capability can be proposed');
  pass('with no ACTIVE capability the engine is never called and no steps are proposed');

  // ── 9. HTTP level: real app, real (unconfigured) Hermes adapter fails closed ──────────────────────
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + (app.getHttpServer().address() as { port: number }).port;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const register = async (email: string) => {
    const user = await call('/v1/auth/register', { email, password: 'qa-a12-passphrase', workspaceName: 'QA A12 HTTP' });
    assert.equal(user.status, 201);
    return { authorization: 'Bearer ' + user.body.token, 'x-qeynox-workspace': user.body.workspaceId, userId: user.body.userId, workspaceId: user.body.workspaceId as string };
  };
  const httpOwner = await register('qa-a12-http@example.invalid');
  const hHttp = { authorization: httpOwner.authorization, 'x-qeynox-workspace': httpOwner.workspaceId };
  // A mission must exist for the endpoint to propose against.
  const httpOperation = await store.createOperation({ userId: httpOwner.userId as ID, workspaceId: httpOwner.workspaceId as ID, roles: ['OWNER'] }, 'QA A12 HTTP mission', 'Objective for the HTTP proposal check', []);

  const offlineHttp = await call('/v1/pilot/operations/' + httpOperation.id + '/plan-proposal', { attemptKey: 'qa-a12-http-offline-1', locale: 'en', answers: [] }, hHttp);
  assert.equal(offlineHttp.status, 201, 'unavailable engine degrades to a stated condition, not a 500');
  assert.equal(offlineHttp.body.source, 'DETERMINISTIC_FALLBACK');
  assert.equal(offlineHttp.body.reason, 'ENGINE_NOT_CONFIGURED');
  assert.deepEqual(offlineHttp.body.steps, []);
  assert.equal(offlineHttp.body.budget.configured, false, 'budget policy peek works through the module wiring (this workspace has none)');

  const badBody = await call('/v1/pilot/operations/' + httpOperation.id + '/plan-proposal', { attemptKey: 'short', locale: 'en' }, hHttp);
  assert.equal(badBody.status, 400, 'contract violations are rejected');
  const otherWorkspace = await register('qa-a12-http-b@example.invalid');
  const foreign = await call('/v1/pilot/operations/' + httpOperation.id + '/plan-proposal', { attemptKey: 'qa-a12-http-foreign-1', locale: 'en' }, { authorization: otherWorkspace.authorization, 'x-qeynox-workspace': otherWorkspace.workspaceId });
  assert.notEqual(foreign.status, 201, 'an operation from another workspace is not reachable');
  const operationsAfter = await pool.query('SELECT count(*)::text AS n FROM operations');
  assert.equal(Number(operationsAfter.rows[0].n), 3, 'the proposal endpoint created no operation (service fixtures and http fixture only)');
  pass('HTTP layer: fail-closed engine, contract validation, workspace isolation, no implicit operation creation');

  console.log('\nPilot planner QA PASSED:', PASS_LINES.length, 'check groups in', Date.now() - started, 'ms');
  await pool.end();
  await connection.close();
} catch (error: unknown) {
  console.error('Pilot planner QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await qa.drop().then(() => console.log('QA database dropped:', qa.name)).catch(() => undefined);
}
