import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import type { QeyNoxDatabase } from './database';
import { isWorkspaceRole, type MembershipStatus, type WorkspaceRole } from '@qeynox/domain';
import { identityAudit, identityMemberships, identitySessions, identityUsers, identityWorkspaces } from './identity-schema';
import { platformAdminAudit } from './platform-admin-schema';
import { platformAuditValues, type PlatformAuditRecord } from './platform-admin-store';

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly creatorEmail: string | null;
  readonly createdAt: Date;
}
export interface WorkspaceListRow extends WorkspaceRow {
  readonly activeMembers: number;
  readonly owners: number;
  readonly invited: number;
}
export interface WorkspaceStats {
  readonly activeMembers: number;
  readonly owners: number;
  readonly admins: number;
  readonly members: number;
  readonly invited: number;
}
export interface WorkspaceMemberRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly invitedBy: string | null;
  readonly invitedAt: Date | null;
  readonly joinedAt: Date | null;
  readonly updatedAt: Date | null;
  readonly userDisabledAt: Date | null;
}
export interface WorkspaceMemberCursor { readonly email: string; readonly id: string }
export interface WorkspaceInvitationRow {
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: string;
  readonly invitedBy: string | null;
  readonly invitedAt: Date | null;
}
export interface WorkspaceUserSummary { readonly userId: string; readonly email: string; readonly disabledAt: Date | null }

export type InviteOutcome = 'INVITED' | 'REINVITED' | 'ALREADY_MEMBER' | 'ALREADY_INVITED' | 'USER_NOT_FOUND';
export type RoleChangeOutcome = 'CHANGED' | 'UNCHANGED' | 'NOT_FOUND' | 'INVALID_STATE' | 'LAST_OWNER';
export type MembershipRevokeOutcome = 'REVOKED' | 'NOT_FOUND' | 'INVALID_STATE' | 'LAST_OWNER';
export type InvitationResponseOutcome = 'ACCEPTED' | 'DECLINED' | 'NOT_FOUND' | 'INVALID_STATE';

const maximumMembersPerPage = 100;
const advisoryLockKey = 'qeynox.workspace_owners';

const memberSelection = {
  membershipId: identityMemberships.id,
  userId: identityMemberships.userId,
  email: identityUsers.email,
  role: identityMemberships.role,
  status: identityMemberships.status,
  invitedBy: identityMemberships.invitedBy,
  invitedAt: identityMemberships.invitedAt,
  joinedAt: identityMemberships.joinedAt,
  updatedAt: identityMemberships.updatedAt,
  userDisabledAt: identityUsers.disabledAt,
};

/**
 * Drizzle adapter for workspace (organisation) administration over the existing identity tables.
 * identity_workspaces/identity_memberships remain the single organisation entity. Access-changing
 * mutations commit together with their platform audit row and take a per-workspace advisory
 * transaction lock so concurrent role changes/revocations cannot remove the last owner.
 */
