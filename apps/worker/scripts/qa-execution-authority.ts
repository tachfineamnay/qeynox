/** P21 regression source for P22 execution. Real disposable PostgreSQL, no provider calls.
 * Sequential negative cases are not a multi-worker/concurrency certification. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DomainError, type CapabilityDefinition, type Consent, type ID, type Principal, type StepAttempt } from '@qeynox/domain';
import { PgExecutionAuthority, QeyNoxStore, connectDatabase, runMigrations, identityUsers, identityWorkspaces,
  identityMemberships, operations, steps, capabilities, agentProfiles, attempts, consents, betaGrants, betaGrantMissions,
  usageReservations, betaGrantEvents, toolConfigurations, approvals, toolIntents, toolLedger, type MissionAuthorityScope,
} from '@qeynox/persistence';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

async function main(): Promise<void> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL required; no execution-authority certification.');
    process.exitCode = 3;
    return;
  }
  const qa = await createIsolatedQaDatabase(), connection = connectDatabase(qa.url);
  try {
    await runMigrations(qa.url);
    const db = connection.db, store = new QeyNoxStore(db), authority = new PgExecutionAuthority(db);
    const id = () => randomUUID() as ID;
    const actor: Principal = { userId: id(), workspaceId: id(), roles: ['OWNER'] };
    await db.insert(identityUsers).values({ id: actor.userId, email: actor.userId + '@example.invalid' });
    await db.insert(identityWorkspaces).values({ id: actor.workspaceId, name: 'Isolated authority regression', createdBy: actor.userId });
    const memberId = id();
    await db.insert(identityMemberships).values({ id: memberId, userId: actor.userId, workspaceId: actor.workspaceId, role: 'OWNER', status: 'ACTIVE' });
    const op = await store.createOperation(actor, 'Authority regression', 'No external provider', []);
    const revisionId = id(), stepId = id(), profileId = id();
    const capability: CapabilityDefinition = { id: id(), slot: 1, version: 1, status: 'ACTIVE', scope: [], allowedTools: [], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 2, maximumToolCalls: 1, privacyScopes: ['context:read'] };
    await db.insert(capabilities).values({ id: capability.id, slot: 1, version: 1, status: 'ACTIVE', payload: capability });
    await db.insert(agentProfiles).values({ id: profileId, roleKey: 'business:1', version: 1, active: true, payload: { allowedTools: [], permittedContextKeys: [] } });
    await db.insert(steps).values({ id: stepId, operationId: op.id, revisionId, payload: { id: stepId, operationId: op.id, planRevisionId: revisionId, capabilityId: capability.id, ordinal: 1, title: 'Read authority', description: 'No external calls', dependsOn: [], state: 'PENDING', intent: 'RESEARCH', version: 1 } });
    const attempt: StepAttempt = { id: id(), operationId: op.id, workStepId: stepId, planRevisionId: revisionId, sequence: 1, version: 2, state: 'RUNNING', createdAt: new Date().toISOString() };
    await store.putStepAttempt(attempt);
    await db.update(operations).set({ status: 'RUNNING', currentRevisionId: revisionId, payload: { ...op, status: 'RUNNING', currentRevisionId: revisionId } }).where(eq(operations.id, op.id));
    const permit: Consent = { id: id(), userId: actor.userId, workspaceId: actor.workspaceId, purpose: 'Explicit test consent', scopes: ['context:read'], version: 1, grantedAt: new Date().toISOString() };
    await store.putConsent(permit);
    const grantId = id(), activatedAt = new Date(), expiresAt = new Date(activatedAt.getTime() + 3600000);
    // P22 BIS: seed the grant with the canonical activation columns required by migration 0026
    // (beta_grants_activation_consistent, beta_grants_expiry_after_creation, activation/revocation
    // consistency). Exactly as an operator-activated grant is recorded; no constraint is bypassed.
    await db.insert(betaGrants).values({ id: grantId, workspaceId: actor.workspaceId, status: 'ACTIVE', expiresAt, missionQuota: 10, concurrentLimit: 2, maxProviderSpendMinor: 1000, currency: 'USD', grantedBy: actor.userId, grantReason: 'Isolated authority regression', createdAt: activatedAt, activatedAt, activatedBy: actor.userId, updatedAt: activatedAt });
    await db.insert(betaGrantMissions).values({ id: id(), grantId, workspaceId: actor.workspaceId, operationId: op.id, admittedBy: actor.userId });
    const scope: MissionAuthorityScope = { principal: actor, operationId: op.id, planRevisionId: revisionId, stepAttemptId: attempt.id, attemptVersion: 2, capabilityId: capability.id, capabilityVersion: 1, profileId, profileVersion: 1 };
    const refused = (error: unknown) => error instanceof DomainError && ['DENIED', 'BETA_ACCESS_REQUIRED', 'CONFLICT', 'UNKNOWN_OUTCOME'].includes(error.code);
    await authority.assertCurrent(scope);
    await db.update(identityMemberships).set({ status: 'REVOKED' }).where(eq(identityMemberships.id, memberId));
    await assert.rejects(authority.assertCurrent(scope), refused);
    await db.update(identityMemberships).set({ status: 'ACTIVE' }).where(eq(identityMemberships.id, memberId));
    await db.update(consents).set({ payload: { ...permit, revokedAt: new Date().toISOString(), version: 2 } }).where(eq(consents.id, permit.id));
    await assert.rejects(authority.assertCurrent(scope), refused);
    await db.update(consents).set({ payload: permit }).where(eq(consents.id, permit.id));
    await db.update(betaGrants).set({ status: 'REVOKED', revokedAt: new Date() }).where(eq(betaGrants.id, grantId));
    await assert.rejects(authority.assertCurrent(scope), refused);
    await db.update(betaGrants).set({ status: 'ACTIVE', revokedAt: null }).where(eq(betaGrants.id, grantId));
    await db.update(operations).set({ currentRevisionId: id() }).where(eq(operations.id, op.id));
    await assert.rejects(authority.assertCurrent(scope), refused);
    await db.update(operations).set({ currentRevisionId: revisionId }).where(eq(operations.id, op.id));
    for (const status of ['INTERRUPT_REQUESTED', 'INTERRUPTED', 'FAILED', 'SUPERSEDED']) {
      await db.update(operations).set({ status }).where(eq(operations.id, op.id));
      await assert.rejects(authority.assertCurrent(scope), refused);
    }
    await db.update(operations).set({ status: 'RUNNING' }).where(eq(operations.id, op.id));
    await db.update(attempts).set({ payload: { ...attempt, version: 4 } }).where(eq(attempts.id, attempt.id));
    await assert.rejects(authority.assertCurrent(scope), refused, 'same attempt ID with a new version must fence the old worker');
    await db.update(attempts).set({ payload: attempt }).where(eq(attempts.id, attempt.id));
    await db.update(capabilities).set({ status: 'DISABLED' }).where(eq(capabilities.id, capability.id));
    await assert.rejects(authority.assertCurrent(scope), refused);
    await db.update(capabilities).set({ status: 'ACTIVE' }).where(eq(capabilities.id, capability.id));
    await db.update(agentProfiles).set({ active: false }).where(eq(agentProfiles.id, profileId));
    await assert.rejects(authority.assertCurrent(scope), refused);
    await db.update(agentProfiles).set({ active: true }).where(eq(agentProfiles.id, profileId));
    const providerId = id();
    await db.insert(toolConfigurations).values({ id: providerId, connectorId: 'qa-no-network', connectorVersion: '1', status: 'DISABLED', payload: {}, digest: 'qa-fixture', configuredBy: actor.userId });
    await assert.rejects(authority.assertCurrent(scope, { connector: { id: 'qa-no-network', version: '1' } }), refused);
    const approvalId = id(), intentId = id();
    await db.insert(approvals).values({ id: approvalId, workspaceId: actor.workspaceId, operationId: op.id, status: 'APPROVED', payload: { id: approvalId, workspaceId: actor.workspaceId, operationId: op.id, planRevisionId: revisionId, stepAttemptId: attempt.id, intentId, purpose: 'QA only, no WRITE adapter', status: 'APPROVED', requestedAt: new Date().toISOString(), expiresAt: '2000-01-01T00:00:00.000Z' } });
    await assert.rejects(authority.assertCurrent(scope, { writeApproval: { id: approvalId, intentId } }), refused);
    const ambiguousIntent=id();
    await db.insert(toolIntents).values({id:ambiguousIntent,operationId:op.id,idempotencyKey:id(),payload:{id:ambiguousIntent,operationId:op.id,planRevisionId:revisionId,stepAttemptId:attempt.id,capabilityId:capability.id,toolName:'qa-write@1',toolVersion:'1',payload:{},idempotencyKey:id(),mode:'WRITE',requestedBy:actor.userId,createdAt:new Date().toISOString()}});
    await db.insert(toolLedger).values({id:id(),workspaceId:actor.workspaceId,operationId:op.id,attemptId:attempt.id,intentId:ambiguousIntent,connector:'qa-no-network',outcome:'STARTED',requestDigest:'qa-only',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    await assert.rejects(authority.assertCurrent(scope),refused,'an in-progress WRITE must not authorize new execution');
    await db.update(toolLedger).set({outcome:'UNKNOWN'}).where(eq(toolLedger.intentId,ambiguousIntent));
    await assert.rejects(authority.assertCurrent(scope),refused,'an uncertain WRITE must not be replayed through another turn');
    await db.update(toolLedger).set({outcome:'COMPLETED'}).where(eq(toolLedger.intentId,ambiguousIntent));
    await authority.assertCurrent(scope);
    const reservationId = id();
    await db.insert(usageReservations).values({ id: reservationId, workspaceId: actor.workspaceId, operationId: op.id, attemptId: attempt.id, key: id(), kind: 'ENGINE', providerKey: 'hermes', policyVersion: 1, reservedMinor: 1, state: 'RESERVED', createdAt: new Date().toISOString() });
    await db.insert(betaGrantEvents).values({ id: id(), grantId, workspaceId: actor.workspaceId, operationId: op.id, kind: 'SPEND_RESERVED', reservationId, amountMinor: 1 });
    await authority.admitInference(scope, reservationId);
    await assert.rejects(authority.admitInference(scope, reservationId), refused, 'a durable inference admission is never a replay permit');
    console.log('PASS: sequential PostgreSQL authority regressions; no provider or full concurrency certification.');
  } finally {
    await connection.close();
    await qa.drop();
  }
}
main().catch((error: unknown) => { console.error('Execution authority regression failed:', error); process.exitCode = 1; });
