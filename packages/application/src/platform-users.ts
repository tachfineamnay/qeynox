import {
  DomainError,
  hasPlatformPermission,
  type PlatformPermission,
  type PlatformPrincipal,
  type PlatformRole,
} from '@qeynox/domain';
import type {
  PlatformAuditRecord,
  PlatformIdentitySessionRow,
  PlatformReactivateOutcome,
  PlatformSessionCounts,
  PlatformSessionRevokeOutcome,
  PlatformSuspendOutcome,
  PlatformUserActivityRow,
  PlatformUserCursor,
  PlatformUserMembershipRow,
  PlatformUserOnboardingRow,
  PlatformUserRow,
} from '@qeynox/persistence';
import { PlatformAdminService, type PlatformPermissionContext } from './platform-admin';

/**
 * Email transport port. The only implementation shipped in this repository is
 * NotConfiguredEmailTransport: no provider is configured, so invitation, e-mail verification and
 * account recovery must stay explicitly blocked. A future provider adapter implements this port
 * and is only wired after independent review; until then no message is ever "sent".
 */
export interface EmailTransport {
  readonly status: 'CONFIGURED' | 'NOT_CONFIGURED';
  readonly reason: string | null;
  send(message: { readonly to: string; readonly subject: string; readonly text: string }): Promise<void>;
}

export class NotConfiguredEmailTransport implements EmailTransport {
  readonly status = 'NOT_CONFIGURED' as const;
  readonly reason: string;
  constructor(reason = 'EMAIL_PROVIDER_NOT_CONFIGURED') {
    this.reason = reason;
  }
  async send(): Promise<void> {
    throw new DomainError('NOT_CONFIGURED', 'Email transport is not configured; no message was sent');
  }
}

/** Persistence port for platform user administration over the existing identity tables. */
export interface PlatformUserRepository {
  listUsers(input: {
    readonly query?: string | undefined;
    readonly status?: 'ACTIVE' | 'SUSPENDED' | undefined;
    readonly before?: PlatformUserCursor | undefined;
    readonly take: number;
  }): Promise<readonly PlatformUserRow[]>;
  countWorkspacesByUserIds(userIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  findUser(userId: string): Promise<PlatformUserRow | undefined>;
  listMemberships(userId: string): Promise<readonly PlatformUserMembershipRow[]>;
  listSessions(userId: string): Promise<readonly PlatformIdentitySessionRow[]>;
  listPlatformSessions(userId: string): Promise<readonly PlatformIdentitySessionRow[]>;
  sessionsSummary(userId: string, at: Date): Promise<{ readonly total: number; readonly active: number; readonly lastUsedAt: Date | null }>;
  platformSessionsSummary(userId: string, at: Date): Promise<{ readonly total: number; readonly active: number; readonly lastUsedAt: Date | null }>;
  listPlatformRoles(userId: string): Promise<readonly PlatformRole[]>;
  suspendUserGuarded(input: {
    readonly userId: string;
    readonly at: Date;
    readonly buildSuccessAudit: (counts: PlatformSessionCounts) => PlatformAuditRecord;
  }): Promise<PlatformSuspendOutcome>;
  reactivateUserWithAudit(input: { readonly userId: string; readonly at: Date; readonly successAudit: PlatformAuditRecord }): Promise<PlatformReactivateOutcome>;
  revokeUserSessionsWithAudit(input: {
    readonly userId: string;
    readonly at: Date;
    readonly buildSuccessAudit: (counts: PlatformSessionCounts) => PlatformAuditRecord;
  }): Promise<{
    readonly outcome: PlatformSessionRevokeOutcome;
    readonly revoked: number;
    readonly revokedWorkspaceSessions: number;
    readonly revokedPlatformSessions: number;
  }>;
  listActivity(userId: string, before: PlatformUserCursor | undefined, limit: number): Promise<readonly PlatformUserActivityRow[]>;
  listOnboardingStatuses(userId: string): Promise<readonly PlatformUserOnboardingRow[]>;
}

const readPermissions: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];
const readActivityPermissions: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT', 'CONSULTATION'];
const defaultLimit = 25;
const maximumLimit = 100;
const maximumQueryLength = 320;
const minimumReasonLength = 10;
const maximumReasonLength = 500;
const accountFeatures = ['INVITATIONS', 'EMAIL_VERIFICATION', 'ACCOUNT_RECOVERY'] as const;

