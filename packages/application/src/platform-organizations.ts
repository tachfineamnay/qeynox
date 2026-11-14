import { createHash, randomBytes } from 'node:crypto';
import {
  DomainError,
  isMembershipStatus,
  isWorkspaceRole,
  type PlatformPermission,
  type PlatformPrincipal,
  type WorkspaceRole,
} from '@qeynox/domain';
import type {
  InviteOutcome,
  MembershipRevokeOutcome,
  PlatformAuditRecord,
  RoleChangeOutcome,
  WorkspaceInvitationRow,
  WorkspaceListRow,
  WorkspaceMemberCursor,
  WorkspaceMemberRow,
  WorkspaceRow,
  WorkspaceStats,
  WorkspaceUserSummary,
} from '@qeynox/persistence';
import { PlatformAdminService } from './platform-admin';
import { decodeMemberCursor, decodePageCursor, encodeMemberCursor, encodePageCursor } from './pagination';

const readPermissions: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];
const defaultLimit = 25;
const maximumLimit = 100;
const minimumReasonLength = 10;
const maximumReasonLength = 500;

export interface PlatformOrganizationRepository {
  listWorkspaces(input: {
    readonly query?: string | undefined;
    readonly before?: { readonly at: Date; readonly id: string } | undefined;
    readonly take: number;
  }): Promise<readonly WorkspaceListRow[]>;
  findWorkspace(workspaceId: string): Promise<WorkspaceRow | undefined>;
  workspaceStats(workspaceId: string): Promise<WorkspaceStats>;
  listMembers(workspaceId: string, input: {
    readonly role?: WorkspaceRole | undefined;
    readonly status?: 'ACTIVE' | 'INVITED' | 'REVOKED' | 'DECLINED' | undefined;
    readonly before?: WorkspaceMemberCursor | undefined;
    readonly take: number;
  }): Promise<readonly WorkspaceMemberRow[]>;
  findMembership(workspaceId: string, membershipId: string): Promise<WorkspaceMemberRow | undefined>;
  findUserByEmail(email: string): Promise<WorkspaceUserSummary | undefined>;
  inviteUser(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: WorkspaceRole;
    readonly invitedBy: string;
    readonly at: Date;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly buildAudit: (membershipId: string) => PlatformAuditRecord;
  }): Promise<{ readonly outcome: InviteOutcome; readonly membershipId: string }>;
  changeRole(input: {
    readonly workspaceId: string;
    readonly membershipId: string;
    readonly role: WorkspaceRole;
    readonly at: Date;
    readonly buildAudit: (membership: WorkspaceMemberRow, previousRole: string) => PlatformAuditRecord;
  }): Promise<RoleChangeOutcome>;
  revokeMember(input: {
    readonly workspaceId: string;
    readonly membershipId: string;
    readonly at: Date;
    readonly buildAudit: (membership: WorkspaceMemberRow) => PlatformAuditRecord;
  }): Promise<MembershipRevokeOutcome>;
}

export interface WorkspaceSummaryView {
  readonly workspaceId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly creatorEmail: string | null;
  readonly createdAt: string;
  readonly activeMembers: number;
  readonly owners: number;
  readonly invited: number;
}
export interface WorkspacePage { readonly items: readonly WorkspaceSummaryView[]; readonly nextCursor: string | null; readonly limit: number }
export interface WorkspaceDetailView extends WorkspaceSummaryView { readonly stats: WorkspaceStats }
export interface PlatformMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly status: string;
  readonly invitedBy: string | null;
  readonly invitedAt: string | null;
  readonly joinedAt: string | null;
  readonly updatedAt: string | null;
  readonly userDisabledAt: string | null;
}
export interface MemberPage { readonly items: readonly PlatformMemberView[]; readonly nextCursor: string | null; readonly limit: number }
export interface InvitationResultView {
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly status: string;
  readonly invitedAt: string | null;
  /** Single-use acceptance token, returned once to the authenticated administrator (never e-mailed). */
  readonly invitationToken: string;
  readonly invitationExpiresAt: string;
  /** No e-mail is sent: delivery is manual until a reviewed transport is configured. */
  readonly delivery: { readonly email: 'BLOCKED'; readonly reason: string };
}
export interface RoleChangeView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly previousRole: string;
  readonly status: string;
  readonly updatedAt: string | null;
  readonly changed: boolean;
}
export interface RevocationView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly status: string;
  readonly updatedAt: string | null;
}

