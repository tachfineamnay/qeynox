import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { isPlatformRole, type PlatformRole } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import {
  identityAudit,
  identityMemberships,
  identitySessions,
  identityUsers,
  identityWorkspaces,
} from './identity-schema';
import { platformAdminAssignments, platformAdminAudit, platformAdminSessions } from './platform-admin-schema';
import { platformAuditValues, type PlatformAuditRecord } from './platform-admin-store';

export interface PlatformUserCursor { readonly at: Date; readonly id: string }

export interface PlatformUserRow {
  readonly id: string;
  readonly email: string;
  readonly locale: string;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export interface PlatformUserMembershipRow {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: string;
  readonly membershipStatus: string;
  readonly workspaceCreatedAt: Date;
}

/** Session metadata only: the token hash is never selected or returned. */
export interface PlatformIdentitySessionRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface PlatformUserActivityRow {
  readonly source: 'IDENTITY' | 'PLATFORM';
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly happenedAt: Date;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly permission: string | null;
}

export type PlatformSuspendOutcome = 'SUSPENDED' | 'ALREADY_SUSPENDED' | 'NOT_FOUND' | 'LAST_ADMIN' | 'LAST_WORKSPACE_OWNER';
export type PlatformReactivateOutcome = 'REACTIVATED' | 'NOT_SUSPENDED' | 'NOT_FOUND';
export type PlatformSessionRevokeOutcome = 'REVOKED' | 'NOT_FOUND';

const maximumSessionsListed = 200;
/** Only account-lifecycle actions appear in a user timeline; unrelated platform audits stay hidden. */
const accountLifecycleActions = [
  'SUSPEND_PLATFORM_USER',
  'REACTIVATE_PLATFORM_USER',
  'REVOKE_USER_SESSIONS',
  'INVITE_WORKSPACE_MEMBER',
  'CHANGE_MEMBERSHIP_ROLE',
  'REVOKE_MEMBERSHIP',
] as const;

export interface PlatformSessionCounts {
  readonly workspaceSessions: number;
  readonly platformSessions: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => '\\' + match);
}

function cursorCondition(createdAt: typeof identityUsers.createdAt, id: typeof identityUsers.id, cursor: PlatformUserCursor | undefined) {
  if (cursor === undefined) return undefined;
  return or(lt(createdAt, cursor.at), and(eq(createdAt, cursor.at), lt(id, cursor.id)));
}

function sessionIsActive(row: PlatformIdentitySessionRow, at: Date): boolean {
  return row.revokedAt === null && row.expiresAt.getTime() > at.getTime();
}

/**
 * Drizzle adapter for platform user administration.
 *
 * It reads and updates the existing identity tables only: no second authentication system, no
 * credential writes, no deletion. Suspension uses identity_users.disabled_at (already enforced by
 * every authentication path), session revocation uses identity_sessions.revoked_at, and every
 * authority-changing action commits with its platform audit row in one transaction.
 */
