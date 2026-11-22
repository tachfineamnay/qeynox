import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DomainError, isConsentActive, newId, type Principal } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { agentProfiles, approvals, attempts, capabilities, commandIds, consents, operations, steps, toolLedger, toolIntents } from './schema';
import { identityMemberships, identityUsers } from './identity-schema';
import { betaGrantEvents, betaGrantMissions, betaGrants } from './beta-access-schema';
import { usageReservations } from './budget-schema';
import { toolConfigurations } from './config-schema';
import { documentChunks, documents, operationDocuments } from './document-schema';

// A DB stall must not turn a last-moment snapshot into a long-lived bearer permission.
const MAX_ADMISSION_AGE_MS = 2000;
function assertFresh(observedAt:number):void {
  if(Date.now()-observedAt>MAX_ADMISSION_AGE_MS)throw new DomainError('DENIED','Execution authority admission expired before dispatch');
}
type Transaction = Parameters<Parameters<QeyNoxDatabase['transaction']>[0]>[0];
export interface MissionContextAuthority {
  readonly consents: readonly { readonly id: string; readonly version: number }[];
  readonly documents: readonly { readonly documentId: string; readonly chunkId: string; readonly documentSha256: string }[];
}
export interface MissionAuthorityScope {
  readonly principal: Principal;
  readonly operationId: string;
  readonly planRevisionId: string;
  readonly stepAttemptId: string;
  /** Existing StepAttempt.version is the epoch; retry/resume must never revive an old worker. */
  readonly attemptVersion: number;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly context?: MissionContextAuthority;
}
export interface MissionAuthorityCall {
  readonly intentId?: string;
  readonly requiredScopes?: readonly string[];
  readonly connector?: { readonly id: string; readonly version: string };
  readonly writeApproval?: { readonly id: string; readonly intentId: string };
  readonly reservation?: { readonly id: string; readonly kind: 'ENGINE' | 'TOOL'; readonly provider: string; readonly key?: string };
}

/** Short DB-only admission. Never pass a network callback or hold this transaction during I/O.
 * Revocation committed before this snapshot refuses a NEW call. A call admitted before revocation
 * is in-flight, not retroactively undoable. Every subsequent turn/tool takes another snapshot.
 */
export class PgExecutionAuthority {
  constructor(private readonly db: QeyNoxDatabase) {}