export type AccountFeature = (typeof accountFeatures)[number];
export type AccountFeatureStatus = 'AVAILABLE' | 'BLOCKED';

export interface PlatformUserListInput {
  readonly query?: string | undefined;
  readonly status?: 'ACTIVE' | 'SUSPENDED' | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface PlatformUserSummary {
  readonly userId: string;
  readonly email: string;
  readonly locale: string;
  readonly createdAt: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly disabledAt: string | null;
  readonly workspaceCount: number;
}

export interface PlatformUserPage {
  readonly items: readonly PlatformUserSummary[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface PlatformUserWorkspace {
  readonly workspaceId: string;
  readonly name: string;
  readonly role: string;
  readonly membershipStatus: string;
  readonly workspaceCreatedAt: string;
}

export interface PlatformUserSessionView {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly active: boolean;
}

export interface PlatformUserDetail {
  readonly userId: string;
  readonly email: string;
  readonly locale: string;
  readonly createdAt: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly disabledAt: string | null;
  readonly workspaces: readonly PlatformUserWorkspace[];
  readonly sessions: {
    readonly total: number;
    readonly active: number;
    readonly lastUsedAt: string | null;
    /** Platform-administration sessions are only disclosed to ADMINISTRATION principals. */
    readonly platformSessions?: { readonly total: number; readonly active: number; readonly lastUsedAt: string | null } | undefined;
  };
  /** Internal QeyNox roles are only disclosed to ADMINISTRATION principals. */
  readonly platformRoles?: readonly PlatformRole[] | undefined;
  /** Onboarding progress per workspace: status, step and dates only, never private answer content. */
  readonly onboarding: readonly PlatformUserOnboardingStatusView[];
}

export interface PlatformUserOnboardingStatusView {
  readonly workspaceId: string;
  readonly status: 'NOT_STARTED' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'DISMISSED';
  readonly step: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
}

export interface PlatformUserSessionsView {
  readonly userId: string;
  readonly sessions: readonly PlatformUserSessionView[];
  readonly summary: { readonly total: number; readonly active: number; readonly lastUsedAt: string | null };
  /** Present only for ADMINISTRATION principals; platform sessions are a separate namespace. */
  readonly platformSessions?: readonly PlatformUserSessionView[] | undefined;
  readonly platformSummary?: { readonly total: number; readonly active: number; readonly lastUsedAt: string | null } | undefined;
  /** True when the workspace session list hit the 200-row cap while summary.total is larger. */
  readonly truncated: boolean;
}

export interface PlatformUserActivityItem {
  readonly source: 'IDENTITY' | 'PLATFORM';
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly happenedAt: string;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly permission: string | null;
}

export interface PlatformUserActivityPage {
  readonly items: readonly PlatformUserActivityItem[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface PlatformUserActivityInput {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface PlatformUserStatusView {
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly disabledAt: string | null;
}

export interface PlatformUserSessionsRevocationView {
  readonly userId: string;
  readonly revokedSessions: number;
  readonly revokedWorkspaceSessions: number;
  readonly revokedPlatformSessions: number;
  readonly revokedAt: string;
}

export interface AccountCapabilities {
  readonly emailTransport: 'CONFIGURED' | 'NOT_CONFIGURED';
  readonly features: readonly { readonly feature: AccountFeature; readonly status: AccountFeatureStatus; readonly reason: string }[];
  readonly note: string;
}

export interface PlatformUsersServiceOptions {
  readonly now?: () => Date;
}

interface DecodedCursor { readonly at: Date; readonly id: string }

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): DecodedCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('shape');
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime()) || !/^[A-Za-z0-9_-]{4,120}$/.test(parsed.id)) throw new Error('value');
    return { at, id: parsed.id };
  } catch {
    throw new DomainError('INVALID_INPUT', 'Invalid pagination cursor');
  }
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return defaultLimit;
  return Math.min(value, maximumLimit);
}

function normalizedQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const query = value.trim();
  if (!query.length) return undefined;
  if (query.length > maximumQueryLength) throw new DomainError('INVALID_INPUT', 'Search query is too long');
  return query;
}

function requiredReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < minimumReasonLength || reason.length > maximumReasonLength) {
    throw new DomainError('INVALID_INPUT', 'A justification of ' + minimumReasonLength + '-' + maximumReasonLength + ' characters is required');
  }
  return reason;
}

