import { and, eq } from 'drizzle-orm';
import { DomainError, isConsentActive } from '@qeynox/domain';
import { approvals, attempts, consents, identityMemberships, operations, type QeyNoxDatabase } from '@qeynox/persistence';
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
    if (!definition.requiredScopes.length) return;
    const rows = await this.db.select().from(consents).where(and(eq(consents.workspaceId, actor.workspaceId), eq(consents.userId, actor.userId)));
    const now = new Date().toISOString();
    const scopes = new Set(rows.flatMap(row => row.payload.userId === actor.userId && row.payload.workspaceId === actor.workspaceId && isConsentActive(row.payload, now) ? [...row.payload.scopes] : []));
    if (definition.requiredScopes.some(scope => !scopes.has(scope))) throw new DomainError('DENIED', 'Tool consent expired or was revoked before invocation');
  }
}