export interface PlatformOrganizationsServiceOptions { readonly now?: () => Date }

function requiredReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < minimumReasonLength || reason.length > maximumReasonLength) {
    throw new DomainError('INVALID_INPUT', 'A justification of ' + minimumReasonLength + '-' + maximumReasonLength + ' characters is required');
  }
  return reason;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return defaultLimit;
  return Math.min(value, maximumLimit);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function memberView(row: WorkspaceMemberRow): PlatformMemberView {
  if (!isWorkspaceRole(row.role)) throw new DomainError('INVALID_STATE', 'Stored workspace role is unknown');
  return {
    membershipId: row.membershipId, userId: row.userId, email: row.email, role: row.role, status: row.status,
    invitedBy: row.invitedBy, invitedAt: iso(row.invitedAt), joinedAt: iso(row.joinedAt),
    updatedAt: iso(row.updatedAt), userDisabledAt: iso(row.userDisabledAt),
  };
}

function workspaceView(row: WorkspaceListRow): WorkspaceSummaryView {
  return {
    workspaceId: row.id, name: row.name, createdBy: row.createdBy, creatorEmail: row.creatorEmail,
    createdAt: row.createdAt.toISOString(), activeMembers: row.activeMembers, owners: row.owners, invited: row.invited,
  };
}

function roleView(row: WorkspaceMemberRow, changed: boolean, previousRole: string): RoleChangeView {
  if (!isWorkspaceRole(row.role)) throw new DomainError('INVALID_STATE', 'Stored workspace role is unknown');
  return {
    membershipId: row.membershipId, userId: row.userId, email: row.email, role: row.role, previousRole,
    status: row.status, updatedAt: iso(row.updatedAt), changed,
  };
}

/**
 * Platform administration of workspaces/organisations over identity_workspaces and
 * identity_memberships (no second organisation entity).
 *
 * Roles are OWNER / ADMIN / MEMBER. Invitations target existing identity accounts only (no e-mail
 * transport exists, so delivery is explicitly manual and no message is claimed); the last ACTIVE
 * OWNER can never be demoted or revoked; removal/turnover commits with an audit row. Workspace
 * sessions are re-derived from membership on every request, and a member left with zero ACTIVE
 * memberships has their sessions revoked in the revocation transaction.
 */
