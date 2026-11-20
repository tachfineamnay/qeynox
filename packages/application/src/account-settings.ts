import { randomUUID, createHash } from 'node:crypto';
import { DomainError, type Principal } from '@qeynox/domain';
import type { StoredDeletionStatus } from '@qeynox/persistence';

/**
 * MISSION A18 — customer account, security and privacy settings.
 *
 * Password changes reuse the caller-injected hasher (scrypt with lockout policy in the API layer);
 * sessions stay in `identity_sessions` — platform sessions live in a separate namespace and are
 * never visible or revocable here. Deletion requests are recorded intent, never executed erasure:
 * `REQUESTED` = customer asked, `CANCELLED` = withdrawn. Nothing in this module erases data.
 * Every mutation is audited (identity_audit).
 */
export interface AccountSettingsRepository {
  getProfile(userId: string): Promise<{ readonly email: string; readonly locale: string; readonly createdAt: Date; readonly verifiedAt: Date | null } | undefined>;
  updateLocale(userId: string, locale: string): Promise<void>;
  countActiveWorkspaces(userId: string): Promise<number>;
  listActiveSessions(userId: string, at: Date): Promise<readonly { readonly id: string; readonly createdAt: Date; readonly lastUsedAt: Date | null; readonly expiresAt: Date; readonly tokenHash: string }[]>;
  revokeSession(userId: string, sessionId: string, at: Date): Promise<boolean>;
  revokeOtherSessions(userId: string, keepTokenHash: string, at: Date): Promise<number>;
  getCredentials(userId: string): Promise<{ readonly salt: string; readonly passwordHash: string; readonly failedAttempts: number; readonly lockedUntil: Date | null } | undefined>;
  noteFailedPasswordAttempt(userId: string, failedAttempts: number, lockedUntil: Date | null): Promise<void>;
  setPassword(userId: string, salt: string, passwordHash: string, at: Date): Promise<void>;
  requestDeletion(userId: string, reason: string | null, at: Date): Promise<{ readonly outcome: 'REQUESTED' | 'ALREADY_REQUESTED'; readonly id: string; readonly createdAt: Date }>;
  cancelDeletion(userId: string, at: Date): Promise<'CANCELLED' | 'NOT_FOUND'>;
  latestDeletion(userId: string): Promise<{ readonly id: string; readonly reason: string | null; readonly status: StoredDeletionStatus; readonly createdAt: Date; readonly updatedAt: Date } | undefined>;
  insertIdentityAudit(input: { readonly userId: string; readonly workspaceId: string | null; readonly action: string; readonly outcome: 'SUCCESS' | 'DENIED' | 'FAILED' }): Promise<void>;
}

export interface AccountPasswordHasher {
  hash(password: string, salt?: string): Promise<{ readonly salt: string; readonly hash: string }>;
  verify(password: string, salt: string, expected: string): Promise<boolean>;
}

export interface AccountSettingsOptions { readonly now?: () => Date; readonly hasher: AccountPasswordHasher }

/** Same thresholds as sign-in (apps/api/src/auth/auth.service.ts): 6 attempts ⇒ 15-minute lock. */
const maximumFailedPasswordAttempts = 6;
const lockDurationMs = 15 * 60 * 1000;
const maximumDeletionReasonLength = 500;

export interface ProfileView {
  readonly email: string;
  readonly locale: string;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
  readonly activeWorkspaceCount: number;
}
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string;
  readonly current: boolean;
}
export interface DeletionRequestView {
  readonly id: string;
  readonly status: StoredDeletionStatus;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class AccountSettingsService {
  private readonly now: () => Date;
  private readonly hasher: AccountPasswordHasher;
  constructor(private readonly repository: AccountSettingsRepository, options: AccountSettingsOptions) {
    this.now = options.now ?? (() => new Date());
    this.hasher = options.hasher;
  }

  private requirePrincipal(principal: Principal | undefined): Principal {
    if (!principal?.userId) throw new DomainError('DENIED', 'Authenticated account required');
    return principal;
  }

  async profile(principal: Principal | undefined): Promise<ProfileView> {
    const actor = this.requirePrincipal(principal);
    const row = await this.repository.getProfile(actor.userId);
    if (!row) throw new DomainError('NOT_FOUND', 'Account not found');
    return {
      email: row.email, locale: row.locale,
      createdAt: row.createdAt.toISOString(),
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      activeWorkspaceCount: await this.repository.countActiveWorkspaces(actor.userId),
    };
  }

  async updateProfile(principal: Principal | undefined, input: { locale: string }): Promise<{ locale: string }> {
    const actor = this.requirePrincipal(principal);
    const locale = (input.locale ?? '').trim();
    if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(locale)) throw new DomainError('INVALID_INPUT', 'Unsupported locale');
    await this.repository.updateLocale(actor.userId, locale);
    await this.audit(actor, 'PROFILE_LOCALE_UPDATED', 'SUCCESS');
    return { locale };
  }

