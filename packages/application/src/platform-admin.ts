import { randomUUID } from 'node:crypto';
import {
  DomainError,
  PLATFORM_ROLES,
  hasAnyPlatformPermission,
  hasPlatformPermission,
  isPlatformRole,
  platformPermissionsForRoles,
  type ID,
  type PlatformPermission,
  type PlatformPrincipal,
  type PlatformRole,
} from '@qeynox/domain';
import type {
  PlatformAssignmentRecord,
  PlatformAuditOutcome,
  PlatformAuditRecord,
  PlatformOperationRuntime,
  PlatformOperationSummary,
  PlatformRevokeOutcome,
  PlatformSessionRecord,
} from '@qeynox/persistence';

export interface PlatformRevokeGuardInput {
  readonly assignmentId: string;
  readonly role: PlatformRole;
  readonly targetUserId: string;
  readonly revokedBy: string;
  readonly reason: string;
  readonly at: Date;
  readonly successAudit: PlatformAuditRecord;
}

/**
 * Persistence port for global platform administration. It exposes no workspace-membership
 * operation on purpose: platform authorization must never be derived from an
 * identity_memberships row (OWNER / ADMIN / MEMBER).
 *
 * Mutations that change authority are transactional with their session revocation and audit row so
 * a grant/revocation cannot be committed without a trail, and the last-administrator rule is
 * enforced inside the same transaction as the revocation.
 */
export interface PlatformAdminRepository {
  findIdentityUser(userId: string): Promise<{ readonly id: string; readonly email: string; readonly disabledAt: Date | null } | undefined>;
  listActiveAssignments(userId: string): Promise<readonly PlatformAssignmentRecord[]>;
  findActiveAssignment(userId: string, role: PlatformRole): Promise<PlatformAssignmentRecord | undefined>;
  listAssignments(limit: number): Promise<readonly PlatformAssignmentRecord[]>;
  insertAudit(record: PlatformAuditRecord): Promise<void>;
  listAudit(limit: number): Promise<readonly PlatformAuditRecord[]>;
  findSessionByTokenHash(tokenHash: string): Promise<PlatformSessionRecord | undefined>;
  touchSession(id: string, at: Date): Promise<void>;
  insertSessionWithAudit(session: PlatformSessionRecord, audit: PlatformAuditRecord): Promise<void>;
  revokeSessionWithAudit(sessionId: string, at: Date, audit: PlatformAuditRecord): Promise<void>;
  assignWithAudit(assignment: PlatformAssignmentRecord, audit: PlatformAuditRecord, targetUserId: string, at: Date): Promise<'INSERTED' | 'CONFLICT'>;
  revokeAssignmentGuarded(input: PlatformRevokeGuardInput): Promise<PlatformRevokeOutcome>;
  readOperationSummary(operationId: string): Promise<PlatformOperationSummary | undefined>;
  readOperationRuntime(operationId: string): Promise<PlatformOperationRuntime | undefined>;
}

/** Credential port. The API adapts the existing identity AuthService (same scrypt credentials). */
export interface IdentityCredentialVerifier {
  verifyCredentials(email: string, password: string): Promise<{ readonly userId: ID }>;
}

/** Platform sessions are short-lived and separate from 24 h workspace sessions. */
export const PLATFORM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const defaultAuditLimit = 50;
const maximumAuditLimit = 200;
const maximumAssignmentList = 500;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

export interface PlatformLoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly userId: string;
  readonly roles: readonly PlatformRole[];
  readonly permissions: readonly PlatformPermission[];
}

export interface PlatformSessionInfo {
  readonly userId: string;
  readonly roles: readonly PlatformRole[];
  readonly permissions: readonly PlatformPermission[];
  readonly sessionExpiresAt: string;
}

export interface PlatformAssignmentView {
  readonly id: string;
  readonly userId: string;
  readonly role: PlatformRole;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly grantedBy: string;
  readonly grantReason: string;
  readonly grantedAt: string;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly revokedAt: string | null;
}

