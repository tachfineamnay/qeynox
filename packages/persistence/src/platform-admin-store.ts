import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DomainError, isPlatformRole, type PlatformRole } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { identityUsers, identityWorkspaces } from './identity-schema';
import { platformAdminAssignments, platformAdminAudit, platformAdminSessions } from './platform-admin-schema';
import { attempts, executions, operations, outbox } from './schema';

export type PlatformAssignmentStatus = 'ACTIVE' | 'REVOKED';
export type PlatformAuditOutcome = 'SUCCESS' | 'DENIED' | 'ERROR';
export type PlatformRevokeOutcome = 'REVOKED' | 'NOT_FOUND' | 'LAST_ADMIN' | 'CONFLICT';

export interface PlatformAssignmentRecord {
  readonly id: string;
  readonly userId: string;
  readonly role: PlatformRole;
  readonly status: PlatformAssignmentStatus;
  readonly grantedBy: string;
  readonly grantReason: string;
  readonly grantedAt: Date;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly revokedAt: Date | null;
}

export interface PlatformSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface PlatformAuditRecord {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorSessionId: string | null;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly action: string;
  readonly permission: string | null;
  readonly outcome: PlatformAuditOutcome;
  readonly reason: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly happenedAt: Date;
}

export interface PlatformIdentityUser { readonly id: string; readonly email: string; readonly disabledAt: Date | null }

export interface PlatformOperationSummary {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  readonly title: string;
  readonly status: string;
  readonly version: number;
  readonly createdBy: string;
  readonly currentRevisionId: string | null;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
}

export interface PlatformOperationRuntime {
  readonly operationId: string;
  readonly dispatch: readonly { readonly id: string; readonly state: string; readonly topic: string; readonly attempts: number; readonly lastErrorCode: string | null }[];
  readonly executions: readonly { readonly id: string; readonly attemptId: string; readonly provider: string; readonly runId: string | null; readonly status: string }[];
  readonly attempts: readonly { readonly id: string; readonly stepId: string; readonly state: string; readonly sequence: number }[];
}

export interface PlatformRevokeGuardInput {
  readonly assignmentId: string;
  readonly role: PlatformRole;
  readonly targetUserId: string;
  readonly revokedBy: string;
  readonly reason: string;
  readonly at: Date;
  readonly successAudit: PlatformAuditRecord;
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

function assignmentStatus(value: string): PlatformAssignmentStatus {
  if (value === 'ACTIVE' || value === 'REVOKED') return value;
  throw new DomainError('INVALID_STATE', 'Unknown stored platform assignment status: ' + value);
}

function auditOutcome(value: string): PlatformAuditOutcome {
  if (value === 'SUCCESS' || value === 'DENIED' || value === 'ERROR') return value;
  throw new DomainError('INVALID_STATE', 'Unknown stored platform audit outcome: ' + value);
}

function assignmentOf(row: typeof platformAdminAssignments.$inferSelect): PlatformAssignmentRecord {
  if (!isPlatformRole(row.role)) throw new DomainError('INVALID_STATE', 'Unknown stored platform role: ' + row.role);
  return {
    id: row.id, userId: row.userId, role: row.role, status: assignmentStatus(row.status),
    grantedBy: row.grantedBy, grantReason: row.grantReason, grantedAt: row.grantedAt,
    revokedBy: row.revokedBy, revokeReason: row.revokeReason, revokedAt: row.revokedAt,
  };
}

function sessionOf(row: typeof platformAdminSessions.$inferSelect): PlatformSessionRecord {
  return {
    id: row.id, userId: row.userId, tokenHash: row.tokenHash, expiresAt: row.expiresAt,
    revokedAt: row.revokedAt, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
  };
}

function auditOf(row: typeof platformAdminAudit.$inferSelect): PlatformAuditRecord {
  return {
    id: row.id, actorUserId: row.actorUserId, actorSessionId: row.actorSessionId,
    targetType: row.targetType, targetId: row.targetId, action: row.action,
    permission: row.permission, outcome: auditOutcome(row.outcome), reason: row.reason,
    detail: row.detail ?? null, happenedAt: row.happenedAt,
  };
}

function auditValues(record: PlatformAuditRecord) {
  return {
    id: record.id, actorUserId: record.actorUserId, actorSessionId: record.actorSessionId,
    targetType: record.targetType, targetId: record.targetId, action: record.action,
    permission: record.permission, outcome: record.outcome, reason: record.reason,
    detail: record.detail, happenedAt: record.happenedAt,
  };
}

/**
 * Drizzle adapter for the platform-administration port.
 *
 * Mutations that grant/revoke authority are transactional with their session revocation and audit
 * row, and the revocation of a PLATFORM_ADMIN locks the active administrator rows before counting
 * so two concurrent revocations cannot remove the last administrator. This adapter only reads
 * identity_users for account status; platform authorization never consults identity_memberships.
 */
export class PlatformAdminStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async findIdentityUser(userId: string): Promise<PlatformIdentityUser | undefined> {
    const [row] = await this.db.select({ id: identityUsers.id, email: identityUsers.email, disabledAt: identityUsers.disabledAt })
      .from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    return row;
  }

