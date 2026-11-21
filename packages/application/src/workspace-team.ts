import { randomBytes, createHash, randomUUID } from 'node:crypto';
import {
  DomainError,
  isMembershipStatus,
  isWorkspaceRole,
  type Principal,
  type WorkspaceRole,
} from '@qeynox/domain';
import type {
  InviteOutcome,
  MembershipRevokeOutcome,
  PlatformAuditRecord,
  PlatformAuditOutcome,
  RoleChangeOutcome,
  WorkspaceMemberCursor,
  WorkspaceMemberRow,
  WorkspaceRow,
  WorkspaceStats,
  WorkspaceUserSummary,
} from '@qeynox/persistence';
import { decodeMemberCursor, encodeMemberCursor } from './pagination';
import { deliverInvitationEmail, type InvitationDeliveryDeps } from './invitation-delivery';
import type { EmailTransport } from './platform-users';
import type { DeliveryLedger } from './notifications';

const defaultLimit = 25;
const maximumLimit = 100;
const minimumReasonLength = 10;
const maximumReasonLength = 500;

/**
 * MISSION A18 — customer self-service workspace and team management.
 *
 * The acting workspace is ALWAYS the one the verified session resolves to (`principal.workspaceId`);
 * no client input can redirect a mutation at another tenant. Management requires an ACTIVE OWNER or
 * ADMIN membership. Role grants above ADMIN additionally require OWNER, and an ADMIN can never
 * modify or revoke an OWNER membership (privilege escalation fence). Demotion/revocation of an
 * OWNER goes through the store's per-workspace advisory lock with zero-usable-owner refusal.
 * Every refusal is audited (platform audit table, action prefix SELF_SERVICE_*); every success is
 * audited inside the same transaction as the change.
 *
 * Reuses the WorkspaceStore contracts introduced for platform administration — no second identity
 * system and no second audit trail.
 */
export interface WorkspaceTeamRepository {
  listMine(userId: string): Promise<readonly { workspaceId: string; name: string; role: string }[]>;
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
  createWorkspaceWithOwner(input: {
    readonly name: string;
    readonly userId: string;
    readonly at: Date;
    readonly buildAudit: (workspaceId: string) => PlatformAuditRecord;
  }): Promise<{ readonly workspaceId: string }>;
  insertPlatformAudit(record: PlatformAuditRecord): Promise<void>;
}

export interface WorkspaceTeamServiceOptions {
  readonly now?: () => Date;
  /** Optional: when absent, invitations report e-mail as BLOCKED exactly as before. */
  readonly email?: EmailTransport;
  /** Optional sink for inline delivery outcomes (invitation links are single-use; never persisted). */
  readonly deliveryLedger?: DeliveryLedger;
  /** Absolute base URL used to build links inside e-mails. Relative paths are emitted when unset. */
  readonly publicBaseUrl?: string | null;
}

export interface WorkspaceOverviewView {
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly myRole: WorkspaceRole;
  /** Present only for OWNER/ADMIN members: everything else sees name/role/createdAt alone. */
  readonly stats: WorkspaceStats | null;
}
export interface TeamMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly invitedAt: string | null;
  readonly joinedAt: string | null;
  readonly updatedAt: string | null;
  readonly disabled: boolean;
  readonly isSelf: boolean;
}
export interface TeamMembersPage { readonly items: readonly TeamMemberView[]; readonly nextCursor: string | null; readonly limit: number }
export type { InvitationDelivery } from './invitation-delivery';
import type { InvitationDelivery } from './invitation-delivery';

export interface TeamInvitationView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly invitationToken: string;
  readonly invitationExpiresAt: string;
  readonly delivery: InvitationDelivery;
}
export interface CreateWorkspaceInput { readonly name: string }
export interface MyWorkspaceSummary { readonly workspaceId: string; readonly name: string; readonly role: string }

