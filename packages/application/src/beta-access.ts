import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, type ID, type PlatformPermission, type PlatformPrincipal, type Principal } from '@qeynox/domain';
import { effectiveBetaStatus, type BetaAccessStore, type BetaGrantEventRow, type BetaGrantRow, type BetaGrantStatus } from '@qeynox/persistence';
import type { PlatformAdminService, PlatformPermissionContext } from './platform-admin';

/**
 * MISSION A21.02 — invite-only beta access.
 *
 * - Grants are scoped to an existing identity workspace (identity_workspaces); no second account,
 *   organisation or authentication model exists.
 * - Only a platform operator holding ADMINISTRATION may create or revoke a grant. Reads require
 *   ADMINISTRATION or SUPPORT. Every decision — including every denial — is written to
 *   platform_admin_audit; successful mutations commit with their audit row and a beta ledger event.
 * - Self-grant is impossible: an operator who created the workspace or holds ANY membership row in
 *   it is refused, and the operator who issued a grant can never activate it.
 * - Activation is done by an ACTIVE OWNER/ADMIN of the grant's own workspace with the single-use
 *   invitation token (only its SHA-256 digest is stored). The workspace always comes from the
 *   verified session, never from the request body.
 * - Eligibility is enforced server-side at launch (OperationExecutionService.start, retry, redo) and
 *   at every provider-spend reservation (BudgetService.reserve), under a row lock on the grant.
 */
export const BETA_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BETA_MIN_LIFETIME_MS = 5 * 60 * 1000;
export const BETA_MAX_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;
const readPermissions: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];
const targetType = 'BETA_GRANT';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface BetaGrantView {
  readonly grantId: string;
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  readonly status: BetaGrantStatus;
  readonly storedStatus: BetaGrantStatus;
  readonly expiresAt: string;
  readonly invitationExpiresAt: string | null;
  readonly missionQuota: number;
  readonly missionsUsed: number;
  readonly missionsRemaining: number;
  readonly concurrentLimit: number;
  readonly maxProviderSpendMinor: number;
  readonly reservedMinor: number;
  readonly spentMinor: number;
  readonly spendRemainingMinor: number;
  readonly currency: string;
  readonly grantedBy: string;
  readonly grantedByEmail: string | null;
  readonly grantReason: string;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly activatedBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}
export interface BetaGrantEventView {
  readonly eventId: string;
  readonly kind: string;
  readonly actorUserId: string | null;
  readonly operationId: string | null;
  readonly reservationId: string | null;
  readonly amountMinor: number | null;
  readonly reason: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly occurredAt: string;
}
export interface BetaGrantDetailView { readonly grant: BetaGrantView; readonly events: readonly BetaGrantEventView[]; readonly activeMissions: number }
export interface BetaGrantPage { readonly items: readonly BetaGrantView[]; readonly limit: number }
export interface BetaGrantCreatedView {
  readonly grant: BetaGrantView;
  /** Returned exactly once; only its SHA-256 digest is stored. */
  readonly invitationToken: string;
  readonly delivery: { readonly email: 'BLOCKED'; readonly reason: 'MANUAL_DELIVERY_REQUIRED' };
}
export interface BetaGrantInput {
  readonly workspaceId: string;
  readonly expiresAt: string;
  readonly missionQuota: number;
  readonly concurrentLimit: number;
  readonly maxProviderSpendMinor: number;
  readonly currency: string;
  readonly reason: string;
}
export interface WorkspaceBetaStatusView {
  readonly workspaceId: string;
  readonly eligible: boolean;
  readonly blocker: string | null;
  readonly activeMissions: number;
  readonly grant: null | {
    readonly grantId: string;
    readonly status: BetaGrantStatus;
    readonly expiresAt: string;
    readonly invitationExpiresAt: string | null;
    readonly missionQuota: number;
    readonly missionsUsed: number;
    readonly missionsRemaining: number;
    readonly concurrentLimit: number;
    readonly maxProviderSpendMinor: number;
    readonly reservedMinor: number;
    readonly spentMinor: number;
    readonly spendRemainingMinor: number;
    readonly currency: string;
    readonly activatedAt: string | null;
  };
}