  async listActiveAssignments(userId: string): Promise<readonly PlatformAssignmentRecord[]> {
    const rows = await this.db.select().from(platformAdminAssignments)
      .where(and(eq(platformAdminAssignments.userId, userId), eq(platformAdminAssignments.status, 'ACTIVE')))
      .orderBy(platformAdminAssignments.grantedAt);
    return rows.map(assignmentOf);
  }

  async findActiveAssignment(userId: string, role: PlatformRole): Promise<PlatformAssignmentRecord | undefined> {
    const [row] = await this.db.select().from(platformAdminAssignments)
      .where(and(eq(platformAdminAssignments.userId, userId), eq(platformAdminAssignments.role, role), eq(platformAdminAssignments.status, 'ACTIVE')))
      .limit(1);
    return row ? assignmentOf(row) : undefined;
  }

  async listAssignments(limit: number): Promise<readonly PlatformAssignmentRecord[]> {
    const rows = await this.db.select().from(platformAdminAssignments)
      .orderBy(desc(platformAdminAssignments.grantedAt)).limit(limit);
    return rows.map(assignmentOf);
  }

  async insertAudit(record: PlatformAuditRecord): Promise<void> {
    await this.db.insert(platformAdminAudit).values(auditValues(record));
  }

  async listAudit(limit: number): Promise<readonly PlatformAuditRecord[]> {
    const rows = await this.db.select().from(platformAdminAudit)
      .orderBy(desc(platformAdminAudit.happenedAt)).limit(limit);
    return rows.map(auditOf);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<PlatformSessionRecord | undefined> {
    const [row] = await this.db.select().from(platformAdminSessions)
      .where(eq(platformAdminSessions.tokenHash, tokenHash)).limit(1);
    return row ? sessionOf(row) : undefined;
  }

  async touchSession(id: string, at: Date): Promise<void> {
    await this.db.update(platformAdminSessions).set({ lastUsedAt: at }).where(eq(platformAdminSessions.id, id));
  }

  async insertSessionWithAudit(session: PlatformSessionRecord, audit: PlatformAuditRecord): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.insert(platformAdminSessions).values({
        id: session.id, userId: session.userId, tokenHash: session.tokenHash,
        expiresAt: session.expiresAt, revokedAt: session.revokedAt,
        createdAt: session.createdAt, lastUsedAt: session.lastUsedAt,
      });
      await tx.insert(platformAdminAudit).values(auditValues(audit));
    });
  }

  async revokeSessionWithAudit(sessionId: string, at: Date, audit: PlatformAuditRecord): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.update(platformAdminSessions).set({ revokedAt: at })
        .where(and(eq(platformAdminSessions.id, sessionId), isNull(platformAdminSessions.revokedAt)));
      await tx.insert(platformAdminAudit).values(auditValues(audit));
    });
  }

  async assignWithAudit(
    assignment: PlatformAssignmentRecord,
    audit: PlatformAuditRecord,
    targetUserId: string,
    at: Date,
  ): Promise<'INSERTED' | 'CONFLICT'> {
    try {
      await this.db.transaction(async tx => {
        await tx.insert(platformAdminAssignments).values({
          id: assignment.id, userId: assignment.userId, role: assignment.role, status: assignment.status,
          grantedBy: assignment.grantedBy, grantReason: assignment.grantReason, grantedAt: assignment.grantedAt,
          revokedBy: null, revokeReason: null, revokedAt: null,
        });
        await tx.update(platformAdminSessions).set({ revokedAt: at })
          .where(and(eq(platformAdminSessions.userId, targetUserId), isNull(platformAdminSessions.revokedAt)));
        await tx.insert(platformAdminAudit).values(auditValues(audit));
      });
      return 'INSERTED';
    } catch (error: unknown) {
      if (uniqueViolation(error)) return 'CONFLICT';
      throw error;
    }
  }

  async revokeAssignmentGuarded(input: PlatformRevokeGuardInput): Promise<PlatformRevokeOutcome> {
    return this.db.transaction(async tx => {
      const [target] = await tx.select().from(platformAdminAssignments)
        .where(and(eq(platformAdminAssignments.id, input.assignmentId), eq(platformAdminAssignments.status, 'ACTIVE')))
        .limit(1);
      if (!target) return 'NOT_FOUND';
      if (input.role === 'PLATFORM_ADMIN') {
        // Lock every active administrator row in a deterministic order, then re-count inside the
        // same transaction: concurrent revocations serialize instead of both observing two admins.
        const activeAdmins = await tx.select({ id: platformAdminAssignments.id }).from(platformAdminAssignments)
          .where(and(eq(platformAdminAssignments.role, 'PLATFORM_ADMIN'), eq(platformAdminAssignments.status, 'ACTIVE')))
          .orderBy(platformAdminAssignments.id).for('update');
        if (activeAdmins.length <= 1) return 'LAST_ADMIN';
      } else {
        await tx.select({ id: platformAdminAssignments.id }).from(platformAdminAssignments)
          .where(and(eq(platformAdminAssignments.id, input.assignmentId), eq(platformAdminAssignments.status, 'ACTIVE')))
          .for('update');
      }
      const changed = await tx.update(platformAdminAssignments)
        .set({ status: 'REVOKED', revokedBy: input.revokedBy, revokeReason: input.reason, revokedAt: input.at })
        .where(and(eq(platformAdminAssignments.id, input.assignmentId), eq(platformAdminAssignments.status, 'ACTIVE')))
        .returning({ id: platformAdminAssignments.id });
      if (!changed.length) return 'CONFLICT';
      await tx.update(platformAdminSessions).set({ revokedAt: input.at })
        .where(and(eq(platformAdminSessions.userId, input.targetUserId), isNull(platformAdminSessions.revokedAt)));
      await tx.insert(platformAdminAudit).values(auditValues(input.successAudit));
      return 'REVOKED';
    });
  }

  async readOperationSummary(operationId: string): Promise<PlatformOperationSummary | undefined> {
    const [row] = await this.db.select().from(operations).where(eq(operations.id, operationId)).limit(1);
    if (!row) return undefined;
    const [workspace] = await this.db.select({ name: identityWorkspaces.name }).from(identityWorkspaces)
      .where(eq(identityWorkspaces.id, row.workspaceId)).limit(1);
    return {
      operationId: row.id, workspaceId: row.workspaceId, workspaceName: workspace?.name ?? null,
      title: row.payload.title, status: row.status, version: row.version, createdBy: row.createdBy,
      currentRevisionId: row.currentRevisionId ?? null, updatedAt: row.payload.updatedAt,
      lastActivityAt: row.lastActivityAt,
    };
  }

  async readOperationRuntime(operationId: string): Promise<PlatformOperationRuntime | undefined> {
    const [operation] = await this.db.select({ id: operations.id }).from(operations).where(eq(operations.id, operationId)).limit(1);
    if (!operation) return undefined;
    const [dispatchRows, executionRows, attemptRows] = await Promise.all([
      this.db.select().from(outbox).where(eq(outbox.operationId, operationId)),
      this.db.select().from(executions).where(eq(executions.operationId, operationId)),
      this.db.select().from(attempts).where(eq(attempts.operationId, operationId)).orderBy(desc(attempts.sequence)),
    ]);
    return {
      operationId,
      dispatch: dispatchRows.map(row => ({ id: row.id, state: row.state, topic: row.topic, attempts: row.attempts, lastErrorCode: row.lastError })),
      executions: executionRows.map(row => ({ id: row.id, attemptId: row.attemptId, provider: row.provider, runId: row.workflowRunId, status: row.payload.status })),
      attempts: attemptRows.map(row => ({ id: row.id, stepId: row.stepId, state: row.state, sequence: row.sequence })),
    };
  }
}