export interface PlatformAuditView {
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
  readonly happenedAt: string;
}

export interface PlatformAssignInput {
  readonly actor: PlatformPrincipal;
  readonly targetUserId: string;
  readonly role: PlatformRole;
  readonly reason: string;
}

export interface PlatformRevokeInput {
  readonly actor: PlatformPrincipal;
  readonly targetUserId: string;
  readonly role: PlatformRole;
  readonly reason: string;
}

export interface PlatformPermissionContext {
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
}

/** Generic audit entry for sibling platform services (users management, account lifecycle). */
export interface PlatformAuditEntry {
  readonly actor?: PlatformPrincipal | undefined;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly action: string;
  readonly permission?: string | null;
  readonly outcome: PlatformAuditOutcome;
  readonly reason?: string | null;
  readonly detail?: Record<string, unknown> | null;
}

export interface PlatformAccessDenial {
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly permission?: string | null;
  readonly reason: string;
}

export interface PlatformAdminServiceOptions {
  /** Injected from the API auth layer so platform tokens reuse the exact identity session hash. */
  readonly hashToken: (value: string) => string;
  readonly generateToken: () => string;
  readonly sessionTtlMs?: number;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

interface AuditInput {
  readonly actorUserId?: string | null;
  readonly actorSessionId?: string | null;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly action: string;
  readonly permission?: string | null;
  readonly outcome: PlatformAuditOutcome;
  readonly reason?: string | null;
  readonly detail?: Record<string, unknown> | null;
}

function boundedLimit(limit: number | undefined, fallback: number, maximum: number): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, maximum);
}

function requiredReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 5 || reason.length > 500) {
    throw new DomainError('INVALID_INPUT', 'Assignment reason must contain 5-500 characters');
  }
  return reason;
}

function assignmentView(record: PlatformAssignmentRecord): PlatformAssignmentView {
  return {
    id: record.id, userId: record.userId, role: record.role, status: record.status,
    grantedBy: record.grantedBy, grantReason: record.grantReason, grantedAt: record.grantedAt.toISOString(),
    revokedBy: record.revokedBy, revokeReason: record.revokeReason,
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
  };
}

function auditView(record: PlatformAuditRecord): PlatformAuditView {
  return {
    id: record.id, actorUserId: record.actorUserId, actorSessionId: record.actorSessionId,
    targetType: record.targetType, targetId: record.targetId, action: record.action,
    permission: record.permission, outcome: record.outcome, reason: record.reason,
    detail: record.detail, happenedAt: record.happenedAt.toISOString(),
  };
}

/**
 * Global QeyNox administration.
 *
 * Authorization facts:
 * - a platform principal is built only from platform_admin_sessions + platform_admin_assignments;
 * - workspace roles (identity_memberships) are never read by this service or its port;
 * - every route-level denial, validation rejection and successful action is written to
 *   platform_admin_audit with actor, target, action, permission, date and outcome;
 * - the last active PLATFORM_ADMIN cannot be revoked, enforced inside the revocation transaction;
 * - authorization-changing mutations and their audit row commit atomically.
 */