function iso(value: Date | null): string | null { return value === null ? null : value.toISOString(); }
export function hashBetaInvitationToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export function betaGrantView(row: BetaGrantRow & { workspaceName?: string | null; grantedByEmail?: string | null }, now: Date): BetaGrantView {
  return {
    grantId: row.id, workspaceId: row.workspaceId, workspaceName: row.workspaceName ?? null,
    status: effectiveBetaStatus(row, now), storedStatus: row.status,
    expiresAt: row.expiresAt.toISOString(), invitationExpiresAt: row.status === 'INVITED' ? iso(row.invitationExpiresAt) : null,
    missionQuota: row.missionQuota, missionsUsed: row.missionsUsed, missionsRemaining: Math.max(0, row.missionQuota - row.missionsUsed),
    concurrentLimit: row.concurrentLimit, maxProviderSpendMinor: row.maxProviderSpendMinor,
    reservedMinor: row.reservedMinor, spentMinor: row.spentMinor,
    spendRemainingMinor: Math.max(0, row.maxProviderSpendMinor - row.reservedMinor - row.spentMinor),
    currency: row.currency, grantedBy: row.grantedBy, grantedByEmail: row.grantedByEmail ?? null, grantReason: row.grantReason,
    createdAt: row.createdAt.toISOString(), activatedAt: iso(row.activatedAt), activatedBy: row.activatedBy,
    revokedAt: iso(row.revokedAt), revokedBy: row.revokedBy, revokeReason: row.revokeReason,
  };
}