const iso = (value: Date | null) => value === null ? null : value.toISOString();
const memberView = (row: WorkspaceMemberRow, selfUserId: string): TeamMemberView => ({
  membershipId: row.membershipId,
  userId: row.userId,
  email: row.email,
  role: row.role,
  status: row.status,
  invitedAt: iso(row.invitedAt),
  joinedAt: iso(row.joinedAt),
  updatedAt: iso(row.updatedAt),
  disabled: row.userDisabledAt !== null,
  isSelf: row.userId === selfUserId,
});
const boundedLimit = (value: number | undefined) => value === undefined ? defaultLimit : Math.min(Math.max(1, Math.floor(value)), maximumLimit);

export class WorkspaceTeamService {
  private readonly now: () => Date;
  private readonly email: EmailTransport | null;
  private readonly deliveryLedger: DeliveryLedger | null;
  private readonly publicBaseUrl: string | null;
  constructor(private readonly repository: WorkspaceTeamRepository, options: WorkspaceTeamServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.email = options.email ?? null;
    this.deliveryLedger = options.deliveryLedger ?? null;
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '') ?? null;
  }

  /** Active workspace memberships for the caller, ordered by name — the switchable contexts. */
  async listMine(principal: Principal): Promise<{ userId: string; currentWorkspaceId: string; workspaces: readonly MyWorkspaceSummary[] }> {
    const actor = this.requirePrincipal(principal);
    const workspaces = await this.repository.listMine(actor.userId);
    return { userId: actor.userId, currentWorkspaceId: actor.workspaceId, workspaces };
  }

  async createWorkspace(principal: Principal, input: CreateWorkspaceInput): Promise<{ workspaceId: string; name: string }> {
    this.requirePrincipal(principal);
    const name = input.name.trim();
    if (name.length < 2 || name.length > 120) throw new DomainError('INVALID_INPUT', 'Workspace name must be 2–120 characters');
    const result = await this.repository.createWorkspaceWithOwner({
      name, userId: principal.userId, at: this.now(),
      buildAudit: workspaceId => this.auditRecord(principal, {
        targetType: 'WORKSPACE', targetId: workspaceId, action: 'SELF_SERVICE_WORKSPACE_CREATE',
        outcome: 'SUCCESS', reason: null, detail: { name },
      }),
    });
    return { workspaceId: result.workspaceId, name };
  }

  /** Read view of the acting workspace. Any ACTIVE member may read it; the stats block is OWNER/ADMIN-only. */
  async overview(principal: Principal): Promise<WorkspaceOverviewView> {
    const actor = this.requirePrincipal(principal);
    const workspace = await this.repository.findWorkspace(actor.workspaceId);
    if (!workspace) throw new DomainError('NOT_FOUND', 'Workspace not found');
    const role = this.actorRole(actor);
    const stats = this.isManager(role) ? await this.repository.workspaceStats(actor.workspaceId) : null;
    return { workspaceId: workspace.id, name: workspace.name, createdAt: workspace.createdAt.toISOString(), myRole: role, stats };
  }

  async listMembers(principal: Principal, input: {
    role?: string | undefined; status?: string | undefined; limit?: number | undefined; cursor?: string | undefined;
  }): Promise<TeamMembersPage> {
    const actor = this.requireManager(principal, 'SELF_SERVICE_LIST_MEMBERS');
    let role: WorkspaceRole | undefined;
    if (input.role !== undefined) {
      if (!isWorkspaceRole(input.role)) throw new DomainError('INVALID_INPUT', 'Unknown workspace role');
      role = input.role;
    }
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
      } catch {
        await this.recordDenied(actor, 'SELF_SERVICE_LIST_MEMBERS', 'INVALID_CURSOR');
        throw new DomainError('INVALID_INPUT', 'Invalid cursor');
      }
    }
    // One extra row to compute the cursor; members are never pushed into another tenant's page.
    const rows = await this.repository.listMembers(actor.workspaceId, { role, status, before, take: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodeMemberCursor(last.email, last.membershipId) : null;
    return { items: page.map(row => memberView(row, actor.userId)), nextCursor, limit };
  }

  async inviteMember(principal: Principal, input: { email: string; role: string; reason: string }): Promise<TeamInvitationView> {
    const actor = this.requireManager(principal, 'SELF_SERVICE_INVITE_MEMBER');
    const roleError = this.roleGrantError(actor, input.role, 'SELF_SERVICE_INVITE_MEMBER');
    if (roleError) throw roleError;
    const reason = this.validatedReason(input.reason, 'SELF_SERVICE_INVITE_MEMBER');
    const email = input.email.trim().toLowerCase();
    const user = await this.repository.findUserByEmail(email);
    if (!user) {
      await this.recordDenied(actor, 'SELF_SERVICE_INVITE_MEMBER', 'IDENTITY_ACCOUNT_REQUIRED', { email });
      throw new DomainError('NOT_FOUND', 'An existing identity account is required to invite a member');
    }
    if (user.disabledAt) {
      await this.recordDenied(actor, 'SELF_SERVICE_INVITE_MEMBER', 'ACCOUNT_DISABLED', { email });
      throw new DomainError('DENIED', 'Identity account is disabled');
    }
    const role = input.role as WorkspaceRole;
    const at = this.now();
    const invitationToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(invitationToken).digest('hex');
    const invitationExpiresAt = new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await this.repository.inviteUser({
      workspaceId: actor.workspaceId, userId: user.userId, role, invitedBy: actor.userId, at, tokenHash, tokenExpiresAt: invitationExpiresAt,
      buildAudit: membershipId => this.auditRecord(actor, {
        targetType: 'IDENTITY_ACCOUNT', targetId: user.userId, action: 'SELF_SERVICE_INVITE_MEMBER',
        outcome: 'SUCCESS', reason,
        detail: { workspaceId: actor.workspaceId, membershipId, role, emailDelivery: this.email?.status === 'CONFIGURED' ? 'PENDING' : 'BLOCKED' },
      }),
    });
    if (invitation.outcome === 'ALREADY_MEMBER') {
      await this.recordDenied(actor, 'SELF_SERVICE_INVITE_MEMBER', 'ALREADY_MEMBER', { userId: user.userId });
      throw new DomainError('CONFLICT', 'Identity account is already an active workspace member');
    }
    if (invitation.outcome === 'ALREADY_INVITED') {
      await this.recordDenied(actor, 'SELF_SERVICE_INVITE_MEMBER', 'ALREADY_INVITED', { userId: user.userId });
      throw new DomainError('CONFLICT', 'An invitation is already pending for this account');
    }
    const delivery = await this.deliverInvitationEmail({
      membershipId: invitation.membershipId, userId: user.userId, email, locale: user.locale,
      workspaceId: actor.workspaceId, role, invitationToken, invitationExpiresAt,
    });
    return {
      membershipId: invitation.membershipId, userId: user.userId, email, role,
      invitationToken, invitationExpiresAt: invitationExpiresAt.toISOString(),
      delivery,
    };
  }

  /** See invitation-delivery.ts — shared with the platform invitation path. */
  private async deliverInvitationEmail(input: { membershipId: string; userId: string; email: string; locale: string; workspaceId: string; role: WorkspaceRole; invitationToken: string; invitationExpiresAt: Date }): Promise<InvitationDelivery> {
    const workspace = await this.repository.findWorkspace(input.workspaceId);
    const deps: InvitationDeliveryDeps = { email: this.email, deliveryLedger: this.deliveryLedger, publicBaseUrl: this.publicBaseUrl, now: this.now };
    return deliverInvitationEmail(deps, {
      membershipId: input.membershipId, userId: input.userId, workspaceId: input.workspaceId,
      workspaceName: workspace?.name ?? input.workspaceId,
      recipientEmail: input.email, recipientLocale: input.locale,
      role: input.role, expiresAt: input.invitationExpiresAt,
    });
  }

  async changeMemberRole(principal: Principal, membershipId: string, input: { role: string; reason: string }): Promise<{ membershipId: string; role: WorkspaceRole; changed: boolean }> {
    const actor = this.requireManager(principal, 'SELF_SERVICE_CHANGE_ROLE');
    if (!isWorkspaceRole(input.role)) {
      await this.recordDenied(actor, 'SELF_SERVICE_CHANGE_ROLE', 'INVALID_WORKSPACE_ROLE', { membershipId });
      throw new DomainError('INVALID_INPUT', 'Unknown workspace role');
    }
    const target = await this.repository.findMembership(actor.workspaceId, membershipId);
    const targetError = await this.roleTargetError(actor, target, 'SELF_SERVICE_CHANGE_ROLE', input.role as WorkspaceRole, membershipId);
    if (targetError) throw targetError;
    const reason = this.validatedReason(input.reason, 'SELF_SERVICE_CHANGE_ROLE');
    const at = this.now();
    let changed = false;
    const outcome = await this.repository.changeRole({
      workspaceId: actor.workspaceId, membershipId, role: input.role as WorkspaceRole, at,
      buildAudit: (membership, previousRole) => this.auditRecord(actor, {
        targetType: 'IDENTITY_ACCOUNT', targetId: membership.userId, action: 'SELF_SERVICE_CHANGE_ROLE',
        outcome: 'SUCCESS', reason,
        detail: { workspaceId: actor.workspaceId, membershipId, role: input.role, previousRole },
      }),
    });
    if (outcome === 'NOT_FOUND') { await this.recordDenied(actor, 'SELF_SERVICE_CHANGE_ROLE', 'MEMBERSHIP_NOT_FOUND', { membershipId }); throw new DomainError('NOT_FOUND', 'Membership not found in this workspace'); }
    if (outcome === 'INVALID_STATE') { await this.recordDenied(actor, 'SELF_SERVICE_CHANGE_ROLE', 'MEMBERSHIP_NOT_ACTIVE', { membershipId }); throw new DomainError('CONFLICT', 'Only an active membership role can be changed'); }
    if (outcome === 'LAST_OWNER') { await this.recordDenied(actor, 'SELF_SERVICE_CHANGE_ROLE', 'LAST_WORKSPACE_OWNER', { membershipId }); throw new DomainError('DENIED', 'The last workspace owner cannot be demoted'); }
    changed = outcome === 'CHANGED';
    return { membershipId, role: input.role as WorkspaceRole, changed };
  }

  async revokeMember(principal: Principal, membershipId: string, input: { reason: string }): Promise<{ membershipId: string; status: 'REVOKED' }> {
    const actor = this.requireManager(principal, 'SELF_SERVICE_REVOKE_MEMBER');
    const target = await this.repository.findMembership(actor.workspaceId, membershipId);
    const targetError = await this.roleTargetError(actor, target, 'SELF_SERVICE_REVOKE_MEMBER', null, membershipId);
    if (targetError) throw targetError;
    const reason = this.validatedReason(input.reason, 'SELF_SERVICE_REVOKE_MEMBER');
    const at = this.now();
    const outcome = await this.repository.revokeMember({
      workspaceId: actor.workspaceId, membershipId, at,
      buildAudit: membership => this.auditRecord(actor, {
        targetType: 'IDENTITY_ACCOUNT', targetId: membership.userId, action: 'SELF_SERVICE_REVOKE_MEMBER',
        outcome: 'SUCCESS', reason,
        detail: { workspaceId: actor.workspaceId, membershipId },
      }),
    });
    if (outcome === 'NOT_FOUND') { await this.recordDenied(actor, 'SELF_SERVICE_REVOKE_MEMBER', 'MEMBERSHIP_NOT_FOUND', { membershipId }); throw new DomainError('NOT_FOUND', 'Membership not found in this workspace'); }
    if (outcome === 'INVALID_STATE') { await this.recordDenied(actor, 'SELF_SERVICE_REVOKE_MEMBER', 'MEMBERSHIP_NOT_REVOCABLE', { membershipId }); throw new DomainError('CONFLICT', 'Membership cannot be revoked in its current state'); }
    if (outcome === 'LAST_OWNER') { await this.recordDenied(actor, 'SELF_SERVICE_REVOKE_MEMBER', 'LAST_WORKSPACE_OWNER', { membershipId }); throw new DomainError('DENIED', 'The last workspace owner cannot be revoked'); }
    return { membershipId, status: 'REVOKED' };
  }

  // ---- internals ---------------------------------------------------------------------------------

  private requirePrincipal(principal: Principal): Principal {
    if (!principal?.userId || !principal.workspaceId) throw new DomainError('DENIED', 'Authenticated workspace session required');
    return principal;
  }

  private actorRole(principal: Principal): WorkspaceRole {
    const role = principal.roles.find(value => value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER');
    if (!role) throw new DomainError('DENIED', 'Workspace membership required');
    return role as WorkspaceRole;
  }

  private isManager(role: WorkspaceRole): boolean {
    return role === 'OWNER' || role === 'ADMIN';
  }

  private requireManager(principal: Principal, action: string): Principal {
    const actor = this.requirePrincipal(principal);
    const role = this.actorRole(actor);
    if (!this.isManager(role)) throw new DomainError('DENIED', 'Workspace OWNER or ADMIN role required to manage this workspace');
    return actor;
  }

  /** Granting OWNER requires an OWNER actor; ADMIN may grant/revoke ADMIN and MEMBER only. */
  private roleGrantError(actor: Principal, rawRole: string, action: string): DomainError | null {
    if (!isWorkspaceRole(rawRole)) return new DomainError('INVALID_INPUT', 'Unknown workspace role');
    if (rawRole === 'OWNER' && this.actorRole(actor) !== 'OWNER') {
      return new DomainError('DENIED', 'Only a workspace owner can grant the owner role');
    }
    return null;
  }

  /** Targeting rules: ADMINs cannot touch an OWNER membership; granting OWNER requires an OWNER actor. */
  private async roleTargetError(actor: Principal, target: WorkspaceMemberRow | undefined, action: string, grantRole: WorkspaceRole | null, membershipId: string): Promise<DomainError | null> {
    const actorRoleValue = this.actorRole(actor);
    if (grantRole === 'OWNER' && actorRoleValue !== 'OWNER') {
      await this.recordDenied(actor, action, 'GRANT_OWNER_FORBIDDEN', { membershipId });
      return new DomainError('DENIED', 'Only a workspace owner can grant the owner role');
    }
    if (target && target.role === 'OWNER' && actorRoleValue !== 'OWNER') {
      await this.recordDenied(actor, action, 'TARGET_OWNER_FORBIDDEN', { membershipId });
      return new DomainError('DENIED', 'Only a workspace owner can manage an owner membership');
    }
    return null;
  }

  private validatedReason(value: string, action: string): string {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length < minimumReasonLength || reason.length > maximumReasonLength) {
      throw new DomainError('INVALID_INPUT', 'Justification must be ' + minimumReasonLength + '–' + maximumReasonLength + ' characters');
    }
    return reason;
  }

  private auditRecord(principal: Principal, input: {
    readonly targetType: string; readonly targetId: string | null; readonly action: string;
    readonly outcome: PlatformAuditOutcome; readonly reason: string | null; readonly detail: Record<string, unknown> | null;
  }): PlatformAuditRecord {
    return {
      id: randomUUID(), actorUserId: principal.userId, actorSessionId: null,
      targetType: input.targetType, targetId: input.targetId, action: input.action,
      permission: 'WORKSPACE_ADMINISTRATION', outcome: input.outcome, reason: input.reason,
      detail: input.detail, happenedAt: this.now(),
    };
  }

  private async recordDenied(principal: Principal, action: string, reason: string, detail: Record<string, unknown> | null = null): Promise<void> {
    await this.repository.insertPlatformAudit(this.auditRecord(principal, {
      targetType: 'WORKSPACE', targetId: principal.workspaceId, action, outcome: 'DENIED', reason, detail,
    }));
  }
}