  /** Lists active sessions. The caller passes the SHA-256 of the presented bearer token to mark `current`. */
  async sessions(principal: Principal | undefined, currentTokenHash: string): Promise<readonly SessionView[]> {
    const actor = this.requirePrincipal(principal);
    const rows = await this.repository.listActiveSessions(actor.userId, this.now());
    return rows.map(row => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
      current: row.tokenHash === currentTokenHash,
    }));
  }

  /** Revokes one of the account's sessions. Revoking the presented session signs this client out. */
  async revokeSession(principal: Principal | undefined, sessionId: string, currentTokenHash: string): Promise<{ revoked: true; current: boolean }> {
    const actor = this.requirePrincipal(principal);
    const rows = await this.repository.listActiveSessions(actor.userId, this.now());
    const target = rows.find(row => row.id === sessionId);
    if (!target) throw new DomainError('NOT_FOUND', 'Active session not found');
    const revoked = await this.repository.revokeSession(actor.userId, sessionId, this.now());
    if (!revoked) throw new DomainError('CONFLICT', 'Session could not be revoked');
    const isCurrent = target.tokenHash === currentTokenHash;
    await this.audit(actor, isCurrent ? 'SESSION_SELF_REVOKED' : 'SESSION_REVOKED', 'SUCCESS');
    return { revoked: true, current: isCurrent };
  }

  async revokeOtherSessions(principal: Principal | undefined, currentTokenHash: string): Promise<{ revoked: number }> {
    const actor = this.requirePrincipal(principal);
    const revoked = await this.repository.revokeOtherSessions(actor.userId, currentTokenHash, this.now());
    await this.audit(actor, 'SESSION_OTHERS_REVOKED', 'SUCCESS');
    return { revoked };
  }

  /**
   * Changes the credential after verifying the current one (same lockout policy as sign-in) and
   * revokes every other active session. The presented session stays valid.
   */
  async changePassword(principal: Principal | undefined, input: { currentPassword: string; nextPassword: string }, currentTokenHash: string): Promise<{ changed: true; revokedSessions: number }> {
    const actor = this.requirePrincipal(principal);
    const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    const nextPassword = typeof input.nextPassword === 'string' ? input.nextPassword : '';
    if (nextPassword.length < 12 || nextPassword.length > 256) throw new DomainError('INVALID_INPUT', 'Password must be 12–256 characters');
    if (currentPassword === nextPassword) throw new DomainError('INVALID_INPUT', 'The new password must differ from the current one');
    const creds = await this.repository.getCredentials(actor.userId);
    if (!creds) throw new DomainError('DENIED', 'Account credentials not found');
    if (creds.lockedUntil && creds.lockedUntil > this.now()) {
      await this.audit(actor, 'PASSWORD_CHANGE', 'DENIED');
      throw new DomainError('DENIED', 'Account is temporarily locked. Try again later.');
    }
    const ok = await this.hasher.verify(currentPassword, creds.salt, creds.passwordHash);
    if (!ok) {
      const attempts = creds.failedAttempts + 1;
      await this.repository.noteFailedPasswordAttempt(actor.userId, attempts, attempts >= maximumFailedPasswordAttempts ? new Date(this.now().getTime() + lockDurationMs) : null);
      await this.audit(actor, 'PASSWORD_CHANGE', 'DENIED');
      throw new DomainError('DENIED', 'Current password is not correct');
    }
    const next = await this.hasher.hash(nextPassword);
    await this.repository.setPassword(actor.userId, next.salt, next.hash, this.now());
    const revokedSessions = await this.repository.revokeOtherSessions(actor.userId, currentTokenHash, this.now());
    await this.audit(actor, 'PASSWORD_CHANGE', 'SUCCESS');
    return { changed: true, revokedSessions };
  }

  async deletionStatus(principal: Principal | undefined): Promise<DeletionRequestView | null> {
    const actor = this.requirePrincipal(principal);
    const row = await this.repository.latestDeletion(actor.userId);
    return row ? this.deletionView(row) : null;
  }

  /** Idempotent: a live REQUESTED row already exists ⇒ returned unchanged, never duplicated. */
  async requestDeletion(principal: Principal | undefined, input: { reason?: string | undefined }): Promise<{ request: DeletionRequestView; outcome: 'REQUESTED' | 'ALREADY_REQUESTED' }> {
    const actor = this.requirePrincipal(principal);
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, maximumDeletionReasonLength) : '';
    const result = await this.repository.requestDeletion(actor.userId, reason.length > 0 ? reason : null, this.now());
    await this.audit(actor, 'ACCOUNT_DELETION_REQUESTED', 'SUCCESS');
    const fresh = await this.repository.latestDeletion(actor.userId);
    return { outcome: result.outcome, request: this.deletionView(fresh ?? { id: result.id, reason: reason || null, status: 'REQUESTED', createdAt: result.createdAt, updatedAt: result.createdAt }) };
  }

  async cancelDeletion(principal: Principal | undefined): Promise<{ status: 'CANCELLED' }> {
    const actor = this.requirePrincipal(principal);
    const outcome = await this.repository.cancelDeletion(actor.userId, this.now());
    if (outcome === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'No pending deletion request');
    await this.audit(actor, 'ACCOUNT_DELETION_CANCELLED', 'SUCCESS');
    return { status: 'CANCELLED' };
  }

  private deletionView(row: { readonly id: string; readonly reason: string | null; readonly status: StoredDeletionStatus; readonly createdAt: Date; readonly updatedAt: Date }): DeletionRequestView {
    return { id: row.id, status: row.status, reason: row.reason, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private async audit(actor: Principal, action: string, outcome: 'SUCCESS' | 'DENIED' | 'FAILED'): Promise<void> {
    await this.repository.insertIdentityAudit({ userId: actor.userId, workspaceId: actor.workspaceId ?? null, action, outcome });
  }
}

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