function eventView(row: BetaGrantEventRow): BetaGrantEventView {
  return {
    eventId: row.id, kind: row.kind, actorUserId: row.actorUserId, operationId: row.operationId, reservationId: row.reservationId,
    amountMinor: row.amountMinor, reason: row.reason, detail: row.detail ?? null, occurredAt: row.occurredAt.toISOString(),
  };
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export interface PlatformBetaAccessOptions {
  readonly now?: () => Date;
  readonly generateToken?: () => string;
}

/** Operator-side management of beta grants (platform routes). */
export class PlatformBetaAccessService {
  private readonly now: () => Date;
  private readonly generateToken: () => string;
  constructor(
    private readonly store: BetaAccessStore,
    private readonly platform: PlatformAdminService,
    options: PlatformBetaAccessOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async list(principal: PlatformPrincipal, input: { workspaceId?: string | undefined; status?: BetaGrantStatus | undefined; limit?: number | undefined }): Promise<BetaGrantPage> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'LIST_BETA_GRANTS', targetType, targetId: input.workspaceId ?? null });
    const limit = integerIn(input.limit, 1, 100) ? input.limit : 50;
    const now = this.now();
    // Stored ACTIVE/INVITED rows may be time-expired, so filtering happens on the EFFECTIVE status.
    const stored: BetaGrantStatus[] | undefined = input.status === undefined ? undefined
      : input.status === 'EXPIRED' ? ['INVITED', 'ACTIVE', 'EXPIRED'] : [input.status];
    const rows = await this.store.listGrants({ workspaceId: input.workspaceId, statuses: stored, limit: input.status === undefined ? limit : 100 });
    const items = rows.map(row => betaGrantView(row, now)).filter(view => input.status === undefined || view.status === input.status).slice(0, limit);
    return { items, limit };
  }

  async get(principal: PlatformPrincipal, grantId: string): Promise<BetaGrantDetailView> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'READ_BETA_GRANT', targetType, targetId: grantId });
    const [row] = await this.store.listGrants({ grantId, limit: 1 });
    if (!row) throw new DomainError('NOT_FOUND', 'Beta grant not found');
    const events = await this.store.listEvents({ grantId, limit: 100 });
    const activeMissions = await this.store.countActiveOperations(row.workspaceId);
    return { grant: betaGrantView(row, this.now()), events: events.map(eventView), activeMissions };
  }

  async grant(principal: PlatformPrincipal, input: BetaGrantInput): Promise<BetaGrantCreatedView> {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'GRANT_BETA_ACCESS', targetType, targetId: workspaceId || null });
    const now = this.now();
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 10 || reason.length > 500) {
      await this.denied(principal, 'GRANT_BETA_ACCESS', workspaceId || null, 'INVALID_JUSTIFICATION');
      throw new DomainError('INVALID_INPUT', 'A justification of 10-500 characters is required');
    }
    const expiresAt = new Date(input.expiresAt);
    const lifetime = expiresAt.getTime() - now.getTime();
    const limitsValid = !Number.isNaN(expiresAt.getTime()) && lifetime >= BETA_MIN_LIFETIME_MS && lifetime <= BETA_MAX_LIFETIME_MS
      && integerIn(input.missionQuota, 1, 10_000) && integerIn(input.concurrentLimit, 1, 100)
      && integerIn(input.maxProviderSpendMinor, 0, 100_000_000) && typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency);
    if (!limitsValid) {
      await this.denied(principal, 'GRANT_BETA_ACCESS', workspaceId || null, 'INVALID_LIMITS');
      throw new DomainError('INVALID_INPUT', 'Expiry must be 5 minutes to 366 days ahead; quota 1-10000, concurrency 1-100, spend cap 0-100000000 minor units, ISO currency');
    }
    const workspace = await this.store.findWorkspace(workspaceId);
    if (!workspace) {
      await this.denied(principal, 'GRANT_BETA_ACCESS', workspaceId || null, 'WORKSPACE_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Workspace not found');
    }
    // No self-grant: an operator tied to the workspace (creator or any membership row, whatever its
    // role or status) can never grant it beta access.
    if (workspace.createdBy === principal.userId || await this.store.hasAnyMembership(workspace.id, principal.userId)) {
      await this.denied(principal, 'GRANT_BETA_ACCESS', workspace.id, 'SELF_GRANT_FORBIDDEN');
      throw new DomainError('DENIED', 'An operator cannot grant beta access to a workspace they belong to');
    }
    const token = this.generateToken();
    if (!tokenPattern.test(token)) throw new DomainError('INVALID_STATE', 'Generated invitation token is malformed');
    const grantId = randomUUID();
    const invitationExpiresAt = new Date(Math.min(now.getTime() + BETA_INVITATION_TTL_MS, expiresAt.getTime()));
    const audit = this.platform.buildAuditRecord({
      actor: principal, targetType, targetId: grantId, action: 'GRANT_BETA_ACCESS', permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
      detail: {
        workspaceId: workspace.id, expiresAt: expiresAt.toISOString(), missionQuota: input.missionQuota, concurrentLimit: input.concurrentLimit,
        maxProviderSpendMinor: input.maxProviderSpendMinor, currency: input.currency,
      },
    });
    const result = await this.store.createGrant({
      id: grantId, workspaceId: workspace.id, expiresAt, missionQuota: input.missionQuota, concurrentLimit: input.concurrentLimit,
      maxProviderSpendMinor: input.maxProviderSpendMinor, currency: input.currency, invitationTokenHash: hashBetaInvitationToken(token),
      invitationExpiresAt, grantedBy: principal.userId, grantReason: reason, createdAt: now,
    }, audit);
    if (result.outcome === 'CONFLICT') {
      await this.denied(principal, 'GRANT_BETA_ACCESS', workspace.id, 'LIVE_GRANT_EXISTS', { existingGrantId: result.existingGrantId });
      throw new DomainError('CONFLICT', 'The workspace already has a live beta grant; revoke it first');
    }
    return {
      grant: betaGrantView({ ...result.grant, workspaceName: workspace.name }, now),
      invitationToken: token,
      delivery: { email: 'BLOCKED', reason: 'MANUAL_DELIVERY_REQUIRED' },
    };
  }

  async revoke(principal: PlatformPrincipal, grantId: string, reasonInput: string): Promise<BetaGrantView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REVOKE_BETA_ACCESS', targetType, targetId: grantId });
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 10 || reason.length > 500) {
      await this.denied(principal, 'REVOKE_BETA_ACCESS', grantId, 'INVALID_JUSTIFICATION');
      throw new DomainError('INVALID_INPUT', 'A justification of 10-500 characters is required');
    }
    const now = this.now();
    const result = await this.store.revokeGrant({
      grantId, actorUserId: principal.userId, reason, at: now,
      buildAudit: grant => this.platform.buildAuditRecord({
        actor: principal, targetType, targetId: grant.id, action: 'REVOKE_BETA_ACCESS', permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
        detail: { workspaceId: grant.workspaceId, missionsUsed: grant.missionsUsed, spentMinor: grant.spentMinor, reservedMinor: grant.reservedMinor },
      }),
    });
    if (result.outcome === 'NOT_FOUND') {
      await this.denied(principal, 'REVOKE_BETA_ACCESS', grantId, 'GRANT_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Beta grant not found');
    }
    if (result.outcome === 'ALREADY_REVOKED') {
      await this.denied(principal, 'REVOKE_BETA_ACCESS', grantId, 'ALREADY_REVOKED');
      throw new DomainError('CONFLICT', 'Beta grant is already revoked');
    }
    return betaGrantView(result.grant, now);
  }

  recordInputRejection(principal: PlatformPrincipal | undefined, context: PlatformPermissionContext): Promise<void> {
    return this.platform.recordInputRejection(principal, context);
  }

  private async denied(principal: PlatformPrincipal, action: string, targetId: string | null, reason: string, detail?: Record<string, unknown>): Promise<void> {
    await this.platform.recordAudit({ actor: principal, targetType, targetId, action, permission: 'ADMINISTRATION', outcome: 'DENIED', reason, detail: detail ?? null });
  }
}

