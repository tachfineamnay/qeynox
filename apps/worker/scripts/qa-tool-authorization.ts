/** Real disposable PostgreSQL; connector/queue ports are labelled QA fixtures. No DB/S3 mocks. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DomainError, type Consent, type ID, type Principal, type StepAttempt } from '@qeynox/domain';
import {
  connectDatabase, runMigrations, QeyNoxStore, identityUsers, identityWorkspaces, identityMemberships,
  operations, consents, approvals, toolLedger, capabilities, agentProfiles, steps, toolConfigurations,
  betaGrantMissions, betaGrantEvents, usageReservations,
} from '@qeynox/persistence';
import {
  EgressPolicy, WorldBankConnector, worldBankManifest, ToolBroker, ToolRegistry, PgToolLedger,
  PgToolAuthorization, ProviderRateLimiter, type ConnectorCall, type PermissionContext, type ToolLedgerPort,
} from '@qeynox/tools';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';
import { seedQaBetaGrant } from '../../api/scripts/qa-beta-fixture';

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is required; no tool-authorization integration claim.');
    process.exitCode = 3;
    return;
  }
  // P22 BIS: provider readiness (deployment switch, egress attestation, host allowlist) is
  // configured explicitly for this isolated QA run — never inherited from ambient shell state.
  process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
  process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
  process.env.QEYNOX_EGRESS_ALLOWED_HOSTS = 'api.worldbank.org';
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
    // P22 BIS: the canonical active versioned capability every request below binds to.
    const capabilityId = randomUUID() as ID;
    const attempt: StepAttempt = { id: randomUUID() as ID, operationId: original.id, planRevisionId: revisionId, workStepId: randomUUID() as ID, sequence: 1, state: 'RUNNING', createdAt: new Date().toISOString(), version: 1 };
    await store.putStepAttempt(attempt);
    // P22 BIS: the work step the attempt binds to; the P21 authority joins the attempt to this
    // step and requires the step payload to carry the same capability id.
    await db.insert(steps).values({
      id: attempt.workStepId,
      operationId: original.id,
      revisionId,
      payload: {
        id: attempt.workStepId, operationId: original.id, planRevisionId: revisionId, ordinal: 1,
        title: 'QA tool authorization step',
        description: 'QA-only step exercising tool authorization and provider authority checks',
        capabilityId, dependsOn: [], state: 'RUNNING', intent: 'RESEARCH', version: 1,
      },
    });
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
    const base = new WorldBankConnector([capabilityId], new EgressPolicy({ attested: false, allowedHosts: [] })).definitions()[0]!;
    // P22 BIS: canonical provisioning rows, exactly as an operator records them — the ACTIVE
    // versioned capability, the business profile bound to the capability slot, the ACTIVE reviewed
    // World Bank tool configuration, and the beta grant + mission admission every P21 authority
    // check requires. No ambient state and no weakened validation.
    const profileId = randomUUID() as ID;
    await db.insert(capabilities).values({
      id: capabilityId, slot: 1, version: 1, status: 'ACTIVE',
      payload: {
        id: capabilityId, slot: 1, version: 1, status: 'ACTIVE', scope: ['research'],
        allowedTools: ['world-bank:indicator@1'], inputSchemaVersion: 1, outputSchemaVersion: 1,
        maximumSteps: 8, maximumToolCalls: 20, privacyScopes: ['context:read'],
      },
    });
    await db.insert(agentProfiles).values({
      id: profileId, roleKey: 'business:1', version: 1, active: true,
      payload: { allowedTools: ['world-bank:indicator@1'] },
    });
    await db.insert(toolConfigurations).values({
      id: randomUUID(), connectorId: 'world-bank', connectorVersion: worldBankManifest.version, status: 'ACTIVE',
      payload: { manifest: worldBankManifest },
      digest: createHash('sha256').update(JSON.stringify(worldBankManifest)).digest('hex'),
      configuredBy: actor.userId,
    });
    const { grantId } = await seedQaBetaGrant(db, actor.workspaceId);
    await db.insert(betaGrantMissions).values({
      id: randomUUID(), grantId, workspaceId: actor.workspaceId, operationId: original.id,
      admittedBy: actor.userId, admittedAt: new Date(),
    });
    const makeBroker = (mode: 'READ' | 'WRITE' = 'READ') => {
      const registry = new ToolRegistry();
      // The QA port registers under the reviewed World Bank provider id so the authority's
      // configured-provider lookup resolves the same connector the calls declare.
      registry.registerBundle({ manifest: { ...worldBankManifest, mode: mode === 'WRITE' ? 'SIDE_EFFECTS' : 'READ_ONLY', rateLimit: { maxPerMinute: 100 } }, connector: {
        id: 'world-bank', version: '1', definitions: () => [{ ...base, mode, requiredScopes: ['context:read'] }],
        invoke: async () => { calls++; return { value: { provider: 'world-bank', country: 'USA', indicator: 'NY.GDP.MKTP.CD', observations: [], sourceUri: 'https://example.invalid/qa-port-fixture', retrievedAt: new Date().toISOString() } }; },
      } });
      return new ToolBroker(registry, observedLedger, new QueueFixture(), new PgToolAuthorization(db));
    };
    const makeRequest = async (): Promise<{ call: ConnectorCall; permission: PermissionContext }> => {
      const call: ConnectorCall = { operationId: operation.id, stepAttemptId: attempt.id, planRevisionId: revisionId, capabilityId, connectorId: 'world-bank', toolName: 'indicator', version: '1', input: { country: 'USA', indicator: 'NY.GDP.MKTP.CD' }, intentId: randomUUID() as ID, idempotencyKey: randomUUID() };
      // P22 BIS: each invocation carries a fresh canonical TOOL spend reservation plus the
      // matching beta SPEND_RESERVED event — the exact P21 authority prerequisites, per request.
      const reservationId = randomUUID() as ID;
      await db.insert(usageReservations).values({
        id: reservationId, workspaceId: actor.workspaceId, operationId: operation.id, attemptId: attempt.id,
        key: call.idempotencyKey, kind: 'TOOL', providerKey: 'world-bank:indicator@1',
        policyVersion: 1, reservedMinor: 0, state: 'RESERVED', createdAt: new Date().toISOString(),
      });
      await db.insert(betaGrantEvents).values({
        id: randomUUID(), grantId, workspaceId: actor.workspaceId, operationId: operation.id,
        kind: 'SPEND_RESERVED', reservationId, amountMinor: 0,
      });
      return { call, permission: { principal: actor, operationId: operation.id, stepAttemptId: attempt.id, planRevisionId: revisionId, capabilityId, profileId, profileVersion: 1, attemptVersion: attempt.version, capabilityVersion: 1, reservationId, allowedConnectorTools: ['world-bank:indicator@1'], consentScopes: ['context:read'], approvedRequests: [], remainingCostUnits: 0, remainingToolCalls: 1 } };
    };
    const outcome = async (intentId: ID) => (await db.select().from(toolLedger).where(eq(toolLedger.intentId, intentId)))[0]?.outcome;
    const denied = (error: unknown) => error instanceof DomainError && error.code === 'DENIED';
    await reset();
    const valid = await makeRequest();
    await makeBroker().invoke(valid.call, valid.permission);
    assert.equal(calls, 1);
    assert.equal(await outcome(valid.call.intentId), 'COMPLETED');

    for (const moment of ['quota', 'ledger'] as const) {
      await reset();
      const revoke = async () => { await db.update(consents).set({ payload: { ...consent, revokedAt: new Date().toISOString() } }).where(eq(consents.id, consent.id)); };
      afterQuota = moment === 'quota' ? revoke : undefined;
      afterReserve = moment === 'ledger' ? revoke : undefined;
      const request = await makeRequest();
      await assert.rejects(makeBroker().invoke(request.call, request.permission), denied);
      assert.equal(calls, 1, 'revocation during ' + moment + ' wait must prevent invocation');
      assert.equal(await outcome(request.call.intentId), 'FAILED');
    }
    afterQuota = undefined;
    await reset();
    afterReserve = async () => { await db.update(identityMemberships).set({ status: 'REVOKED' }).where(eq(identityMemberships.id, membershipId)); };
    const removed = await makeRequest();
    await assert.rejects(makeBroker().invoke(removed.call, removed.permission), denied);
    assert.equal(calls, 1, 'membership removal prevents invocation');

    await reset();
    afterReserve = async () => { await db.update(operations).set({ status: 'INTERRUPT_REQUESTED' }).where(eq(operations.id, operation.id)); };
    const interrupted = await makeRequest();
    await assert.rejects(makeBroker().invoke(interrupted.call, interrupted.permission), denied);
    assert.equal(calls, 1, 'interrupt request prevents invocation');

    await reset();
    afterReserve = async () => { await db.update(consents).set({ payload: { ...consent, expiresAt: '2000-01-01T00:00:00.000Z' } }).where(eq(consents.id, consent.id)); };
    const write = await makeRequest(), approvalId = randomUUID() as ID;
    write.call.approvalId = approvalId;
    write.permission.approvedRequests = [{ id: approvalId, workspaceId: actor.workspaceId, operationId: operation.id, planRevisionId: revisionId, stepAttemptId: attempt.id, intentId: write.call.intentId, purpose: 'QA_WRITE', status: 'APPROVED', requestedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }];
    const writeApproval = write.permission.approvedRequests[0]!;
    await db.insert(approvals).values({ id: approvalId, workspaceId: actor.workspaceId, operationId: operation.id, status: 'APPROVED', payload: writeApproval });
    await assert.rejects(makeBroker('WRITE').invoke(write.call, write.permission), denied);
    assert.equal(await outcome(write.call.intentId), 'FAILED', 'refused before provider entry is known NOT executed, never UNKNOWN');
    assert.equal(calls, 1);

    await reset();
    const revokedWrite = await makeRequest(), revokedApprovalId = randomUUID() as ID;
    revokedWrite.call.approvalId = revokedApprovalId;
    revokedWrite.permission.approvedRequests = [{ ...writeApproval, id: revokedApprovalId, intentId: revokedWrite.call.intentId }];
    await db.insert(approvals).values({ id: revokedApprovalId, workspaceId: actor.workspaceId, operationId: operation.id, status: 'APPROVED', payload: revokedWrite.permission.approvedRequests[0]! });
    afterReserve = async () => { await db.update(approvals).set({ status: 'EXPIRED' }).where(eq(approvals.id, revokedApprovalId)); };
    await assert.rejects(makeBroker('WRITE').invoke(revokedWrite.call, revokedWrite.permission), denied);
    assert.equal(await outcome(revokedWrite.call.intentId), 'FAILED');
    assert.equal(calls, 1, 'revoked approval must not use the stale permission snapshot');
    await reset();
    afterReserve = undefined;
    // P22 BIS · broker-level approval gate: a WRITE intent with no approval never reaches the
    // authority, the ledger or the provider.
    const unapproved = await makeRequest();
    const gateError = await makeBroker('WRITE').invoke(unapproved.call, unapproved.permission).then(
      () => { throw new Error('EXPECTED an unapproved WRITE intent to be refused by the broker approval gate'); },
      (error: unknown) => error,
    );
    assert(
      gateError instanceof DomainError && gateError.code === 'DENIED' && gateError.message === 'Specific write intent not approved',
      'broker refuses an unapproved WRITE intent with the explicit approval-gate message',
    );
    assert.equal(await outcome(unapproved.call.intentId), undefined, 'refused before the ledger: no invocation record exists');
    assert.equal(calls, 1, 'provider never entered for an unapproved WRITE intent');

    const approvedWrite = await makeRequest(), approvedId = randomUUID() as ID;
    approvedWrite.call.approvalId = approvedId;
    approvedWrite.permission.approvedRequests = [{ ...writeApproval, id: approvedId, intentId: approvedWrite.call.intentId }];
    await db.insert(approvals).values({ id: approvedId, workspaceId: actor.workspaceId, operationId: operation.id, status: 'APPROVED', payload: approvedWrite.permission.approvedRequests[0]! });
    // P22 BIS: the approval is current, so the intent passes the broker approval gate and reaches
    // the provider-authority check — but no reviewed WRITE provider adapter exists in any
    // deployable configuration, so the authority must fail closed. Approval alone never
    // authorizes execution: outcome FAILED (never STARTED) and the provider is never entered.
    const authorityError = await makeBroker('WRITE').invoke(approvedWrite.call, approvedWrite.permission).then(
      () => { throw new Error('EXPECTED the approved WRITE intent to be refused without a WRITE provider authority'); },
      (error: unknown) => error,
    );
    assert(
      authorityError instanceof DomainError && authorityError.code === 'DENIED' && authorityError.message === 'Tool provider authority changed',
      'approved WRITE intent fails closed at the provider-authority gate (DENIED)',
    );
    assert.equal(await outcome(approvedWrite.call.intentId), 'FAILED', 'approved WRITE without WRITE provider authority is FAILED before provider entry, never STARTED');
    assert.equal(calls, 1, 'provider never entered for an approved WRITE intent without WRITE provider authority');
    console.log('PASS: PostgreSQL tool authorization — valid READ through the full P21 authority, revocation during quota/ledger, membership removal, interruption, expiry and stale WRITE approval, plus the broker approval gate and fail-closed provider-authority refusal; provider entered only for the authorized READ.');
  } finally {
    await connection.close();
    await qa.drop();
    console.log('Disposable tool-authorization database dropped.');
  }
}
main().catch((error: unknown) => { console.error('Tool authorization QA FAILED:', error); process.exitCode = 1; });