export class PlatformOrganizationsService {
  private readonly now: () => Date;
  constructor(
    private readonly repository: PlatformOrganizationRepository,
    private readonly platform: PlatformAdminService,
    options: PlatformOrganizationsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(principal: PlatformPrincipal, input: { query?: string | undefined; limit?: number | undefined; cursor?: string | undefined }): Promise<WorkspacePage> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'LIST_WORKSPACES', targetType: 'WORKSPACE' });
    const limit = boundedLimit(input.limit);
    let before: { at: Date; id: string } | undefined;
    if (input.cursor !== undefined) {
      try {
        before = decodePageCursor(input.cursor);
      } catch (error: unknown) {
        await this.denied(principal, 'LIST_WORKSPACES', null, 'INVALID_CURSOR');
        throw error;
      }
    }
    const rows = await this.repository.listWorkspaces({ query: input.query?.trim() || undefined, before, take: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodePageCursor(last.createdAt, last.id) : null;
    await this.platform.recordAudit({
      actor: principal, targetType: 'WORKSPACE', action: 'LIST_WORKSPACES', permission: readPermissions.join('|'),
      outcome: 'SUCCESS', detail: { query: input.query?.trim() || null, limit, returned: page.length },
    });
    return { items: page.map(workspaceView), nextCursor, limit };
  }

  async get(principal: PlatformPrincipal, workspaceId: string): Promise<WorkspaceDetailView> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'READ_WORKSPACE', targetType: 'WORKSPACE', targetId: workspaceId });
    const workspace = await this.repository.findWorkspace(workspaceId);
    if (!workspace) {
      await this.denied(principal, 'READ_WORKSPACE', workspaceId, 'WORKSPACE_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Workspace not found');
    }
    const stats = await this.repository.workspaceStats(workspaceId);
    await this.platform.recordAudit({
      actor: principal, targetType: 'WORKSPACE', targetId: workspaceId, action: 'READ_WORKSPACE',
      permission: readPermissions.join('|'), outcome: 'SUCCESS',
    });
    return {
      workspaceId: workspace.id, name: workspace.name, createdBy: workspace.createdBy,
      creatorEmail: workspace.creatorEmail, createdAt: workspace.createdAt.toISOString(),
      activeMembers: stats.activeMembers, owners: stats.owners, invited: stats.invited, stats,
    };
  }

  async listMembers(principal: PlatformPrincipal, workspaceId: string, input: {
    role?: string | undefined; status?: string | undefined; limit?: number | undefined; cursor?: string | undefined;
  }): Promise<MemberPage> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'LIST_WORKSPACE_MEMBERS', targetType: 'WORKSPACE', targetId: workspaceId });
    const workspace = await this.repository.findWorkspace(workspaceId);
    if (!workspace) {
      await this.denied(principal, 'LIST_WORKSPACE_MEMBERS', workspaceId, 'WORKSPACE_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Workspace not found');
    }
    const role = input.role === undefined ? undefined : (isWorkspaceRole(input.role) ? input.role : (() => { throw new DomainError('INVALID_INPUT', 'Unknown workspace role'); })());
    let status: 'ACTIVE' | 'INVITED' | 'REVOKED' | 'DECLINED' | undefined;
    if (input.status !== undefined) {
      if (!isMembershipStatus(input.status)) throw new DomainError('INVALID_INPUT', 'Unknown membership status');
      status = input.status;
    }
    const limit = boundedLimit(input.limit);
    let before: WorkspaceMemberCursor | undefined;
    if (input.cursor !== undefined) {
      try {
        before = decodeMemberCursor(input.cursor);
      } catch (error: unknown) {
        await this.denied(principal, 'LIST_WORKSPACE_MEMBERS', workspaceId, 'INVALID_CURSOR');
        throw error;
      }
    }
    const rows = await this.repository.listMembers(workspaceId, { role, status, before, take: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodeMemberCursor(last.email, last.membershipId) : null;
    await this.platform.recordAudit({
      actor: principal, targetType: 'WORKSPACE', targetId: workspaceId, action: 'LIST_WORKSPACE_MEMBERS',
      permission: readPermissions.join('|'), outcome: 'SUCCESS', detail: { role: role ?? null, status: status ?? null, returned: page.length },
    });
    return { items: page.map(memberView), nextCursor, limit };
  }

  async invite(principal: PlatformPrincipal, workspaceId: string, input: { email: string; role: string; reason: string }): Promise<InvitationResultView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'INVITE_WORKSPACE_MEMBER', targetType: 'WORKSPACE', targetId: workspaceId });
    const workspace = await this.repository.findWorkspace(workspaceId);
    if (!workspace) {
      await this.denied(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, 'WORKSPACE_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Workspace not found');
    }
    if (!isWorkspaceRole(input.role)) {
      await this.denied(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, 'INVALID_WORKSPACE_ROLE');
      throw new DomainError('INVALID_INPUT', 'Unknown workspace role');
    }
    const reason = await this.validatedReason(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, input.reason);
    const email = input.email.trim().toLowerCase();
    const user = await this.repository.findUserByEmail(email);
    if (!user) {
      await this.denied(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, 'IDENTITY_ACCOUNT_REQUIRED', { email });
      throw new DomainError('NOT_FOUND', 'An existing identity account is required: e-mail onboarding is blocked (no transport configured)');
    }
    if (user.disabledAt) {
      await this.denied(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, 'ACCOUNT_DISABLED', { email });
      throw new DomainError('DENIED', 'Identity account is disabled');
    }
    const at = this.now();
    const invitationToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(invitationToken).digest('hex');
    const tokenExpiresAt = new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await this.repository.inviteUser({
      workspaceId, userId: user.userId, role: input.role, invitedBy: principal.userId, at,
      tokenHash, tokenExpiresAt,
      buildAudit: membershipId => this.platform.buildAuditRecord({
        actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: user.userId, action: 'INVITE_WORKSPACE_MEMBER',
        permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
        detail: { workspaceId, membershipId, role: input.role, justification: reason, emailDelivery: 'BLOCKED' },
      }),
    });
    if (invitation.outcome === 'ALREADY_MEMBER') {
      await this.denied(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, 'ALREADY_MEMBER', { userId: user.userId });
      throw new DomainError('CONFLICT', 'Identity account is already an active workspace member');
    }
    if (invitation.outcome === 'ALREADY_INVITED') {
      await this.denied(principal, 'INVITE_WORKSPACE_MEMBER', workspaceId, 'ALREADY_INVITED', { userId: user.userId });
      throw new DomainError('CONFLICT', 'An invitation is already pending for this account');
    }
    return {
      membershipId: invitation.membershipId,
      workspaceId, userId: user.userId, role: input.role, status: 'INVITED',
      invitedAt: at.toISOString(),
      invitationToken,
      invitationExpiresAt: tokenExpiresAt.toISOString(),
      delivery: { email: 'BLOCKED', reason: 'EMAIL_PROVIDER_NOT_CONFIGURED' },
    };
  }

  async changeRole(principal: PlatformPrincipal, workspaceId: string, membershipId: string, input: { role: string; reason: string }): Promise<RoleChangeView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'CHANGE_MEMBERSHIP_ROLE', targetType: 'WORKSPACE', targetId: workspaceId });
    const workspace = await this.repository.findWorkspace(workspaceId);
    if (!workspace) {
      await this.denied(principal, 'CHANGE_MEMBERSHIP_ROLE', workspaceId, 'WORKSPACE_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Workspace not found');
    }
    if (!isWorkspaceRole(input.role)) {
      await this.denied(principal, 'CHANGE_MEMBERSHIP_ROLE', workspaceId, 'INVALID_WORKSPACE_ROLE');
      throw new DomainError('INVALID_INPUT', 'Unknown workspace role');
    }
    const reason = await this.validatedReason(principal, 'CHANGE_MEMBERSHIP_ROLE', workspaceId, input.reason);
    const at = this.now();
    let previousRole = 'UNKNOWN';
    const outcome = await this.repository.changeRole({
      workspaceId, membershipId, role: input.role, at,
      buildAudit: (membership, priorRole) => {
        previousRole = priorRole;
        return this.platform.buildAuditRecord({
          actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: membership.userId, action: 'CHANGE_MEMBERSHIP_ROLE',
          permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
          detail: { workspaceId, membershipId, role: input.role, previousRole: priorRole, justification: reason },
        });
      },
    });
    if (outcome === 'NOT_FOUND') {
      await this.denied(principal, 'CHANGE_MEMBERSHIP_ROLE', workspaceId, 'MEMBERSHIP_NOT_FOUND', { membershipId });
      throw new DomainError('NOT_FOUND', 'Membership not found');
    }
    if (outcome === 'INVALID_STATE') {
      await this.denied(principal, 'CHANGE_MEMBERSHIP_ROLE', workspaceId, 'MEMBERSHIP_NOT_ACTIVE', { membershipId });
      throw new DomainError('CONFLICT', 'Only an active membership role can be changed');
    }
    if (outcome === 'LAST_OWNER') {
      await this.denied(principal, 'CHANGE_MEMBERSHIP_ROLE', workspaceId, 'LAST_WORKSPACE_OWNER', { membershipId });
      throw new DomainError('DENIED', 'The last workspace owner cannot be demoted');
    }
    const membership = await this.repository.findMembership(workspaceId, membershipId);
    if (!membership) throw new DomainError('NOT_FOUND', 'Membership not found');
    return roleView(membership, outcome === 'CHANGED', previousRole);
  }

  async revoke(principal: PlatformPrincipal, workspaceId: string, membershipId: string, input: { reason: string }): Promise<RevocationView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REVOKE_MEMBERSHIP', targetType: 'WORKSPACE', targetId: workspaceId });
    const workspace = await this.repository.findWorkspace(workspaceId);
    if (!workspace) {
      await this.denied(principal, 'REVOKE_MEMBERSHIP', workspaceId, 'WORKSPACE_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Workspace not found');
    }
    const reason = await this.validatedReason(principal, 'REVOKE_MEMBERSHIP', workspaceId, input.reason);
    const at = this.now();
    const outcome = await this.repository.revokeMember({
      workspaceId, membershipId, at,
      buildAudit: membership => this.platform.buildAuditRecord({
        actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: membership.userId, action: 'REVOKE_MEMBERSHIP',
        permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
        detail: { workspaceId, membershipId, justification: reason },
      }),
    });
    if (outcome === 'NOT_FOUND') {
      await this.denied(principal, 'REVOKE_MEMBERSHIP', workspaceId, 'MEMBERSHIP_NOT_FOUND', { membershipId });
      throw new DomainError('NOT_FOUND', 'Membership not found');
    }
    if (outcome === 'INVALID_STATE') {
      await this.denied(principal, 'REVOKE_MEMBERSHIP', workspaceId, 'MEMBERSHIP_NOT_REVOCABLE', { membershipId });
      throw new DomainError('CONFLICT', 'Membership cannot be revoked in its current state');
    }
    if (outcome === 'LAST_OWNER') {
      await this.denied(principal, 'REVOKE_MEMBERSHIP', workspaceId, 'LAST_WORKSPACE_OWNER', { membershipId });
      throw new DomainError('DENIED', 'The last workspace owner cannot be revoked');
    }
    const membership = await this.repository.findMembership(workspaceId, membershipId);
    if (!membership) throw new DomainError('NOT_FOUND', 'Membership not found');
    return {
      membershipId: membership.membershipId, userId: membership.userId, email: membership.email,
      status: membership.status, updatedAt: iso(membership.updatedAt),
    };
  }

  recordInputRejection(principal: PlatformPrincipal | undefined, context: { action: string; targetType: string; targetId?: string | null }): Promise<void> {
    return this.platform.recordInputRejection(principal, context);
  }

  private async validatedReason(principal: PlatformPrincipal, action: string, targetId: string, value: string): Promise<string> {
    try {
      return requiredReason(value);
    } catch (error: unknown) {
      await this.platform.recordAudit({
        actor: principal, targetType: 'WORKSPACE', targetId, action,
        permission: 'ADMINISTRATION', outcome: 'DENIED', reason: 'INVALID_JUSTIFICATION',
      });
      throw error;
    }
  }

  private async denied(
    principal: PlatformPrincipal,
    action: string,
    targetId: string | null,
    reason: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.platform.recordAudit({
      actor: principal, targetType: 'WORKSPACE', targetId, action,
      permission: 'ADMINISTRATION', outcome: 'DENIED', reason, detail: detail ?? null,
    });
  }
}