/** Customer-side status and activation (workspace routes; workspace derived from the session). */
export class WorkspaceBetaAccessService {
  private readonly now: () => Date;
  constructor(private readonly store: BetaAccessStore, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async status(principal: Principal): Promise<WorkspaceBetaStatusView> {
    const now = this.now();
    const [row, activeMissions] = await Promise.all([
      this.store.latestGrantForWorkspace(principal.workspaceId),
      this.store.countActiveOperations(principal.workspaceId),
    ]);
    if (!row) return { workspaceId: principal.workspaceId, eligible: false, blocker: 'NO_GRANT', activeMissions, grant: null };
    const view = betaGrantView(row, now);
    let blocker: string | null = null;
    if (view.status === 'INVITED') blocker = 'GRANT_NOT_ACTIVATED';
    else if (view.status === 'EXPIRED') blocker = 'GRANT_EXPIRED';
    else if (view.status === 'REVOKED') blocker = 'GRANT_REVOKED';
    else if (activeMissions >= view.concurrentLimit) blocker = 'CONCURRENT_LIMIT_REACHED';
    else if (view.missionsRemaining <= 0) blocker = 'MISSION_QUOTA_REACHED';
    return {
      workspaceId: principal.workspaceId, eligible: blocker === null, blocker, activeMissions,
      grant: {
        grantId: view.grantId, status: view.status, expiresAt: view.expiresAt, invitationExpiresAt: view.invitationExpiresAt,
        missionQuota: view.missionQuota, missionsUsed: view.missionsUsed, missionsRemaining: view.missionsRemaining,
        concurrentLimit: view.concurrentLimit, maxProviderSpendMinor: view.maxProviderSpendMinor, reservedMinor: view.reservedMinor,
        spentMinor: view.spentMinor, spendRemainingMinor: view.spendRemainingMinor, currency: view.currency, activatedAt: view.activatedAt,
      },
    };
  }

  async activate(principal: Principal, token: string): Promise<WorkspaceBetaStatusView> {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new DomainError('INVALID_INPUT', 'Invitation token is malformed');
    const role = principal.roles.length === 1 ? principal.roles[0]! : '';
    const result = await this.store.activate({ tokenHash: hashBetaInvitationToken(token), workspaceId: principal.workspaceId, userId: principal.userId, role, at: this.now() });
    if (result.outcome === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'Beta invitation not found');
    if (result.outcome === 'DENIED') {
      // A token from another workspace is answered exactly like an unknown token (no disclosure).
      if (result.reason === 'WRONG_WORKSPACE') throw new DomainError('NOT_FOUND', 'Beta invitation not found');
      if (result.reason === 'ROLE_REQUIRED') throw new DomainError('DENIED', 'Only a workspace OWNER or ADMIN can activate beta access');
      if (result.reason === 'SELF_ACTIVATION') throw new DomainError('DENIED', 'The issuing operator cannot activate their own grant');
      throw new DomainError('INVALID_STATE', 'Beta invitation can no longer be activated: ' + result.reason);
    }
    return this.status(principal);
  }
}

/** Launch-path helper: records a beta denial after the denied transaction rolled back, then rethrows. */
export async function withBetaDenialLedger<T>(
  store: BetaAccessStore,
  context: { workspaceId: ID; actorUserId: ID; operationId: ID; kind: 'LAUNCH_DENIED' | 'SPEND_DENIED'; amountMinor?: number },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && (error.code === 'BETA_ACCESS_REQUIRED' || error.code === 'BETA_LIMIT_REACHED')) {
      await store.recordDenial({
        workspaceId: context.workspaceId, grantId: error.context?.grantId ?? null, kind: context.kind, actorUserId: context.actorUserId,
        operationId: context.operationId, reason: error.context?.reason ?? error.code, amountMinor: context.amountMinor, at: new Date(),
      });
    }
    throw error;
  }
}
