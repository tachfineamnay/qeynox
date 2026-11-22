/** Real disposable PostgreSQL; connector/queue ports are labelled QA fixtures. No DB/S3 mocks. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DomainError, type Consent, type ID, type Principal, type StepAttempt } from '@qeynox/domain';
import {
  connectDatabase, runMigrations, QeyNoxStore, identityUsers, identityWorkspaces, identityMemberships,
  operations, consents, approvals, toolLedger,
} from '@qeynox/persistence';
import {
  EgressPolicy, WorldBankConnector, worldBankManifest, ToolBroker, ToolRegistry, PgToolLedger,
  PgToolAuthorization, ProviderRateLimiter, type ConnectorCall, type PermissionContext, type ToolLedgerPort,
} from '@qeynox/tools';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is required; no tool-authorization integration claim.');
    process.exitCode = 3;
    return;
  }
  const qa = await createIsolatedQaDatabase();
  const connection = connectDatabase(qa.url);
  try {
    await runMigrations(qa.url);
    const db = connection.db, store = new QeyNoxStore(db);
    const actor: Principal = { userId: randomUUID() as ID, workspaceId: randomUUID() as ID, roles: ['OWNER'] };
    await db.insert(identityUsers).values({ id: actor.userId, email: 'qa-authorization-' + actor.userId + '@example.invalid' });
    await db.insert(identityWorkspaces).values({ id: actor.workspaceId, name: 'Disposable tool authorization QA', createdBy: actor.userId });
    const membershipId = randomUUID();
    await db.insert(identityMemberships).values({ id: membershipId, userId: actor.userId, workspaceId: actor.workspaceId, role: 'OWNER', status: 'ACTIVE' });
    const original = await store.createOperation(actor, 'QA authorization', 'QA-only authorization interleavings', []);
    const revisionId = randomUUID() as ID;
    const operation = { ...original, status: 'RUNNING' as const, currentRevisionId: revisionId };
    const attempt: StepAttempt = { id: randomUUID() as ID, operationId: original.id, planRevisionId: revisionId, workStepId: randomUUID() as ID, sequence: 1, state: 'RUNNING', createdAt: new Date().toISOString(), version: 1 };
    await store.putStepAttempt(attempt);
    const consent: Consent = { id: randomUUID() as ID, userId: actor.userId, workspaceId: actor.workspaceId, purpose: 'QA scoped tool access', scopes: ['context:read'], grantedAt: new Date().toISOString(), version: 1 };
    await store.putConsent(consent);
    const reset = async () => {
      await db.update(consents).set({ payload: consent }).where(eq(consents.id, consent.id));
      await db.update(identityMemberships).set({ status: 'ACTIVE' }).where(eq(identityMemberships.id, membershipId));
      await db.update(operations).set({ status: 'RUNNING', currentRevisionId: revisionId, payload: operation }).where(eq(operations.id, operation.id));
    };
    let calls = 0;
    let afterQuota: (() => Promise<void>) | undefined;
    let afterReserve: (() => Promise<void>) | undefined;
    class QueueFixture extends ProviderRateLimiter {
      override async check(provider: string, limit: number): Promise<void> { await super.check(provider, limit); await afterQuota?.(); }
    }
    const realLedger = new PgToolLedger(db);
    const observedLedger: ToolLedgerPort = {
      reserve: async record => { const result = await realLedger.reserve(record); await afterReserve?.(); return result; },
      complete: (...args) => realLedger.complete(...args),
      fail: (...args) => realLedger.fail(...args),
    };
    const capabilityId = randomUUID() as ID;
    const base = new WorldBankConnector([capabilityId], new EgressPolicy({ attested: false, allowedHosts: [] })).definitions()[0]!;
    const makeBroker = (mode: 'READ' | 'WRITE' = 'READ') => {
      const registry = new ToolRegistry();
      registry.registerBundle({ manifest: { ...worldBankManifest, id: 'qa-authorization', mode: mode === 'WRITE' ? 'SIDE_EFFECTS' : 'READ_ONLY', rateLimit: { maxPerMinute: 100 } }, connector: {
        id: 'qa-authorization', version: '1', definitions: () => [{ ...base, mode, requiredScopes: ['context:read'] }],
        invoke: async () => { calls++; return { value: { provider: 'world-bank', country: 'USA', indicator: 'NY.GDP.MKTP.CD', observations: [], sourceUri: 'https://example.invalid/qa-port-fixture', retrievedAt: new Date().toISOString() } }; },
      } });
      return new ToolBroker(registry, observedLedger, new QueueFixture(), new PgToolAuthorization(db));
    };
    const makeRequest = (): { call: ConnectorCall; permission: PermissionContext } => {
      const call: ConnectorCall = { operationId: operation.id, stepAttemptId: attempt.id, planRevisionId: revisionId, capabilityId, connectorId: 'qa-authorization', toolName: 'indicator', version: '1', input: { country: 'USA', indicator: 'NY.GDP.MKTP.CD' }, intentId: randomUUID() as ID, idempotencyKey: randomUUID() };
      return { call, permission: { principal: actor, operationId: operation.id, stepAttemptId: attempt.id, planRevisionId: revisionId, capabilityId, profileId: randomUUID() as ID, profileVersion: 1, allowedConnectorTools: ['qa-authorization:indicator@1'], consentScopes: ['context:read'], approvedRequests: [], remainingCostUnits: 0, remainingToolCalls: 1 } };
    };
    const outcome = async (intentId: ID) => (await db.select().from(toolLedger).where(eq(toolLedger.intentId, intentId)))[0]?.outcome;
    const denied = (error: unknown) => error instanceof DomainError && error.code === 'DENIED';
    await reset();
    const valid = makeRequest();
    await makeBroker().invoke(valid.call, valid.permission);
    assert.equal(calls, 1);
    assert.equal(await outcome(valid.call.intentId), 'COMPLETED');

    for (const moment of ['quota', 'ledger'] as const) {
      await reset();
      const revoke = async () => { await db.update(consents).set({ payload: { ...consent, revokedAt: new Date().toISOString() } }).where(eq(consents.id, consent.id)); };
      afterQuota = moment === 'quota' ? revoke : undefined;
      afterReserve = moment === 'ledger' ? revoke : undefined;
      const request = makeRequest();
      await assert.rejects(makeBroker().invoke(request.call, request.permission), denied);
      assert.equal(calls, 1, 'revocation during ' + moment + ' wait must prevent invocation');
      assert.equal(await outcome(request.call.intentId), 'FAILED');
    }
    afterQuota = undefined;
    await reset();
    afterReserve = async () => { await db.update(identityMemberships).set({ status: 'REVOKED' }).where(eq(identityMemberships.id, membershipId)); };
    const removed = makeRequest();
    await assert.rejects(makeBroker().invoke(removed.call, removed.permission), denied);
    assert.equal(calls, 1, 'membership removal prevents invocation');

    await reset();
    afterReserve = async () => { await db.update(operations).set({ status: 'INTERRUPT_REQUESTED' }).where(eq(operations.id, operation.id)); };
    const interrupted = makeRequest();
    await assert.rejects(makeBroker().invoke(interrupted.call, interrupted.permission), denied);
    assert.equal(calls, 1, 'interrupt request prevents invocation');

    await reset();
    afterReserve = async () => { await db.update(consents).set({ payload: { ...consent, expiresAt: '2000-01-01T00:00:00.000Z' } }).where(eq(consents.id, consent.id)); };
    const write = makeRequest(), approvalId = randomUUID() as ID;
    write.call.approvalId = approvalId;
    write.permission.approvedRequests = [{ id: approvalId, workspaceId: actor.workspaceId, operationId: operation.id, planRevisionId: revisionId, stepAttemptId: attempt.id, intentId: write.call.intentId, purpose: 'QA_WRITE', status: 'APPROVED', requestedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }];
    const writeApproval = write.permission.approvedRequests[0]!;
    await db.insert(approvals).values({ id: approvalId, workspaceId: actor.workspaceId, operationId: operation.id, status: 'APPROVED', payload: writeApproval });
    await assert.rejects(makeBroker('WRITE').invoke(write.call, write.permission), denied);
    assert.equal(await outcome(write.call.intentId), 'FAILED', 'refused before provider entry is known NOT executed, never UNKNOWN');
    assert.equal(calls, 1);

    await reset();
    const revokedWrite = makeRequest(), revokedApprovalId = randomUUID() as ID;
    revokedWrite.call.approvalId = revokedApprovalId;
    revokedWrite.permission.approvedRequests = [{ ...writeApproval, id: revokedApprovalId, intentId: revokedWrite.call.intentId }];
    await db.insert(approvals).values({ id: revokedApprovalId, workspaceId: actor.workspaceId, operationId: operation.id, status: 'APPROVED', payload: revokedWrite.permission.approvedRequests[0]! });
    afterReserve = async () => { await db.update(approvals).set({ status: 'EXPIRED' }).where(eq(approvals.id, revokedApprovalId)); };
    await assert.rejects(makeBroker('WRITE').invoke(revokedWrite.call, revokedWrite.permission), denied);
    assert.equal(await outcome(revokedWrite.call.intentId), 'FAILED');
    assert.equal(calls, 1, 'revoked approval must not use the stale permission snapshot');
    await reset();
    afterReserve = undefined;
    const approvedWrite = makeRequest(), approvedId = randomUUID() as ID;
    approvedWrite.call.approvalId = approvedId;
    approvedWrite.permission.approvedRequests = [{ ...writeApproval, id: approvedId, intentId: approvedWrite.call.intentId }];
    await db.insert(approvals).values({ id: approvedId, workspaceId: actor.workspaceId, operationId: operation.id, status: 'APPROVED', payload: approvedWrite.permission.approvedRequests[0]! });
    await makeBroker('WRITE').invoke(approvedWrite.call, approvedWrite.permission);
    assert.equal(await outcome(approvedWrite.call.intentId), 'COMPLETED');
    assert.equal(calls, 2, 'a current explicit approval permits the QA WRITE port');
    console.log('PASS: PostgreSQL tool authorization — valid READ/WRITE, revocation during quota/ledger, membership removal, interruption, expiry and stale WRITE approval; provider entered only for the two authorized calls.');
  } finally {
    await connection.close();
    await qa.drop();
    console.log('Disposable tool-authorization database dropped.');
  }
}
main().catch((error: unknown) => { console.error('Tool authorization QA FAILED:', error); process.exitCode = 1; });
