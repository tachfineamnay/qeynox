import { createHash } from 'node:crypto';
import { DomainError, isWorkspaceRole, type Principal } from '@qeynox/domain';
import type { InvitationResponseOutcome, WorkspaceInvitationRow } from '@qeynox/persistence';

export interface WorkspaceAccessRepository {
  listUserInvitations(userId: string): Promise<readonly WorkspaceInvitationRow[]>;
  respondToInvitation(input: {
    readonly userId: string;
    readonly membershipId: string;
    readonly action: 'ACCEPT' | 'DECLINE';
    readonly at: Date;
  }): Promise<InvitationResponseOutcome>;
  respondToInvitationToken(input: {
    readonly tokenHash: string;
    readonly action: 'ACCEPT' | 'DECLINE';
    readonly at: Date;
  }): Promise<{ readonly outcome: InvitationResponseOutcome; readonly membershipId: string | null; readonly workspaceId: string | null; readonly userId: string | null }>;
}

export interface WorkspaceInvitationView {
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: string;
  readonly invitedBy: string | null;
  readonly invitedAt: string | null;
}

export interface InvitationResponseView {
  readonly membershipId: string;
  readonly status: 'ACTIVE' | 'DECLINED';
  readonly workspaceId?: string;
}

export interface WorkspaceAccessServiceOptions { readonly now?: () => Date }

/** Tenant-facing invitation inbox: a user only ever sees and answers their own invitations. */
export class WorkspaceAccessService {
  private readonly now: () => Date;
  constructor(private readonly repository: WorkspaceAccessRepository, options: WorkspaceAccessServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private requirePrincipal(principal: Principal | undefined): Principal {
    if (!principal || !principal.userId) throw new DomainError('DENIED', 'Authenticated session required');
    return principal;
  }

  async listInvitations(principal: Principal | undefined): Promise<readonly WorkspaceInvitationView[]> {
    const actor = this.requirePrincipal(principal);
    const rows = await this.repository.listUserInvitations(actor.userId);
    return rows.map(row => ({
      membershipId: row.membershipId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      role: isWorkspaceRole(row.role) ? row.role : (() => { throw new DomainError('INVALID_STATE', 'Stored workspace role is unknown'); })(),
      invitedBy: row.invitedBy,
      invitedAt: row.invitedAt === null ? null : row.invitedAt.toISOString(),
    }));
  }

  async accept(principal: Principal | undefined, membershipId: string): Promise<InvitationResponseView> {
    return this.respond(principal, membershipId, 'ACCEPT');
  }

  async decline(principal: Principal | undefined, membershipId: string): Promise<InvitationResponseView> {
    return this.respond(principal, membershipId, 'DECLINE');
  }

  /** Token-based response for accounts without any ACTIVE membership (cannot open a session). */
  async acceptByToken(token: string): Promise<InvitationResponseView> {
    return this.respondByToken(token, 'ACCEPT');
  }

  async declineByToken(token: string): Promise<InvitationResponseView> {
    return this.respondByToken(token, 'DECLINE');
  }

  private async respondByToken(token: string, action: 'ACCEPT' | 'DECLINE'): Promise<InvitationResponseView> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new DomainError('INVALID_INPUT', 'Invalid invitation token');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await this.repository.respondToInvitationToken({ tokenHash, action, at: this.now() });
    if (result.outcome === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'Invitation not found');
    if (result.outcome === 'INVALID_STATE') throw new DomainError('CONFLICT', 'Invitation is no longer pending or has expired');
    return {
      membershipId: result.membershipId ?? '',
      workspaceId: result.workspaceId ?? undefined,
      status: result.outcome === 'ACCEPTED' ? 'ACTIVE' : 'DECLINED',
    };
  }

  private async respond(principal: Principal | undefined, membershipId: string, action: 'ACCEPT' | 'DECLINE'): Promise<InvitationResponseView> {
    const actor = this.requirePrincipal(principal);
    const outcome = await this.repository.respondToInvitation({
      userId: actor.userId, membershipId, action, at: this.now(),
    });
    if (outcome === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'Invitation not found');
    if (outcome === 'INVALID_STATE') throw new DomainError('CONFLICT', 'Invitation is no longer pending');
    return { membershipId, status: outcome === 'ACCEPTED' ? 'ACTIVE' : 'DECLINED' };
  }
}