  async assertCurrent(scope: MissionAuthorityScope, call: MissionAuthorityCall = {}): Promise<void> {
    const observedAt=await this.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      return this.check(tx, scope, call);
    });
    assertFresh(observedAt);
  }

  async admitInference(scope: MissionAuthorityScope, reservationId: string): Promise<void> {
    const observedAt=await this.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '2000ms'`);
      const snapshotAt=await this.check(tx, scope, { reservation: { id: reservationId, kind: 'ENGINE', provider: 'hermes' } });
      // Existing durable unique workspace/command key is sufficient: no new lease table or retry loop.
      // A crash after admission leaves an uncertain reservation; it never licenses another call.
      const [claimed] = await tx.insert(commandIds).values({ id: newId(), workspaceId: scope.principal.workspaceId,
        operationId: scope.operationId, commandKey: 'inference:' + reservationId,
        outcome: { phase: 'ADMITTED', attemptId: scope.stepAttemptId, attemptVersion: scope.attemptVersion }, createdAt: new Date().toISOString(),
      }).onConflictDoNothing().returning({ id: commandIds.id });
      if (!claimed) throw new DomainError('CONFLICT', 'Inference reservation already admitted; reconcile instead of replaying');
      assertFresh(snapshotAt);
      return snapshotAt;
    });
    assertFresh(observedAt);
  }

  private async check(tx: Transaction, scope: MissionAuthorityScope, call: MissionAuthorityCall): Promise<number> {
    const observedAt=Date.now();
    const actor = scope.principal;
    const [current] = await tx.select({ attempt: attempts.payload, capability: capabilities.payload, profile: agentProfiles.payload })
      .from(operations)
      .innerJoin(attempts, and(eq(attempts.operationId, operations.id), eq(attempts.id, scope.stepAttemptId), eq(attempts.revisionId, scope.planRevisionId), eq(attempts.state, 'RUNNING')))
      .innerJoin(steps, and(eq(steps.id, attempts.stepId), eq(steps.operationId, operations.id), eq(steps.revisionId, scope.planRevisionId)))
      .innerJoin(capabilities, and(eq(capabilities.id, scope.capabilityId), eq(capabilities.id, sql`${steps.payload}->>'capabilityId'`), eq(capabilities.version, scope.capabilityVersion), eq(capabilities.status, 'ACTIVE')))
      .innerJoin(agentProfiles, and(eq(agentProfiles.id, scope.profileId), eq(agentProfiles.version, scope.profileVersion), eq(agentProfiles.active, true), eq(agentProfiles.roleKey, sql`'business:' || ${capabilities.slot}::text`)))
      .innerJoin(identityMemberships, and(eq(identityMemberships.workspaceId, operations.workspaceId), eq(identityMemberships.userId, actor.userId), eq(identityMemberships.status, 'ACTIVE')))
      .innerJoin(identityUsers, and(eq(identityUsers.id, actor.userId), isNull(identityUsers.disabledAt)))
      .where(and(eq(operations.id, scope.operationId), eq(operations.workspaceId, actor.workspaceId), eq(operations.createdBy, actor.userId), eq(operations.currentRevisionId, scope.planRevisionId), eq(operations.status, 'RUNNING'))).limit(1);
    if (!current || !Number.isSafeInteger(scope.attemptVersion) || current.attempt.version !== scope.attemptVersion) {
      throw new DomainError('DENIED', 'Mission authority or worker epoch changed');
    }
    const [unresolvedWrite] = await tx.select({id:toolLedger.id}).from(toolLedger)
      .innerJoin(toolIntents,eq(toolIntents.id,toolLedger.intentId))
      .where(and(eq(toolLedger.workspaceId,actor.workspaceId),eq(toolLedger.operationId,scope.operationId),sql`${toolIntents.payload}->>'mode' = 'WRITE'`,sql`${toolLedger.outcome} IN ('STARTED','UNKNOWN')`,sql`(${call.intentId??null}::text IS NULL OR ${toolLedger.intentId} <> ${call.intentId??null})`)).limit(1);
    if(unresolvedWrite)throw new DomainError('UNKNOWN_OUTCOME','An earlier external write requires reconciliation before new execution');
    const now = new Date();
    const [admission] = await tx.select({ grant: betaGrants }).from(betaGrantMissions)
      .innerJoin(betaGrants, and(eq(betaGrants.id, betaGrantMissions.grantId), eq(betaGrants.workspaceId, actor.workspaceId)))
      .where(and(eq(betaGrantMissions.workspaceId, actor.workspaceId), eq(betaGrantMissions.operationId, scope.operationId)))
      .orderBy(desc(betaGrantMissions.admittedAt), desc(betaGrantMissions.id)).limit(1);
    if (!admission || admission.grant.status !== 'ACTIVE' || admission.grant.revokedAt || admission.grant.expiresAt <= now) {
      throw new DomainError('BETA_ACCESS_REQUIRED', 'Mission beta admission is no longer active');
    }
    const required = new Set([...current.capability.privacyScopes, ...(call.requiredScopes ?? []), ...(scope.context ? ['context:read'] : [])]);
    const permits = await tx.select().from(consents).where(and(eq(consents.workspaceId, actor.workspaceId), eq(consents.userId, actor.userId)));
    const active = permits.map(row => row.payload).filter(permit => permit.userId === actor.userId && permit.workspaceId === actor.workspaceId && isConsentActive(permit, now.toISOString()));
    if ([...required].some(requiredScope => !active.some(permit => permit.scopes.includes(requiredScope)))) throw new DomainError('DENIED', 'Execution consent revoked or expired');
    for (const binding of scope.context?.consents ?? []) {
      if (!active.some(permit => permit.id === binding.id && permit.version === binding.version && permit.scopes.includes('context:read'))) throw new DomainError('DENIED', 'Prepared context consent changed');
    }
    if (scope.context?.documents.length && !scope.context.consents.length) throw new DomainError('DENIED', 'Prepared documents have no bound consent');
    for (const binding of scope.context?.documents ?? []) {
      const [document] = await tx.select({ id: documents.id }).from(documents)
        .innerJoin(operationDocuments, and(eq(operationDocuments.documentId, documents.id), eq(operationDocuments.workspaceId, actor.workspaceId), eq(operationDocuments.operationId, scope.operationId)))
        .innerJoin(documentChunks, and(eq(documentChunks.id, binding.chunkId), eq(documentChunks.documentId, documents.id), eq(documentChunks.workspaceId, actor.workspaceId)))
        .innerJoin(identityMemberships, and(eq(identityMemberships.userId, operationDocuments.attachedBy), eq(identityMemberships.workspaceId, actor.workspaceId), eq(identityMemberships.status, 'ACTIVE')))
        .where(and(eq(documents.id, binding.documentId), eq(documents.workspaceId, actor.workspaceId), eq(documents.sha256, binding.documentSha256), eq(documents.state, 'AVAILABLE'), isNull(documents.deletedAt), sql`(${documents.expiresAt} IS NULL OR ${documents.expiresAt} > ${now.toISOString()}::timestamptz)`, sql`length(trim(${documents.purpose})) >= 3`)).limit(1);
      if (!document) throw new DomainError('DENIED', 'Prepared document authority changed');
    }
    for (const reference of current.capability.allowedTools) {
      const match = /^([^:]+):([^@]+)@(.+)$/.exec(reference);
      if (!match) throw new DomainError('DENIED', 'Invalid capability provider reference');
      const [configured] = await tx.select({ id: toolConfigurations.id }).from(toolConfigurations).where(and(eq(toolConfigurations.connectorId, match[1]!), eq(toolConfigurations.connectorVersion, match[3]!), eq(toolConfigurations.status, 'ACTIVE'))).limit(1);
      if (!configured) throw new DomainError('DENIED', 'Required provider configuration disabled');
    }
    if (scope.context?.documents.length && (!Array.isArray(current.profile.permittedContextKeys) || !current.profile.permittedContextKeys.includes('documents:excerpts'))) throw new DomainError('DENIED', 'Profile no longer permits document context');
    let writeExpiresAt:string|undefined;
    if (call.writeApproval) {
      const [row] = await tx.select().from(approvals).where(and(eq(approvals.id, call.writeApproval.id), eq(approvals.workspaceId, actor.workspaceId), eq(approvals.operationId, scope.operationId), eq(approvals.status, 'APPROVED'))).limit(1);
      const approval = row?.payload;
      if (!approval || approval.status !== 'APPROVED' || approval.intentId !== call.writeApproval.intentId || approval.workspaceId !== actor.workspaceId || approval.operationId !== scope.operationId || approval.planRevisionId !== scope.planRevisionId || approval.stepAttemptId !== scope.stepAttemptId || !isConsentActive({ expiresAt: approval.expiresAt }, new Date().toISOString())) throw new DomainError('DENIED', 'Write approval no longer authorizes this invocation');
      writeExpiresAt=approval.expiresAt;
    }
    if (call.connector) {
      const [configuration] = await tx.select({ id: toolConfigurations.id }).from(toolConfigurations).where(and(eq(toolConfigurations.connectorId, call.connector.id), eq(toolConfigurations.connectorVersion, call.connector.version), eq(toolConfigurations.status, 'ACTIVE'))).limit(1);
      if (!configuration) throw new DomainError('DENIED', 'Provider configuration disabled');
    }
    if (call.reservation) {
      const [reservation] = await tx.select({ id: usageReservations.id }).from(usageReservations).where(and(eq(usageReservations.id, call.reservation.id), eq(usageReservations.workspaceId, actor.workspaceId), eq(usageReservations.operationId, scope.operationId), eq(usageReservations.attemptId, scope.stepAttemptId), eq(usageReservations.kind, call.reservation.kind), eq(usageReservations.providerKey, call.reservation.provider), eq(usageReservations.state, 'RESERVED'), ...(call.reservation.key ? [eq(usageReservations.key,call.reservation.key)] : []))).limit(1);
      if (!reservation) throw new DomainError('DENIED', 'Provider reservation is not current');
      const [betaReservation]=await tx.select({id:betaGrantEvents.id}).from(betaGrantEvents).where(and(eq(betaGrantEvents.workspaceId,actor.workspaceId),eq(betaGrantEvents.operationId,scope.operationId),eq(betaGrantEvents.grantId,admission.grant.id),eq(betaGrantEvents.reservationId,call.reservation.id),eq(betaGrantEvents.kind,'SPEND_RESERVED'))).limit(1);
      if(!betaReservation)throw new DomainError('BETA_ACCESS_REQUIRED','Provider reservation belongs to a different beta admission');
    }
    const atDispatch=new Date().toISOString();
    if(admission.grant.expiresAt<=new Date(atDispatch))throw new DomainError('BETA_ACCESS_REQUIRED','Beta grant expired during admission');
    if([...required].some(requiredScope=>!active.some(permit=>permit.scopes.includes(requiredScope)&&isConsentActive(permit,atDispatch))))throw new DomainError('DENIED','Consent expired during admission');
    if((scope.context?.consents??[]).some(binding=>!active.some(permit=>permit.id===binding.id&&permit.version===binding.version&&isConsentActive(permit,atDispatch))))throw new DomainError('DENIED','Bound context consent expired during admission');
    if(writeExpiresAt&&!isConsentActive({expiresAt:writeExpiresAt},atDispatch))throw new DomainError('DENIED','Write approval expired during admission');
    assertFresh(observedAt);
    return observedAt;
  }
}