export class WorkspaceStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async listWorkspaces(input: {
    readonly query?: string | undefined;
    readonly before?: { readonly at: Date; readonly id: string } | undefined;
    readonly take: number;
  }): Promise<readonly WorkspaceListRow[]> {
    const filters = [
      input.query ? ilike(identityWorkspaces.name, '%' + input.query.replace(/[\\%_]/g, match => '\\' + match) + '%') : undefined,
      input.before === undefined ? undefined : or(
        sql`date_trunc('milliseconds', ${identityWorkspaces.createdAt}) < ${input.before.at}`,
        and(
          sql`date_trunc('milliseconds', ${identityWorkspaces.createdAt}) = ${input.before.at}`,
          sql`${identityWorkspaces.id} < ${input.before.id}`,
        ),
      ),
    ].filter(value => value !== undefined);
    return this.db.select({
      id: identityWorkspaces.id,
      name: identityWorkspaces.name,
      createdBy: identityWorkspaces.createdBy,
      creatorEmail: identityUsers.email,
      createdAt: identityWorkspaces.createdAt,
      activeMembers: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'ACTIVE'), 0)::int`,
      owners: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'ACTIVE' and ${identityMemberships.role} = 'OWNER'), 0)::int`,
      invited: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'INVITED'), 0)::int`,
    })
      .from(identityWorkspaces)
      .leftJoin(identityMemberships, eq(identityMemberships.workspaceId, identityWorkspaces.id))
      .leftJoin(identityUsers, eq(identityUsers.id, identityWorkspaces.createdBy))
      .where(filters.length ? and(...filters) : undefined)
      .groupBy(identityWorkspaces.id, identityWorkspaces.name, identityWorkspaces.createdBy, identityUsers.email, identityWorkspaces.createdAt)
      .orderBy(desc(identityWorkspaces.createdAt), desc(identityWorkspaces.id))
      .limit(input.take);
  }

  async findWorkspace(workspaceId: string): Promise<WorkspaceRow | undefined> {
    const [row] = await this.db.select({
      id: identityWorkspaces.id,
      name: identityWorkspaces.name,
      createdBy: identityWorkspaces.createdBy,
      creatorEmail: identityUsers.email,
      createdAt: identityWorkspaces.createdAt,
    })
      .from(identityWorkspaces)
      .leftJoin(identityUsers, eq(identityUsers.id, identityWorkspaces.createdBy))
      .where(eq(identityWorkspaces.id, workspaceId))
      .limit(1);
    return row;
  }

  async workspaceStats(workspaceId: string): Promise<WorkspaceStats> {
    const [row] = await this.db.select({
      activeMembers: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'ACTIVE'), 0)::int`,
      owners: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'ACTIVE' and ${identityMemberships.role} = 'OWNER'), 0)::int`,
      admins: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'ACTIVE' and ${identityMemberships.role} = 'ADMIN'), 0)::int`,
      members: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'ACTIVE' and ${identityMemberships.role} = 'MEMBER'), 0)::int`,
      invited: sql<number>`coalesce(count(*) filter (where ${identityMemberships.status} = 'INVITED'), 0)::int`,
    }).from(identityMemberships).where(eq(identityMemberships.workspaceId, workspaceId));
    return {
      activeMembers: row?.activeMembers ?? 0, owners: row?.owners ?? 0, admins: row?.admins ?? 0,
      members: row?.members ?? 0, invited: row?.invited ?? 0,
    };
  }

  async listMembers(workspaceId: string, input: {
    readonly role?: WorkspaceRole | undefined;
    readonly status?: MembershipStatus | undefined;
    readonly before?: WorkspaceMemberCursor | undefined;
    readonly take: number;
  }): Promise<readonly WorkspaceMemberRow[]> {
    const filters = [
      eq(identityMemberships.workspaceId, workspaceId),
      input.role ? eq(identityMemberships.role, input.role) : undefined,
      input.status ? eq(identityMemberships.status, input.status) : undefined,
      input.before === undefined ? undefined : or(
        gt(identityUsers.email, input.before.email),
        and(eq(identityUsers.email, input.before.email), gt(identityMemberships.id, input.before.id)),
      ),
    ].filter(value => value !== undefined);
    return this.db.select(memberSelection)
      .from(identityMemberships)
      .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
      .where(and(...filters))
      .orderBy(asc(identityUsers.email), asc(identityMemberships.id))
      .limit(Math.min(input.take, maximumMembersPerPage + 1));
  }

  async findMembership(workspaceId: string, membershipId: string): Promise<WorkspaceMemberRow | undefined> {
    const [row] = await this.db.select(memberSelection)
      .from(identityMemberships)
      .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
      .where(and(eq(identityMemberships.workspaceId, workspaceId), eq(identityMemberships.id, membershipId)))
      .limit(1);
    return row;
  }

  async findUserByEmail(email: string): Promise<WorkspaceUserSummary | undefined> {
    const [row] = await this.db.select({ userId: identityUsers.id, email: identityUsers.email, disabledAt: identityUsers.disabledAt })
      .from(identityUsers).where(eq(identityUsers.email, email)).limit(1);
    return row;
  }

  async findUser(userId: string): Promise<WorkspaceUserSummary | undefined> {
    const [row] = await this.db.select({ userId: identityUsers.id, email: identityUsers.email, disabledAt: identityUsers.disabledAt })
      .from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    return row;
  }

  async listUserInvitations(userId: string): Promise<readonly WorkspaceInvitationRow[]> {
    return this.db.select({
      membershipId: identityMemberships.id,
      workspaceId: identityMemberships.workspaceId,
      workspaceName: identityWorkspaces.name,
      role: identityMemberships.role,
      invitedBy: identityMemberships.invitedBy,
      invitedAt: identityMemberships.invitedAt,
    })
      .from(identityMemberships)
      .innerJoin(identityWorkspaces, eq(identityWorkspaces.id, identityMemberships.workspaceId))
      .where(and(eq(identityMemberships.userId, userId), eq(identityMemberships.status, 'INVITED')))
      .orderBy(desc(identityMemberships.invitedAt), desc(identityMemberships.id));
  }

  async listActiveMemberships(userId: string): Promise<readonly { readonly workspaceId: string; readonly name: string; readonly role: string }[]> {
    return this.db.select({
      workspaceId: identityWorkspaces.id,
      name: identityWorkspaces.name,
      role: identityMemberships.role,
    })
      .from(identityMemberships)
      .innerJoin(identityWorkspaces, eq(identityWorkspaces.id, identityMemberships.workspaceId))
      .where(and(eq(identityMemberships.userId, userId), eq(identityMemberships.status, 'ACTIVE')))
      .orderBy(asc(identityWorkspaces.name), asc(identityWorkspaces.id));
  }

  async findActiveMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | undefined> {
    const [row] = await this.db.select(memberSelection)
      .from(identityMemberships)
      .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
      .where(and(eq(identityMemberships.userId, userId), eq(identityMemberships.workspaceId, workspaceId), eq(identityMemberships.status, 'ACTIVE')))
      .limit(1);
    return row;
  }

  async inviteUser(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: WorkspaceRole;
    readonly invitedBy: string;
    readonly at: Date;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly buildAudit: (membershipId: string) => PlatformAuditRecord;
  }): Promise<{ readonly outcome: InviteOutcome; readonly membershipId: string }> {
    try {
      return await this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey}), hashtext(${input.workspaceId}))`);
      const [existing] = await tx.select().from(identityMemberships)
        .where(and(eq(identityMemberships.userId, input.userId), eq(identityMemberships.workspaceId, input.workspaceId)))
        .for('update');
      if (existing?.status === 'ACTIVE') return { outcome: 'ALREADY_MEMBER', membershipId: existing.id };
      if (existing?.status === 'INVITED') return { outcome: 'ALREADY_INVITED', membershipId: existing.id };
      if (existing) {
        await tx.update(identityMemberships).set({
          role: input.role, status: 'INVITED', invitedBy: input.invitedBy, invitedAt: input.at,
          joinedAt: null, updatedAt: input.at,
          invitationTokenHash: input.tokenHash, invitationExpiresAt: input.tokenExpiresAt,
        }).where(eq(identityMemberships.id, existing.id));
        await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildAudit(existing.id)));
        return { outcome: 'REINVITED', membershipId: existing.id };
      }
      const membershipId = randomUUID();
      await tx.insert(identityMemberships).values({
        id: membershipId, userId: input.userId, workspaceId: input.workspaceId, role: input.role, status: 'INVITED',
        invitedBy: input.invitedBy, invitedAt: input.at, joinedAt: null, updatedAt: input.at,
        invitationTokenHash: input.tokenHash, invitationExpiresAt: input.tokenExpiresAt,
      });
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildAudit(membershipId)));
      return { outcome: 'INVITED', membershipId };
      });
    } catch (error: unknown) {
      // Concurrent first invitations can race on the (user, workspace) unique constraint.
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') {
        const [concurrent] = await this.db.select({ id: identityMemberships.id }).from(identityMemberships)
          .where(and(eq(identityMemberships.userId, input.userId), eq(identityMemberships.workspaceId, input.workspaceId)))
          .limit(1);
        if (concurrent) return { outcome: 'ALREADY_INVITED', membershipId: concurrent.id };
        return { outcome: 'ALREADY_MEMBER', membershipId: '' };
      }
      throw error;
    }
  }

  async changeRole(input: {
    readonly workspaceId: string;
    readonly membershipId: string;
    readonly role: WorkspaceRole;
    readonly at: Date;
    readonly buildAudit: (membership: WorkspaceMemberRow, previousRole: string) => PlatformAuditRecord;
  }): Promise<RoleChangeOutcome> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey}), hashtext(${input.workspaceId}))`);
      const [membership] = await tx.select().from(identityMemberships)
        .where(and(eq(identityMemberships.id, input.membershipId), eq(identityMemberships.workspaceId, input.workspaceId)))
        .for('update');
      if (!membership) return 'NOT_FOUND';
      if (membership.status !== 'ACTIVE' || !isWorkspaceRole(membership.role)) return 'INVALID_STATE';
      const previousRole = membership.role;
      if (membership.role === input.role) return 'UNCHANGED';
      if (membership.role === 'OWNER') {
        const [owners] = await tx.select({ value: sql<number>`count(*)::int` })
          .from(identityMemberships)
          .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
          .where(and(
            eq(identityMemberships.workspaceId, input.workspaceId),
            eq(identityMemberships.role, 'OWNER'),
            eq(identityMemberships.status, 'ACTIVE'),
            isNull(identityUsers.disabledAt),
          ));
        if ((owners?.value ?? 0) <= 1) return 'LAST_OWNER';
      }
      await tx.update(identityMemberships).set({ role: input.role, updatedAt: input.at }).where(eq(identityMemberships.id, input.membershipId));
      const [row] = await tx.select(memberSelection)
        .from(identityMemberships)
        .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
        .where(eq(identityMemberships.id, input.membershipId))
        .limit(1);
      if (!row) return 'NOT_FOUND';
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildAudit(row, previousRole)));
      return 'CHANGED';
    });
  }

  async revokeMember(input: {
    readonly workspaceId: string;
    readonly membershipId: string;
    readonly at: Date;
    readonly buildAudit: (membership: WorkspaceMemberRow) => PlatformAuditRecord;
  }): Promise<MembershipRevokeOutcome> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKey}), hashtext(${input.workspaceId}))`);
      const [membership] = await tx.select().from(identityMemberships)
        .where(and(eq(identityMemberships.id, input.membershipId), eq(identityMemberships.workspaceId, input.workspaceId)))
        .for('update');
      if (!membership) return 'NOT_FOUND';
      if (membership.status !== 'ACTIVE' && membership.status !== 'INVITED') return 'INVALID_STATE';
      if (membership.status === 'ACTIVE' && membership.role === 'OWNER') {
        const [owners] = await tx.select({ value: sql<number>`count(*)::int` })
          .from(identityMemberships)
          .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
          .where(and(
            eq(identityMemberships.workspaceId, input.workspaceId),
            eq(identityMemberships.role, 'OWNER'),
            eq(identityMemberships.status, 'ACTIVE'),
            isNull(identityUsers.disabledAt),
          ));
        if ((owners?.value ?? 0) <= 1) return 'LAST_OWNER';
      }
      const wasActive = membership.status === 'ACTIVE';
      await tx.update(identityMemberships).set({ status: 'REVOKED', updatedAt: input.at }).where(eq(identityMemberships.id, input.membershipId));
      if (wasActive) {
        const [remaining] = await tx.select({ value: sql<number>`count(*)::int` }).from(identityMemberships)
          .where(and(eq(identityMemberships.userId, membership.userId), eq(identityMemberships.status, 'ACTIVE')));
        if ((remaining?.value ?? 0) === 0) {
          await tx.execute(sql`UPDATE identity_sessions SET revoked_at = ${input.at} WHERE user_id = ${membership.userId} AND revoked_at IS NULL`);
        }
      }
      const [row] = await tx.select(memberSelection)
        .from(identityMemberships)
        .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
        .where(eq(identityMemberships.id, input.membershipId))
        .limit(1);
      if (!row) return 'NOT_FOUND';
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildAudit(row)));
      return 'REVOKED';
    });
  }

  async respondToInvitation(input: {
    readonly userId: string;
    readonly membershipId: string;
    readonly action: 'ACCEPT' | 'DECLINE';
    readonly at: Date;
  }): Promise<InvitationResponseOutcome> {
    return this.db.transaction(async tx => {
      const [membership] = await tx.select().from(identityMemberships)
        .where(and(eq(identityMemberships.id, input.membershipId), eq(identityMemberships.userId, input.userId)))
        .for('update');
      if (!membership) return 'NOT_FOUND';
      if (membership.status !== 'INVITED') return 'INVALID_STATE';
      const status = input.action === 'ACCEPT' ? 'ACTIVE' : 'DECLINED';
      await tx.update(identityMemberships).set({
        status,
        joinedAt: input.action === 'ACCEPT' ? input.at : membership.joinedAt,
        updatedAt: input.at,
        invitationTokenHash: null,
        invitationExpiresAt: null,
      }).where(eq(identityMemberships.id, input.membershipId));
      await tx.insert(identityAudit).values({
        id: randomUUID(), userId: input.userId, workspaceId: membership.workspaceId,
        action: input.action === 'ACCEPT' ? 'INVITATION_ACCEPTED' : 'INVITATION_DECLINED', outcome: 'SUCCESS',
      });
      return input.action === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
    });
  }

  /**
   * Token-based invitation response for accounts that currently hold no ACTIVE membership (they
   * cannot open a workspace session). The token is single-use, hashed at rest, and expires.
   */
  async respondToInvitationToken(input: {
    readonly tokenHash: string;
    readonly action: 'ACCEPT' | 'DECLINE';
    readonly at: Date;
  }): Promise<{ readonly outcome: InvitationResponseOutcome; readonly membershipId: string | null; readonly workspaceId: string | null; readonly userId: string | null }> {
    return this.db.transaction(async tx => {
      const [membership] = await tx.select().from(identityMemberships)
        .where(and(eq(identityMemberships.invitationTokenHash, input.tokenHash), eq(identityMemberships.status, 'INVITED')))
        .for('update');
      if (!membership) return { outcome: 'NOT_FOUND', membershipId: null, workspaceId: null, userId: null };
      if (membership.invitationExpiresAt !== null && membership.invitationExpiresAt.getTime() <= input.at.getTime()) {
        return { outcome: 'INVALID_STATE', membershipId: membership.id, workspaceId: membership.workspaceId, userId: membership.userId };
      }
      const status = input.action === 'ACCEPT' ? 'ACTIVE' : 'DECLINED';
      await tx.update(identityMemberships).set({
        status,
        joinedAt: input.action === 'ACCEPT' ? input.at : membership.joinedAt,
        updatedAt: input.at,
        invitationTokenHash: null,
        invitationExpiresAt: null,
      }).where(eq(identityMemberships.id, membership.id));
      await tx.insert(identityAudit).values({
        id: randomUUID(), userId: membership.userId, workspaceId: membership.workspaceId,
        action: input.action === 'ACCEPT' ? 'INVITATION_ACCEPTED' : 'INVITATION_DECLINED', outcome: 'SUCCESS',
      });
      return { outcome: input.action === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED', membershipId: membership.id, workspaceId: membership.workspaceId, userId: membership.userId };
    });
  }
}