function statusOf(row: { readonly disabledAt: Date | null }): 'ACTIVE' | 'SUSPENDED' {
  return row.disabledAt === null ? 'ACTIVE' : 'SUSPENDED';
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function sessionView(session: PlatformIdentitySessionRow, at: Date): PlatformUserSessionView {
  return {
    sessionId: session.id, createdAt: session.createdAt.toISOString(), expiresAt: session.expiresAt.toISOString(),
    revokedAt: iso(session.revokedAt), lastUsedAt: iso(session.lastUsedAt),
    active: session.revokedAt === null && session.expiresAt.getTime() > at.getTime(),
  };
}

/**
 * Platform user administration over the existing identity tables.
 *
 * Guarantees:
 * - authorization is enforced on the server for every operation (any-of read permissions,
 *   ADMINISTRATION for mutations), never inferred from the caller's workspace role;
 * - every action and every denied attempt is written to platform_admin_audit with actor, target,
 *   action, date, result and the operator's justification;
 * - suspension is reversible (identity_users.disabled_at), sessions are revoked by marking
 *   identity_sessions.revoked_at, and no row or credential is ever deleted;
 * - no second authentication system: identity credentials and workspace sessions are the only ones
 *   this service reads or invalidates;
 * - invitation / e-mail verification / account recovery remain explicitly blocked through the
 *   not-configured e-mail transport; no message is claimed to be sent.
 */
export class PlatformUsersService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: PlatformUserRepository,
    private readonly platform: PlatformAdminService,
    private readonly email: EmailTransport,
    options: PlatformUsersServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(principal: PlatformPrincipal, input: PlatformUserListInput): Promise<PlatformUserPage> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'LIST_PLATFORM_USERS', targetType: 'USER_DIRECTORY' });
    const limit = boundedLimit(input.limit);
    let before: DecodedCursor | undefined;
    if (input.cursor !== undefined) {
      try {
        before = decodeCursor(input.cursor);
      } catch (error: unknown) {
        await this.denied(principal, 'LIST_PLATFORM_USERS', null, 'INVALID_CURSOR');
        throw error;
      }
    }
    let query: string | undefined;
    try {
      query = normalizedQuery(input.query);
    } catch (error: unknown) {
      await this.denied(principal, 'LIST_PLATFORM_USERS', null, 'INVALID_QUERY');
      throw error;
    }
    const rows = await this.repository.listUsers({ query, status: input.status, before, take: limit + 1 });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const counts = await this.repository.countWorkspacesByUserIds(pageRows.map(row => row.id));
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;
    await this.platform.recordAudit({
      actor: principal, targetType: 'USER_DIRECTORY', action: 'LIST_PLATFORM_USERS', permission: readPermissions.join('|'),
      outcome: 'SUCCESS', detail: { query: query ?? null, status: input.status ?? null, limit, returned: pageRows.length },
    });
    return {
      items: pageRows.map(row => ({
        userId: row.id, email: row.email, locale: row.locale, createdAt: row.createdAt.toISOString(),
        status: statusOf(row), disabledAt: iso(row.disabledAt), workspaceCount: counts.get(row.id) ?? 0,
      })),
      nextCursor, limit,
    };
  }

  async get(principal: PlatformPrincipal, userId: string): Promise<PlatformUserDetail> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'READ_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const user = await this.repository.findUser(userId);
    if (!user) {
      await this.denied(principal, 'READ_PLATFORM_USER', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    const at = this.now();
    const discloseRoles = hasPlatformPermission(principal, 'ADMINISTRATION');
    const [memberships, summary, platformRoles, platformSummary, onboarding] = await Promise.all([
      this.repository.listMemberships(userId),
      this.repository.sessionsSummary(userId, at),
      discloseRoles ? this.repository.listPlatformRoles(userId) : Promise.resolve([] as readonly PlatformRole[]),
      discloseRoles ? this.repository.platformSessionsSummary(userId, at) : Promise.resolve(undefined),
      this.repository.listOnboardingStatuses(userId),
    ]);
    await this.platform.recordAudit({
      actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'READ_PLATFORM_USER',
      permission: readPermissions.join('|'), outcome: 'SUCCESS', detail: { platformRolesDisclosed: discloseRoles },
    });
    const detail: PlatformUserDetail = {
      userId: user.id, email: user.email, locale: user.locale, createdAt: user.createdAt.toISOString(),
      status: statusOf(user), disabledAt: iso(user.disabledAt),
      workspaces: memberships.map(membership => ({
        workspaceId: membership.workspaceId, name: membership.workspaceName, role: membership.role,
        membershipStatus: membership.membershipStatus, workspaceCreatedAt: membership.workspaceCreatedAt.toISOString(),
      })),
      sessions: {
        total: summary.total, active: summary.active, lastUsedAt: iso(summary.lastUsedAt),
        ...(discloseRoles && platformSummary !== undefined ? {
          platformSessions: { total: platformSummary.total, active: platformSummary.active, lastUsedAt: iso(platformSummary.lastUsedAt) },
        } : {}),
      },
      ...(discloseRoles ? { platformRoles } : {}),
      onboarding: memberships.map(membership => {
        const record = onboarding.find(item => item.workspaceId === membership.workspaceId);
        return record === undefined
          ? { workspaceId: membership.workspaceId, status: 'NOT_STARTED' as const, step: null, startedAt: null, updatedAt: null, completedAt: null }
          : {
              workspaceId: record.workspaceId, status: record.status, step: record.step,
              startedAt: record.startedAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
              completedAt: record.completedAt === null ? null : record.completedAt.toISOString(),
            };
      }),
    };
    return detail;
  }

  async listSessions(principal: PlatformPrincipal, userId: string): Promise<PlatformUserSessionsView> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'LIST_USER_SESSIONS', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const user = await this.repository.findUser(userId);
    if (!user) {
      await this.denied(principal, 'LIST_USER_SESSIONS', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    const at = this.now();
    const disclosePlatform = hasPlatformPermission(principal, 'ADMINISTRATION');
    const [sessions, summary, platformSessions, platformSummary] = await Promise.all([
      this.repository.listSessions(userId),
      this.repository.sessionsSummary(userId, at),
      disclosePlatform ? this.repository.listPlatformSessions(userId) : Promise.resolve([] as readonly PlatformIdentitySessionRow[]),
      disclosePlatform ? this.repository.platformSessionsSummary(userId, at) : Promise.resolve(undefined),
    ]);
    await this.platform.recordAudit({
      actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'LIST_USER_SESSIONS',
      permission: readPermissions.join('|'), outcome: 'SUCCESS',
      detail: { returned: sessions.length, platformSessionsDisclosed: disclosePlatform },
    });
    const view: PlatformUserSessionsView = {
      userId,
      sessions: sessions.map(session => sessionView(session, at)),
      summary: { total: summary.total, active: summary.active, lastUsedAt: iso(summary.lastUsedAt) },
      truncated: summary.total > sessions.length,
      ...(disclosePlatform ? {
        platformSessions: platformSessions.map(session => sessionView(session, at)),
        ...(platformSummary !== undefined ? {
          platformSummary: { total: platformSummary.total, active: platformSummary.active, lastUsedAt: iso(platformSummary.lastUsedAt) },
        } : {}),
      } : {}),
    };
    return view;
  }

  async activity(principal: PlatformPrincipal, userId: string, input: PlatformUserActivityInput): Promise<PlatformUserActivityPage> {
    await this.platform.requireAnyPermission(principal, readActivityPermissions, { action: 'READ_USER_ACTIVITY', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const user = await this.repository.findUser(userId);
    if (!user) {
      await this.denied(principal, 'READ_USER_ACTIVITY', userId, 'USER_NOT_FOUND', 'ADMINISTRATION|SUPPORT|CONSULTATION');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    const limit = boundedLimit(input.limit);
    let before: DecodedCursor | undefined;
    if (input.cursor !== undefined) {
      try {
        before = decodeCursor(input.cursor);
      } catch (error: unknown) {
        await this.denied(principal, 'READ_USER_ACTIVITY', userId, 'INVALID_CURSOR', 'ADMINISTRATION|SUPPORT|CONSULTATION');
        throw error;
      }
    }
    const rows = await this.repository.listActivity(userId, before, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? encodeCursor(last.happenedAt, last.id) : null;
    await this.platform.recordAudit({
      actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'READ_USER_ACTIVITY',
      permission: readActivityPermissions.join('|'), outcome: 'SUCCESS', detail: { limit, returned: page.length },
    });
    return {
      items: page.map(row => ({
        source: row.source, id: row.id, action: row.action, outcome: row.outcome,
        happenedAt: row.happenedAt.toISOString(), actorUserId: row.actorUserId, reason: row.reason, permission: row.permission,
      })),
      nextCursor, limit,
    };
  }

  async suspend(principal: PlatformPrincipal, userId: string, input: { readonly reason: string }): Promise<PlatformUserStatusView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'SUSPEND_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const reason = await this.validatedReason(principal, 'SUSPEND_PLATFORM_USER', 'IDENTITY_ACCOUNT', userId, input.reason);
    if (principal.userId === userId) {
      await this.denied(principal, 'SUSPEND_PLATFORM_USER', userId, 'SELF_SUSPENSION');
      throw new DomainError('DENIED', 'An operator cannot suspend their own account');
    }
    const at = this.now();
    const outcome = await this.repository.suspendUserGuarded({
      userId, at,
      buildSuccessAudit: counts => this.platform.buildAuditRecord({
        actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'SUSPEND_PLATFORM_USER',
        permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
        detail: { justification: reason, workspaceSessions: counts.workspaceSessions, platformSessions: counts.platformSessions },
      }),
    });
    if (outcome === 'NOT_FOUND') {
      await this.denied(principal, 'SUSPEND_PLATFORM_USER', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    if (outcome === 'ALREADY_SUSPENDED') {
      await this.denied(principal, 'SUSPEND_PLATFORM_USER', userId, 'ALREADY_SUSPENDED');
      throw new DomainError('CONFLICT', 'Account is already suspended');
    }
    if (outcome === 'LAST_ADMIN') {
      await this.denied(principal, 'SUSPEND_PLATFORM_USER', userId, 'LAST_PLATFORM_ADMIN');
      throw new DomainError('DENIED', 'Cannot suspend the last enabled platform administrator');
    }
    if (outcome === 'LAST_WORKSPACE_OWNER') {
      await this.denied(principal, 'SUSPEND_PLATFORM_USER', userId, 'LAST_WORKSPACE_OWNER');
      throw new DomainError('DENIED', 'Cannot suspend the last enabled owner of a workspace');
    }
    return { userId, status: 'SUSPENDED', disabledAt: at.toISOString() };
  }

  async reactivate(principal: PlatformPrincipal, userId: string, input: { readonly reason: string }): Promise<PlatformUserStatusView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REACTIVATE_PLATFORM_USER', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const reason = await this.validatedReason(principal, 'REACTIVATE_PLATFORM_USER', 'IDENTITY_ACCOUNT', userId, input.reason);
    const at = this.now();
    const successAudit = this.platform.buildAuditRecord({
      actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'REACTIVATE_PLATFORM_USER',
      permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason, detail: { justification: reason },
    });
    const outcome = await this.repository.reactivateUserWithAudit({ userId, at, successAudit });
    if (outcome === 'NOT_FOUND') {
      await this.denied(principal, 'REACTIVATE_PLATFORM_USER', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    if (outcome === 'NOT_SUSPENDED') {
      await this.denied(principal, 'REACTIVATE_PLATFORM_USER', userId, 'NOT_SUSPENDED');
      throw new DomainError('CONFLICT', 'Account is not suspended');
    }
    return { userId, status: 'ACTIVE', disabledAt: null };
  }

  async revokeSessions(principal: PlatformPrincipal, userId: string, input: { readonly reason: string }): Promise<PlatformUserSessionsRevocationView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REVOKE_USER_SESSIONS', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const reason = await this.validatedReason(principal, 'REVOKE_USER_SESSIONS', 'IDENTITY_ACCOUNT', userId, input.reason);
    const at = this.now();
    const result = await this.repository.revokeUserSessionsWithAudit({
      userId, at,
      buildSuccessAudit: counts => this.platform.buildAuditRecord({
        actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'REVOKE_USER_SESSIONS',
        permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
        detail: {
          justification: reason,
          revokedSessions: counts.workspaceSessions + counts.platformSessions,
          revokedWorkspaceSessions: counts.workspaceSessions,
          revokedPlatformSessions: counts.platformSessions,
        },
      }),
    });
    if (result.outcome === 'NOT_FOUND') {
      await this.denied(principal, 'REVOKE_USER_SESSIONS', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    return {
      userId,
      revokedSessions: result.revoked,
      revokedWorkspaceSessions: result.revokedWorkspaceSessions,
      revokedPlatformSessions: result.revokedPlatformSessions,
      revokedAt: at.toISOString(),
    };
  }

  async capabilities(principal: PlatformPrincipal): Promise<AccountCapabilities> {
    await this.platform.requireAnyPermission(principal, readActivityPermissions, { action: 'READ_ACCOUNT_CAPABILITIES', targetType: 'ACCOUNT_LIFECYCLE' });
    const configured = this.email.status === 'CONFIGURED';
    const reason = configured ? 'ACCOUNT_LIFECYCLE_FLOW_NOT_IMPLEMENTED' : (this.email.reason ?? 'EMAIL_TRANSPORT_NOT_CONFIGURED');
    const features = accountFeatures.map(feature => ({ feature, status: 'BLOCKED' as const, reason }));
    await this.platform.recordAudit({
      actor: principal, targetType: 'ACCOUNT_LIFECYCLE', action: 'READ_ACCOUNT_CAPABILITIES',
      permission: readActivityPermissions.join('|'), outcome: 'SUCCESS', detail: { emailTransport: this.email.status },
    });
    return {
      emailTransport: this.email.status,
      features,
      note: 'No email is sent while the transport is not configured and no invitation, verification or recovery flow is implemented: these features stay explicitly blocked.',
    };
  }

  async requestInvitation(principal: PlatformPrincipal, input: { readonly email: string; readonly reason: string }): Promise<never> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REQUEST_INVITATION', targetType: 'INVITATION' });
    const reason = await this.validatedReason(principal, 'REQUEST_INVITATION', 'INVITATION', null, input.reason);
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      await this.denied(principal, 'REQUEST_INVITATION', null, 'INVALID_EMAIL');
      throw new DomainError('INVALID_INPUT', 'A valid email address is required');
    }
    return this.blocked(principal, 'REQUEST_INVITATION', 'INVITATION', null, { invitedEmail: email, justification: reason });
  }

  async requestEmailVerification(principal: PlatformPrincipal, userId: string, input: { readonly reason: string }): Promise<never> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REQUEST_EMAIL_VERIFICATION', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const reason = await this.validatedReason(principal, 'REQUEST_EMAIL_VERIFICATION', 'IDENTITY_ACCOUNT', userId, input.reason);
    const user = await this.repository.findUser(userId);
    if (!user) {
      await this.denied(principal, 'REQUEST_EMAIL_VERIFICATION', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    return this.blocked(principal, 'REQUEST_EMAIL_VERIFICATION', 'IDENTITY_ACCOUNT', userId, { justification: reason });
  }

  async requestAccountRecovery(principal: PlatformPrincipal, userId: string, input: { readonly reason: string }): Promise<never> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REQUEST_ACCOUNT_RECOVERY', targetType: 'IDENTITY_ACCOUNT', targetId: userId });
    const reason = await this.validatedReason(principal, 'REQUEST_ACCOUNT_RECOVERY', 'IDENTITY_ACCOUNT', userId, input.reason);
    const user = await this.repository.findUser(userId);
    if (!user) {
      await this.denied(principal, 'REQUEST_ACCOUNT_RECOVERY', userId, 'USER_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    return this.blocked(principal, 'REQUEST_ACCOUNT_RECOVERY', 'IDENTITY_ACCOUNT', userId, { justification: reason });
  }

  /** Controller hook re-exported so route validation stays audited with the same rules. */
  recordInputRejection(principal: PlatformPrincipal | undefined, context: PlatformPermissionContext): Promise<void> {
    return this.platform.recordInputRejection(principal, context);
  }

  private async blocked(
    principal: PlatformPrincipal,
    action: string,
    targetType: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<never> {
    const reason = this.email.status === 'CONFIGURED' ? 'ACCOUNT_LIFECYCLE_FLOW_NOT_IMPLEMENTED' : (this.email.reason ?? 'EMAIL_TRANSPORT_NOT_CONFIGURED');
    await this.platform.recordAudit({
      actor: principal, targetType, targetId, action, permission: 'ADMINISTRATION',
      outcome: 'DENIED', reason, detail,
    });
    throw new DomainError('NOT_CONFIGURED', 'Blocked: ' + reason + '. No email was sent and no account state was changed.');
  }

  private async validatedReason(
    principal: PlatformPrincipal,
    action: string,
    targetType: string,
    targetId: string | null,
    value: string,
  ): Promise<string> {
    try {
      return requiredReason(value);
    } catch (error: unknown) {
      await this.platform.recordAudit({
        actor: principal, targetType, targetId, action,
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
    permission = 'ADMINISTRATION|SUPPORT',
  ): Promise<void> {
    await this.platform.recordAudit({
      actor: principal, targetType: 'IDENTITY_ACCOUNT', targetId, action,
      permission, outcome: 'DENIED', reason,
    });
  }
}
