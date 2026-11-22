import { and, eq } from 'drizzle-orm';
import { DomainError, isConsentActive } from '@qeynox/domain';
import { PgExecutionAuthority, agentProfiles, capabilities, approvals, attempts, consents, identityMemberships, operations, type QeyNoxDatabase } from '@qeynox/persistence';
import { resolveConfiguredProviders } from './providers/configured';
import type { ConnectorCall, PermissionContext, ToolDefinition } from './types';

/** Last authorization decision after quota/ledger waits, immediately before provider invocation. */
export interface ToolAuthorizationPort {
  assertCurrent(call: ConnectorCall, permission: PermissionContext, definition: ToolDefinition): Promise<void>;
}

/** The runtime adapter reads canonical PostgreSQL state, never a run-start permission snapshot. */
export class PgToolAuthorization implements ToolAuthorizationPort {
  constructor(private readonly db: QeyNoxDatabase) {}

  async assertCurrent(call: ConnectorCall, permission: PermissionContext, definition: ToolDefinition): Promise<void> {
    const actor = permission.principal;
    const [scope] = await this.db.select({ id: operations.id }).from(operations)
      .innerJoin(attempts, and(eq(attempts.operationId, operations.id), eq(attempts.id, call.stepAttemptId), eq(attempts.revisionId, call.planRevisionId), eq(attempts.state, 'RUNNING')))
      .innerJoin(identityMemberships, and(eq(identityMemberships.workspaceId, operations.workspaceId), eq(identityMemberships.userId, actor.userId), eq(identityMemberships.status, 'ACTIVE')))
      .where(and(eq(operations.id, call.operationId), eq(operations.workspaceId, actor.workspaceId), eq(operations.createdBy, actor.userId), eq(operations.currentRevisionId, call.planRevisionId), eq(operations.status, 'RUNNING'))).limit(1);
    if (!scope) throw new DomainError('DENIED', 'Tool operation or active membership changed');
    // A long inference/quota wait must not retain a disabled provider, capability or profile.
    const [capability] = await this.db.select().from(capabilities).where(and(eq(capabilities.id, call.capabilityId), eq(capabilities.status, 'ACTIVE'))).limit(1);
    const [profile] = await this.db.select().from(agentProfiles).where(and(eq(agentProfiles.id, permission.profileId), eq(agentProfiles.version, permission.profileVersion), eq(agentProfiles.active, true))).limit(1);
    const ref = call.connectorId + ':' + call.toolName + '@' + call.version;
    if (!capability?.payload.allowedTools.includes(ref) || !profile || profile.roleKey !== 'business:' + capability.slot || !Array.isArray(profile.payload.allowedTools) || !profile.payload.allowedTools.includes(ref)) throw new DomainError('DENIED', 'Tool capability or profile is no longer active');
    const { registry } = await resolveConfiguredProviders(this.db);
    const current = registry.lookup(call.connectorId, call.toolName, call.version).definition;
    if (current.mode !== definition.mode || !current.allowedCapabilities.includes(call.capabilityId)) throw new DomainError('DENIED', 'Tool provider authority changed');
    if (definition.mode === 'WRITE') {
      const [approval] = call.approvalId ? await this.db.select().from(approvals).where(and(
        eq(approvals.id, call.approvalId), eq(approvals.workspaceId, actor.workspaceId),
        eq(approvals.operationId, call.operationId), eq(approvals.status, 'APPROVED'),
      )).limit(1) : [];
      const current = approval?.payload;
      if (!current || current.status !== 'APPROVED' || current.intentId !== call.intentId ||
          current.workspaceId !== actor.workspaceId || current.operationId !== call.operationId ||
          current.planRevisionId !== call.planRevisionId || current.stepAttemptId !== call.stepAttemptId ||
          !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) {
        throw new DomainError('DENIED', 'Write approval expired or is no longer active');
      }
    }

    const rows = await this.db.select().from(consents).where(and(eq(consents.workspaceId, actor.workspaceId), eq(consents.userId, actor.userId)));
    const now = new Date().toISOString();
    const scopes = new Set(rows.flatMap(row => row.payload.userId === actor.userId && row.payload.workspaceId === actor.workspaceId && isConsentActive(row.payload, now) ? [...row.payload.scopes] : []));
    if (definition.requiredScopes.some(scope => !scopes.has(scope))) throw new DomainError('DENIED', 'Tool consent expired or was revoked before invocation');
    // Preserve the checks above. The final short snapshot closes their intervening DB waits and
    // additionally fences resumed attempts, revoked beta admissions and stale spend reservations.
    if (permission.attemptVersion === undefined || permission.capabilityVersion === undefined || !permission.reservationId) throw new DomainError('DENIED', 'Tool execution epoch and reservation required');
    await new PgExecutionAuthority(this.db).assertCurrent({ principal: actor, operationId: call.operationId,
      planRevisionId: call.planRevisionId, stepAttemptId: call.stepAttemptId, attemptVersion: permission.attemptVersion,
      capabilityId: call.capabilityId, capabilityVersion: permission.capabilityVersion,
      profileId: permission.profileId, profileVersion: permission.profileVersion, context: permission.contextAuthority,
    }, { intentId: call.intentId, requiredScopes: definition.requiredScopes, connector: { id: call.connectorId, version: call.version },
      reservation: { id: permission.reservationId, kind: 'TOOL', provider: ref, key: call.idempotencyKey },
      ...(definition.mode === 'WRITE' ? { writeApproval: { id: call.approvalId!, intentId: call.intentId } } : {}),
    });
  }
}