export class PlatformAdminService {
  private readonly hashToken: (value: string) => string;
  private readonly generateToken: () => string;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly credentials: IdentityCredentialVerifier,
    options: PlatformAdminServiceOptions,
  ) {
    this.hashToken = options.hashToken;
    this.generateToken = options.generateToken;
    this.sessionTtlMs = options.sessionTtlMs ?? PLATFORM_SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => randomUUID());
  }

  async login(input: { readonly email: string; readonly password: string }): Promise<PlatformLoginResult> {
    let userId: ID;
    try {
      const verified = await this.credentials.verifyCredentials(input.email, input.password);
      userId = verified.userId;
    } catch (error: unknown) {
      await this.writeAudit({
        action: 'LOGIN', targetType: 'IDENTITY_ACCOUNT', outcome: 'DENIED',
        reason: error instanceof DomainError ? error.code : 'CREDENTIALS_REJECTED',
      });
      throw error instanceof DomainError ? error : new DomainError('DENIED', 'Platform sign-in rejected');
    }
    const user = await this.repository.findIdentityUser(userId);
    if (!user || user.disabledAt) {
      await this.writeAudit({ actorUserId: userId, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'LOGIN', outcome: 'DENIED', reason: 'ACCOUNT_DISABLED' });
      throw new DomainError('DENIED', 'Platform sign-in rejected');
    }
    const roles = await this.activeRoles(userId);
    if (!roles.length) {
      await this.writeAudit({ actorUserId: userId, targetType: 'IDENTITY_ACCOUNT', targetId: userId, action: 'LOGIN', outcome: 'DENIED', reason: 'NO_ACTIVE_PLATFORM_ASSIGNMENT' });
      throw new DomainError('DENIED', 'Platform sign-in rejected');
    }
    const token = this.generateToken();
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.sessionTtlMs);
    const sessionId = this.generateId();
    const session: PlatformSessionRecord = {
      id: sessionId, userId, tokenHash: this.hashToken(token), expiresAt,
      revokedAt: null, createdAt: issuedAt, lastUsedAt: null,
    };
    const audit = this.auditRecord({
      actorUserId: userId, actorSessionId: sessionId, targetType: 'PLATFORM_SESSION',
      targetId: sessionId, action: 'LOGIN', outcome: 'SUCCESS',
    });
    try {
      await this.repository.insertSessionWithAudit(session, audit);
    } catch (error: unknown) {
      await this.auditFailure('LOGIN', 'PLATFORM_SESSION', sessionId, { userId });
      throw error;
    }
    return { token, expiresAt: expiresAt.toISOString(), userId, roles, permissions: platformPermissionsForRoles(roles) };
  }

  async authenticate(rawToken: string | undefined): Promise<PlatformPrincipal> {
    if (typeof rawToken !== 'string' || !tokenPattern.test(rawToken)) {
      await this.writeAudit({ action: 'AUTHENTICATE', targetType: 'PLATFORM_SESSION', outcome: 'DENIED', reason: 'MALFORMED_SESSION_TOKEN' });
      throw new DomainError('DENIED', 'Platform bearer session required');
    }
    const session = await this.repository.findSessionByTokenHash(this.hashToken(rawToken));
    const at = this.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= at.getTime()) {
      const reason = !session ? 'UNKNOWN_SESSION' : session.revokedAt ? 'REVOKED_SESSION' : 'EXPIRED_SESSION';
      await this.writeAudit({ action: 'AUTHENTICATE', targetType: 'PLATFORM_SESSION', outcome: 'DENIED', reason });
      throw new DomainError('DENIED', 'Platform session expired or revoked');
    }
    const user = await this.repository.findIdentityUser(session.userId);
    if (!user || user.disabledAt) {
      await this.writeAudit({ actorUserId: session.userId, actorSessionId: session.id, targetType: 'IDENTITY_ACCOUNT', targetId: session.userId, action: 'AUTHENTICATE', outcome: 'DENIED', reason: 'ACCOUNT_DISABLED' });
      throw new DomainError('DENIED', 'Platform account is not available');
    }
    const roles = await this.activeRoles(session.userId);
    if (!roles.length) {
      await this.writeAudit({ actorUserId: session.userId, actorSessionId: session.id, targetType: 'IDENTITY_ACCOUNT', targetId: session.userId, action: 'AUTHENTICATE', outcome: 'DENIED', reason: 'NO_ACTIVE_PLATFORM_ASSIGNMENT' });
      throw new DomainError('DENIED', 'Platform session expired or revoked');
    }
    await this.repository.touchSession(session.id, at);
    return {
      userId: session.userId as ID,
      sessionId: session.id,
      roles,
      permissions: platformPermissionsForRoles(roles),
      sessionExpiresAt: session.expiresAt.toISOString(),
    };
  }

  async logout(principal: PlatformPrincipal): Promise<{ readonly revoked: true }> {
    const at = this.now();
    const audit = this.auditRecord({
      actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: 'PLATFORM_SESSION',
      targetId: principal.sessionId, action: 'LOGOUT', outcome: 'SUCCESS',
    });
    try {
      await this.repository.revokeSessionWithAudit(principal.sessionId, at, audit);
    } catch (error: unknown) {
      await this.auditFailure('LOGOUT', 'PLATFORM_SESSION', principal.sessionId, { userId: principal.userId });
      throw error;
    }
    return { revoked: true };
  }

  me(principal: PlatformPrincipal): PlatformSessionInfo {
    return {
      userId: principal.userId, roles: principal.roles,
      permissions: principal.permissions, sessionExpiresAt: principal.sessionExpiresAt,
    };
  }

  /** Route-level guard hook. Writes the DENIED audit row before throwing. */
  async requirePermission(principal: PlatformPrincipal, permission: PlatformPermission, context: PlatformPermissionContext): Promise<void> {
    if (hasPlatformPermission(principal, permission)) return;
    await this.writeAudit({
      actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: context.targetType,
      targetId: context.targetId ?? null, action: context.action, permission, outcome: 'DENIED', reason: 'PERMISSION_DENIED',
    });
    throw new DomainError('DENIED', 'Platform permission required: ' + permission);
  }

  /** Any-of variant used by routes that accept several platform permissions (users management). */
  async requireAnyPermission(principal: PlatformPrincipal, permissions: readonly PlatformPermission[], context: PlatformPermissionContext): Promise<void> {
    if (permissions.length === 0) throw new DomainError('DENIED', 'Platform permission required: empty permission list');
    if (hasAnyPlatformPermission(principal, permissions)) return;
    await this.writeAudit({
      actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: context.targetType,
      targetId: context.targetId ?? null, action: context.action, permission: permissions.join('|'),
      outcome: 'DENIED', reason: 'PERMISSION_DENIED',
    });
    throw new DomainError('DENIED', 'Platform permission required: one of ' + permissions.join(', '));
  }

  /** Builds an audit record so a sibling service can commit it in the same transaction as its mutation. */
  buildAuditRecord(entry: PlatformAuditEntry): PlatformAuditRecord {
    return this.auditRecord({
      actorUserId: entry.actor?.userId ?? null, actorSessionId: entry.actor?.sessionId ?? null,
      targetType: entry.targetType, targetId: entry.targetId ?? null, action: entry.action,
      permission: entry.permission ?? null, outcome: entry.outcome, reason: entry.reason ?? null,
      detail: entry.detail ?? null,
    });
  }

  /** Sibling platform services (users management) write their auditable outcomes through here. */
  async recordAudit(entry: PlatformAuditEntry): Promise<void> {
    await this.writeAudit({
      actorUserId: entry.actor?.userId ?? null, actorSessionId: entry.actor?.sessionId ?? null,
      targetType: entry.targetType, targetId: entry.targetId ?? null, action: entry.action,
      permission: entry.permission ?? null, outcome: entry.outcome, reason: entry.reason ?? null,
      detail: entry.detail ?? null,
    });
  }

  /**
   * Guard hook for denials decided before a principal exists (missing/malformed session, bad
   * policy). Best effort on purpose: an audit outage must never turn a deny decision into a 5xx
   * success path, so the denial is still enforced.
   */
  async recordAccessDenial(denial: PlatformAccessDenial): Promise<void> {
    try {
      await this.writeAudit({
        targetType: denial.targetType, targetId: denial.targetId ?? null, action: denial.action,
        permission: denial.permission ?? null, outcome: 'DENIED', reason: denial.reason,
      });
    } catch {
      // Best effort: the access decision below is authoritative.
    }
  }

  /** Controller hook for a body/query rejected by schema validation after authentication. */
  async recordInputRejection(principal: PlatformPrincipal | undefined, context: PlatformPermissionContext): Promise<void> {
    try {
      await this.writeAudit({
        actorUserId: principal?.userId ?? null, actorSessionId: principal?.sessionId ?? null,
        targetType: context.targetType, targetId: context.targetId ?? null,
        action: context.action, outcome: 'DENIED', reason: 'INVALID_INPUT',
      });
    } catch {
      // Best effort: schema validation still answers 400 INVALID_INPUT.
    }
  }

  async listAssignments(principal: PlatformPrincipal): Promise<readonly PlatformAssignmentView[]> {
    await this.requirePermission(principal, 'CONSULTATION', { action: 'LIST_PLATFORM_ASSIGNMENTS', targetType: 'PLATFORM_ASSIGNMENT' });
    const rows = await this.repository.listAssignments(maximumAssignmentList);
    await this.writeAudit({
      actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: 'PLATFORM_ASSIGNMENT',
      action: 'LIST_PLATFORM_ASSIGNMENTS', permission: 'CONSULTATION', outcome: 'SUCCESS',
    });
    return rows.map(assignmentView);
  }

  async assign(input: PlatformAssignInput): Promise<PlatformAssignmentView> {
    const { actor } = input;
    await this.requirePermission(actor, 'ADMINISTRATION', { action: 'ASSIGN_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT', targetId: input.targetUserId });
    if (!isPlatformRole(input.role)) {
      await this.denied('ASSIGN_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', input.targetUserId, 'ADMINISTRATION', 'INVALID_PLATFORM_ROLE', actor, { role: String(input.role), targetUserId: input.targetUserId });
      throw new DomainError('INVALID_INPUT', 'Unknown platform role');
    }
    const reason = requiredReason(input.reason);
    const user = await this.repository.findIdentityUser(input.targetUserId);
    if (!user) {
      await this.denied('ASSIGN_PLATFORM_ROLE', 'IDENTITY_ACCOUNT', input.targetUserId, 'ADMINISTRATION', 'UNKNOWN_IDENTITY_USER', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('NOT_FOUND', 'Identity user not found');
    }
    if (user.disabledAt) {
      await this.denied('ASSIGN_PLATFORM_ROLE', 'IDENTITY_ACCOUNT', input.targetUserId, 'ADMINISTRATION', 'ACCOUNT_DISABLED', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('DENIED', 'Identity account is disabled');
    }
    const existing = await this.repository.findActiveAssignment(input.targetUserId, input.role);
    if (existing) {
      await this.denied('ASSIGN_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', existing.id, 'ADMINISTRATION', 'ALREADY_ASSIGNED', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('CONFLICT', 'Platform role is already assigned');
    }
    const grantedAt = this.now();
    const record: PlatformAssignmentRecord = {
      id: this.generateId(), userId: input.targetUserId, role: input.role, status: 'ACTIVE',
      grantedBy: actor.userId, grantReason: reason, grantedAt,
      revokedBy: null, revokeReason: null, revokedAt: null,
    };
    const audit = this.auditRecord({
      actorUserId: actor.userId, actorSessionId: actor.sessionId, targetType: 'PLATFORM_ASSIGNMENT',
      targetId: record.id, action: 'ASSIGN_PLATFORM_ROLE', permission: 'ADMINISTRATION', outcome: 'SUCCESS',
      detail: { role: input.role, targetUserId: input.targetUserId, grantReason: reason },
    });
    let outcome: 'INSERTED' | 'CONFLICT';
    try {
      outcome = await this.repository.assignWithAudit(record, audit, input.targetUserId, grantedAt);
    } catch (error: unknown) {
      await this.auditFailure('ASSIGN_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', record.id, { role: input.role, targetUserId: input.targetUserId });
      throw error;
    }
    if (outcome === 'CONFLICT') {
      await this.denied('ASSIGN_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', record.id, 'ADMINISTRATION', 'CONCURRENT_ASSIGNMENT', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('CONFLICT', 'Platform role is already assigned');
    }
    return assignmentView(record);
  }

  async revoke(input: PlatformRevokeInput): Promise<PlatformAssignmentView> {
    const { actor } = input;
    await this.requirePermission(actor, 'ADMINISTRATION', { action: 'REVOKE_PLATFORM_ROLE', targetType: 'PLATFORM_ASSIGNMENT', targetId: input.targetUserId });
    if (!isPlatformRole(input.role)) {
      await this.denied('REVOKE_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', input.targetUserId, 'ADMINISTRATION', 'INVALID_PLATFORM_ROLE', actor, { role: String(input.role), targetUserId: input.targetUserId });
      throw new DomainError('INVALID_INPUT', 'Unknown platform role');
    }
    const reason = requiredReason(input.reason);
    const assignment = await this.repository.findActiveAssignment(input.targetUserId, input.role);
    if (!assignment) {
      await this.denied('REVOKE_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', input.targetUserId, 'ADMINISTRATION', 'ASSIGNMENT_NOT_FOUND', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('NOT_FOUND', 'Active platform assignment not found');
    }
    const revokedAt = this.now();
    const successAudit = this.auditRecord({
      actorUserId: actor.userId, actorSessionId: actor.sessionId, targetType: 'PLATFORM_ASSIGNMENT',
      targetId: assignment.id, action: 'REVOKE_PLATFORM_ROLE', permission: 'ADMINISTRATION', outcome: 'SUCCESS',
      detail: { role: input.role, targetUserId: input.targetUserId, revokeReason: reason },
    });
    let outcome: PlatformRevokeOutcome;
    try {
      outcome = await this.repository.revokeAssignmentGuarded({
        assignmentId: assignment.id, role: input.role, targetUserId: input.targetUserId,
        revokedBy: actor.userId, reason, at: revokedAt, successAudit,
      });
    } catch (error: unknown) {
      await this.auditFailure('REVOKE_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', assignment.id, { role: input.role, targetUserId: input.targetUserId });
      throw error;
    }
    if (outcome === 'LAST_ADMIN') {
      await this.denied('REVOKE_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', assignment.id, 'ADMINISTRATION', 'LAST_PLATFORM_ADMIN', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('DENIED', 'Cannot revoke the last platform administrator');
    }
    if (outcome === 'NOT_FOUND') {
      await this.denied('REVOKE_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', assignment.id, 'ADMINISTRATION', 'ASSIGNMENT_NOT_FOUND', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('NOT_FOUND', 'Active platform assignment not found');
    }
    if (outcome === 'CONFLICT') {
      await this.denied('REVOKE_PLATFORM_ROLE', 'PLATFORM_ASSIGNMENT', assignment.id, 'ADMINISTRATION', 'CONCURRENT_ASSIGNMENT_CHANGE', actor, { role: input.role, targetUserId: input.targetUserId });
      throw new DomainError('CONFLICT', 'Platform assignment changed concurrently');
    }
    return assignmentView({ ...assignment, status: 'REVOKED', revokedBy: actor.userId, revokeReason: reason, revokedAt });
  }

  async listAudit(principal: PlatformPrincipal, limit?: number): Promise<readonly PlatformAuditView[]> {
    await this.requirePermission(principal, 'CONSULTATION', { action: 'LIST_PLATFORM_AUDIT', targetType: 'PLATFORM_AUDIT' });
    const rows = await this.repository.listAudit(boundedLimit(limit, defaultAuditLimit, maximumAuditLimit));
    await this.writeAudit({
      actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: 'PLATFORM_AUDIT',
      action: 'LIST_PLATFORM_AUDIT', permission: 'CONSULTATION', outcome: 'SUCCESS',
    });
    return rows.map(auditView);
  }

  /** Read-only cross-tenant diagnostics for customer support. No mutation, no secret, no raw prompt. */
  async readSupportOperation(principal: PlatformPrincipal, operationId: string): Promise<PlatformOperationSummary> {
    await this.requirePermission(principal, 'SUPPORT', { action: 'READ_PLATFORM_OPERATION_SUMMARY', targetType: 'OPERATION', targetId: operationId });
    const summary = await this.repository.readOperationSummary(operationId);
    if (!summary) {
      await this.denied('READ_PLATFORM_OPERATION_SUMMARY', 'OPERATION', operationId, 'SUPPORT', 'OPERATION_NOT_FOUND', principal);
      throw new DomainError('NOT_FOUND', 'Operation not found');
    }
    await this.writeAudit({ actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: 'OPERATION', targetId: operationId, action: 'READ_PLATFORM_OPERATION_SUMMARY', permission: 'SUPPORT', outcome: 'SUCCESS' });
    return summary;
  }

  /** Read-only runtime inspection for technical operations. Never replays or cancels work. */
  async readOperationRuntime(principal: PlatformPrincipal, operationId: string): Promise<PlatformOperationRuntime> {
    await this.requirePermission(principal, 'OPERATIONS', { action: 'READ_PLATFORM_OPERATION_RUNTIME', targetType: 'OPERATION', targetId: operationId });
    const runtime = await this.repository.readOperationRuntime(operationId);
    if (!runtime) {
      await this.denied('READ_PLATFORM_OPERATION_RUNTIME', 'OPERATION', operationId, 'OPERATIONS', 'OPERATION_NOT_FOUND', principal);
      throw new DomainError('NOT_FOUND', 'Operation not found');
    }
    await this.writeAudit({ actorUserId: principal.userId, actorSessionId: principal.sessionId, targetType: 'OPERATION', targetId: operationId, action: 'READ_PLATFORM_OPERATION_RUNTIME', permission: 'OPERATIONS', outcome: 'SUCCESS' });
    return runtime;
  }

  private async activeRoles(userId: string): Promise<readonly PlatformRole[]> {
    const assignments = await this.repository.listActiveAssignments(userId);
    const roles = new Set<PlatformRole>();
    for (const assignment of assignments) {
      if (!isPlatformRole(assignment.role)) throw new DomainError('INVALID_STATE', 'Stored platform role is not recognized');
      roles.add(assignment.role);
    }
    return PLATFORM_ROLES.filter(role => roles.has(role));
  }

  private auditRecord(input: AuditInput): PlatformAuditRecord {
    return {
      id: this.generateId(),
      actorUserId: input.actorUserId ?? null,
      actorSessionId: input.actorSessionId ?? null,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      action: input.action,
      permission: input.permission ?? null,
      outcome: input.outcome,
      reason: input.reason ?? null,
      detail: input.detail ?? null,
      happenedAt: this.now(),
    };
  }

  private async writeAudit(input: AuditInput): Promise<void> {
    await this.repository.insertAudit(this.auditRecord(input));
  }

  private async denied(
    action: string,
    targetType: string,
    targetId: string | null,
    permission: string,
    reason: string,
    actor: PlatformPrincipal | undefined,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.writeAudit({
      actorUserId: actor?.userId ?? null, actorSessionId: actor?.sessionId ?? null,
      targetType, targetId, action, permission, outcome: 'DENIED', reason, detail: detail ?? null,
    });
  }

  private async auditFailure(action: string, targetType: string, targetId: string | null, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.writeAudit({ action, targetType, targetId, outcome: 'ERROR', reason: 'DATABASE_ERROR', detail });
    } catch {
      // Best effort only: the database write that just failed may also prevent this audit row.
    }
  }
}