export class PlatformUserStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async listUsers(input: {
    readonly query?: string | undefined;
    readonly status?: 'ACTIVE' | 'SUSPENDED' | undefined;
    readonly before?: PlatformUserCursor | undefined;
    readonly take: number;
  }): Promise<readonly PlatformUserRow[]> {
    const filters = [
      input.query ? ilike(identityUsers.email, '%' + escapeLike(input.query) + '%') : undefined,
      input.status === 'ACTIVE' ? isNull(identityUsers.disabledAt) : input.status === 'SUSPENDED' ? isNotNull(identityUsers.disabledAt) : undefined,
      cursorCondition(identityUsers.createdAt, identityUsers.id, input.before),
    ].filter(value => value !== undefined);
    const rows = await this.db
      .select({ id: identityUsers.id, email: identityUsers.email, locale: identityUsers.locale, createdAt: identityUsers.createdAt, disabledAt: identityUsers.disabledAt })
      .from(identityUsers)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(identityUsers.createdAt), desc(identityUsers.id))
      .limit(input.take);
    return rows;
  }

  async countWorkspacesByUserIds(userIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (!userIds.length) return new Map();
    const rows = await this.db
      .select({ userId: identityMemberships.userId, value: sql<number>`count(*)::int` })
      .from(identityMemberships)
      .where(and(inArray(identityMemberships.userId, [...userIds]), eq(identityMemberships.status, 'ACTIVE')))
      .groupBy(identityMemberships.userId);
    return new Map(rows.map(row => [row.userId, row.value]));
  }

  async findUser(userId: string): Promise<PlatformUserRow | undefined> {
    const [row] = await this.db
      .select({ id: identityUsers.id, email: identityUsers.email, locale: identityUsers.locale, createdAt: identityUsers.createdAt, disabledAt: identityUsers.disabledAt })
      .from(identityUsers)
      .where(eq(identityUsers.id, userId))
      .limit(1);
    return row;
  }

  async listMemberships(userId: string): Promise<readonly PlatformUserMembershipRow[]> {
    return this.db
      .select({
        workspaceId: identityMemberships.workspaceId,
        workspaceName: identityWorkspaces.name,
        role: identityMemberships.role,
        membershipStatus: identityMemberships.status,
        workspaceCreatedAt: identityWorkspaces.createdAt,
      })
      .from(identityMemberships)
      .innerJoin(identityWorkspaces, eq(identityWorkspaces.id, identityMemberships.workspaceId))
      .where(eq(identityMemberships.userId, userId))
      .orderBy(identityWorkspaces.name, identityMemberships.workspaceId);
  }

  async listSessions(userId: string): Promise<readonly PlatformIdentitySessionRow[]> {
    return this.db
      .select({
        id: identitySessions.id,
        createdAt: identitySessions.createdAt,
        expiresAt: identitySessions.expiresAt,
        revokedAt: identitySessions.revokedAt,
        lastUsedAt: identitySessions.lastUsedAt,
      })
      .from(identitySessions)
      .where(eq(identitySessions.userId, userId))
      .orderBy(desc(identitySessions.createdAt), desc(identitySessions.id))
      .limit(maximumSessionsListed);
  }

  /** Platform-administration sessions are a separate namespace; only ADMINISTRATION sees them. */
  async listPlatformSessions(userId: string): Promise<readonly PlatformIdentitySessionRow[]> {
    return this.db
      .select({
        id: platformAdminSessions.id,
        createdAt: platformAdminSessions.createdAt,
        expiresAt: platformAdminSessions.expiresAt,
        revokedAt: platformAdminSessions.revokedAt,
        lastUsedAt: platformAdminSessions.lastUsedAt,
      })
      .from(platformAdminSessions)
      .where(eq(platformAdminSessions.userId, userId))
      .orderBy(desc(platformAdminSessions.createdAt), desc(platformAdminSessions.id))
      .limit(maximumSessionsListed);
  }

  async sessionsSummary(userId: string, at: Date): Promise<{ readonly total: number; readonly active: number; readonly lastUsedAt: Date | null }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`coalesce(count(*) filter (where ${identitySessions.revokedAt} is null and ${identitySessions.expiresAt} > ${at}), 0)::int`,
        lastUsedAt: sql<Date | null>`max(${identitySessions.lastUsedAt})`,
      })
      .from(identitySessions)
      .where(eq(identitySessions.userId, userId));
    return { total: row?.total ?? 0, active: row?.active ?? 0, lastUsedAt: row?.lastUsedAt ?? null };
  }

  async platformSessionsSummary(userId: string, at: Date): Promise<{ readonly total: number; readonly active: number; readonly lastUsedAt: Date | null }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`coalesce(count(*) filter (where ${platformAdminSessions.revokedAt} is null and ${platformAdminSessions.expiresAt} > ${at}), 0)::int`,
        lastUsedAt: sql<Date | null>`max(${platformAdminSessions.lastUsedAt})`,
      })
      .from(platformAdminSessions)
      .where(eq(platformAdminSessions.userId, userId));
    return { total: row?.total ?? 0, active: row?.active ?? 0, lastUsedAt: row?.lastUsedAt ?? null };
  }

  async listPlatformRoles(userId: string): Promise<readonly PlatformRole[]> {
    const rows = await this.db
      .select({ role: platformAdminAssignments.role })
      .from(platformAdminAssignments)
      .where(and(
        eq(platformAdminAssignments.userId, userId),
        eq(platformAdminAssignments.status, 'ACTIVE'),
      ));
    const roles = new Set<PlatformRole>();
    for (const row of rows) {
      if (!isPlatformRole(row.role)) continue;
      roles.add(row.role);
    }
    return [...roles];
  }

  /**
   * Suspend a user (reversible), revoke their workspace sessions and write the audit row in one
   * transaction. Refuses to suspend the last enabled PLATFORM_ADMIN so administration cannot be
   * locked out; the lock/re-count runs inside the same transaction.
   */
  async suspendUserGuarded(input: {
    readonly userId: string;
    readonly at: Date;
    readonly buildSuccessAudit: (counts: PlatformSessionCounts) => PlatformAuditRecord;
  }): Promise<PlatformSuspendOutcome> {
    return this.db.transaction(async tx => {
      // Serializes with every other platform-administrator set mutation (see PlatformAdminStore):
      // the enabled-administrator count below is authoritative inside this transaction.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('qeynox.platform_admin_registry'))`);
      const [user] = await tx.select({ id: identityUsers.id, disabledAt: identityUsers.disabledAt })
        .from(identityUsers).where(eq(identityUsers.id, input.userId)).for('update');
      if (!user) return 'NOT_FOUND';
      if (user.disabledAt) return 'ALREADY_SUSPENDED';
      const [adminAssignment] = await tx.select({ id: platformAdminAssignments.id }).from(platformAdminAssignments)
        .where(and(
          eq(platformAdminAssignments.userId, input.userId),
          eq(platformAdminAssignments.role, 'PLATFORM_ADMIN'),
          eq(platformAdminAssignments.status, 'ACTIVE'),
        )).limit(1);
      if (adminAssignment) {
        const enabledAdmins = await tx.select({ id: platformAdminAssignments.id })
          .from(platformAdminAssignments)
          .innerJoin(identityUsers, eq(identityUsers.id, platformAdminAssignments.userId))
          .where(and(
            eq(platformAdminAssignments.role, 'PLATFORM_ADMIN'),
            eq(platformAdminAssignments.status, 'ACTIVE'),
            isNull(identityUsers.disabledAt),
          ));
        if (enabledAdmins.length <= 1) return 'LAST_ADMIN';
      }
      // A suspended account must not be the only usable owner of a workspace: that would leave
      // the organisation without any account able to administer it.
      const ownedWorkspaces = await tx.select({ workspaceId: identityMemberships.workspaceId })
        .from(identityMemberships)
        .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
        .where(and(
          eq(identityMemberships.userId, input.userId),
          eq(identityMemberships.role, 'OWNER'),
          eq(identityMemberships.status, 'ACTIVE'),
          isNull(identityUsers.disabledAt),
        ));
      for (const owned of ownedWorkspaces) {
        const [owners] = await tx.select({ value: sql<number>`count(*)::int` })
          .from(identityMemberships)
          .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
          .where(and(
            eq(identityMemberships.workspaceId, owned.workspaceId),
            eq(identityMemberships.role, 'OWNER'),
            eq(identityMemberships.status, 'ACTIVE'),
            isNull(identityUsers.disabledAt),
          ));
        if ((owners?.value ?? 0) <= 1) return 'LAST_WORKSPACE_OWNER';
      }
      await tx.update(identityUsers).set({ disabledAt: input.at }).where(and(eq(identityUsers.id, input.userId), isNull(identityUsers.disabledAt)));
      const workspaceSessions = await tx.update(identitySessions).set({ revokedAt: input.at })
        .where(and(eq(identitySessions.userId, input.userId), isNull(identitySessions.revokedAt)))
        .returning({ id: identitySessions.id });
      const platformSessions = await tx.update(platformAdminSessions).set({ revokedAt: input.at })
        .where(and(eq(platformAdminSessions.userId, input.userId), isNull(platformAdminSessions.revokedAt)))
        .returning({ id: platformAdminSessions.id });
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildSuccessAudit({
        workspaceSessions: workspaceSessions.length,
        platformSessions: platformSessions.length,
      })));
      return 'SUSPENDED';
    });
  }

  async reactivateUserWithAudit(input: { readonly userId: string; readonly at: Date; readonly successAudit: PlatformAuditRecord }): Promise<PlatformReactivateOutcome> {
    return this.db.transaction(async tx => {
      const [user] = await tx.select({ id: identityUsers.id, disabledAt: identityUsers.disabledAt })
        .from(identityUsers).where(eq(identityUsers.id, input.userId)).for('update');
      if (!user) return 'NOT_FOUND';
      if (!user.disabledAt) return 'NOT_SUSPENDED';
      await tx.update(identityUsers).set({ disabledAt: null }).where(eq(identityUsers.id, input.userId));
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.successAudit));
      return 'REACTIVATED';
    });
  }

  async revokeUserSessionsWithAudit(input: {
    readonly userId: string;
    readonly at: Date;
    readonly buildSuccessAudit: (counts: PlatformSessionCounts) => PlatformAuditRecord;
  }): Promise<{
    readonly outcome: PlatformSessionRevokeOutcome;
    readonly revoked: number;
    readonly revokedWorkspaceSessions: number;
    readonly revokedPlatformSessions: number;
  }> {
    return this.db.transaction(async tx => {
      const [user] = await tx.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.id, input.userId)).limit(1);
      if (!user) return { outcome: 'NOT_FOUND', revoked: 0, revokedWorkspaceSessions: 0, revokedPlatformSessions: 0 };
      const workspaceSessions = await tx.update(identitySessions).set({ revokedAt: input.at })
        .where(and(eq(identitySessions.userId, input.userId), isNull(identitySessions.revokedAt)))
        .returning({ id: identitySessions.id });
      const platformSessions = await tx.update(platformAdminSessions).set({ revokedAt: input.at })
        .where(and(eq(platformAdminSessions.userId, input.userId), isNull(platformAdminSessions.revokedAt)))
        .returning({ id: platformAdminSessions.id });
      const counts: PlatformSessionCounts = {
        workspaceSessions: workspaceSessions.length,
        platformSessions: platformSessions.length,
      };
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildSuccessAudit(counts)));
      return { outcome: 'REVOKED', revoked: counts.workspaceSessions + counts.platformSessions, ...counts, revokedWorkspaceSessions: counts.workspaceSessions, revokedPlatformSessions: counts.platformSessions };
    });
  }

  /**
   * Merged, newest-first account timeline: identity events (register/login) plus platform actions
   * targeting the account (suspend/reactivate/session revocation). Returns up to 2*(limit+1) rows;
   * the application service applies the page slice and cursor.
   */
  async listActivity(userId: string, before: PlatformUserCursor | undefined, limit: number): Promise<readonly PlatformUserActivityRow[]> {
    const take = limit + 1;
    const [identityRows, platformRows] = await Promise.all([
      this.db.select({
        id: identityAudit.id,
        action: identityAudit.action,
        outcome: identityAudit.outcome,
        happenedAt: identityAudit.happenedAt,
        userId: identityAudit.userId,
      }).from(identityAudit)
        .where(and(
          eq(identityAudit.userId, userId),
          before === undefined ? undefined : or(lt(identityAudit.happenedAt, before.at), and(eq(identityAudit.happenedAt, before.at), lt(identityAudit.id, before.id))),
        ))
        .orderBy(desc(identityAudit.happenedAt), desc(identityAudit.id))
        .limit(take),
      this.db.select({
        id: platformAdminAudit.id,
        action: platformAdminAudit.action,
        outcome: platformAdminAudit.outcome,
        happenedAt: platformAdminAudit.happenedAt,
        actorUserId: platformAdminAudit.actorUserId,
        reason: platformAdminAudit.reason,
        permission: platformAdminAudit.permission,
      }).from(platformAdminAudit)
        .where(and(
          eq(platformAdminAudit.targetType, 'IDENTITY_ACCOUNT'),
          eq(platformAdminAudit.targetId, userId),
          inArray(platformAdminAudit.action, [...accountLifecycleActions]),
          before === undefined ? undefined : or(lt(platformAdminAudit.happenedAt, before.at), and(eq(platformAdminAudit.happenedAt, before.at), lt(platformAdminAudit.id, before.id))),
        ))
        .orderBy(desc(platformAdminAudit.happenedAt), desc(platformAdminAudit.id))
        .limit(take),
    ]);
    const merged: PlatformUserActivityRow[] = [
      ...identityRows.map(row => ({
        source: 'IDENTITY' as const, id: row.id, action: row.action, outcome: row.outcome,
        happenedAt: row.happenedAt, actorUserId: row.userId, reason: null, permission: null,
      })),
      ...platformRows.map(row => ({
        source: 'PLATFORM' as const, id: row.id, action: row.action, outcome: row.outcome,
        happenedAt: row.happenedAt, actorUserId: row.actorUserId, reason: row.reason, permission: row.permission,
      })),
    ];
    merged.sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return merged;
  }
}
