import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { QeyNoxDatabase } from './database';
import { accountDeletionRequests, type StoredDeletionStatus } from './account-schema';
import { identityAudit, identityCredentials, identitySessions, identityUsers, identityWorkspaces, identityMemberships } from './schema';
import { platformAuditValues, type PlatformAuditRecord } from './platform-admin-store';
import { platformAdminAudit } from './platform-admin-schema';

/** Tenant-side account settings store. Sessions stay in identity_sessions (never platform namespaces). */
export interface AccountProfileRow { readonly email: string; readonly locale: string; readonly createdAt: Date; readonly verifiedAt: Date | null }
export interface AccountSessionRow { readonly id: string; readonly createdAt: Date; readonly lastUsedAt: Date | null; readonly expiresAt: Date; readonly tokenHash: string }
export interface AccountDeletionRow { readonly id: string; readonly reason: string | null; readonly status: StoredDeletionStatus; readonly createdAt: Date; readonly updatedAt: Date }

export class AccountStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async getProfile(userId: string): Promise<AccountProfileRow | undefined> {
    const [row] = await this.db.select({ email: identityUsers.email, locale: identityUsers.locale, createdAt: identityUsers.createdAt, verifiedAt: identityUsers.verifiedAt })
      .from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    return row;
  }

  async updateLocale(userId: string, locale: string): Promise<void> {
    await this.db.update(identityUsers).set({ locale }).where(eq(identityUsers.id, userId));
  }

  /** Active (not revoked, not expired) sessions for the account, newest first. tokenHash stays inside the store. */
  async listActiveSessions(userId: string, at: Date): Promise<readonly AccountSessionRow[]> {
    return this.db.select({ id: identitySessions.id, createdAt: identitySessions.createdAt, lastUsedAt: identitySessions.lastUsedAt, expiresAt: identitySessions.expiresAt, tokenHash: identitySessions.tokenHash })
      .from(identitySessions)
      .where(and(eq(identitySessions.userId, userId), isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, at)))
      .orderBy(desc(identitySessions.createdAt), desc(identitySessions.id));
  }

  /** Revoke one session owned by userId. Returns whether a row was actually revoked. */
  async revokeSession(userId: string, sessionId: string, at: Date): Promise<boolean> {
    const updated = await this.db.update(identitySessions)
      .set({ revokedAt: at, lastUsedAt: at })
      .where(and(eq(identitySessions.id, sessionId), eq(identitySessions.userId, userId), isNull(identitySessions.revokedAt)))
      .returning({ id: identitySessions.id });
    return updated.length > 0;
  }

  /** Revoke every active session except the one presented now. Returns the number revoked. */
  async revokeOtherSessions(userId: string, keepTokenHash: string, at: Date): Promise<number> {
    const updated = await this.db.update(identitySessions)
      .set({ revokedAt: at })
      .where(and(eq(identitySessions.userId, userId), isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, at), sql`${identitySessions.tokenHash} <> ${keepTokenHash}`))
      .returning({ id: identitySessions.id });
    return updated.length;
  }

  async getCredentials(userId: string): Promise<{ salt: string; passwordHash: string; failedAttempts: number; lockedUntil: Date | null } | undefined> {
    const [row] = await this.db.select({ salt: identityCredentials.salt, passwordHash: identityCredentials.passwordHash, failedAttempts: identityCredentials.failedAttempts, lockedUntil: identityCredentials.lockedUntil })
      .from(identityCredentials).where(eq(identityCredentials.userId, userId)).limit(1);
    return row;
  }

  async noteFailedPasswordAttempt(userId: string, failedAttempts: number, lockedUntil: Date | null): Promise<void> {
    await this.db.update(identityCredentials).set({ failedAttempts, lockedUntil }).where(eq(identityCredentials.userId, userId));
  }

  async setPassword(userId: string, salt: string, passwordHash: string, at: Date): Promise<void> {
    await this.db.update(identityCredentials).set({ salt, passwordHash, failedAttempts: 0, lockedUntil: null, changedAt: at }).where(eq(identityCredentials.userId, userId));
  }

  async countActiveWorkspaces(userId: string): Promise<number> {
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` })
      .from(identityMemberships)
      .where(and(eq(identityMemberships.userId, userId), eq(identityMemberships.status, 'ACTIVE')));
    return row?.value ?? 0;
  }

  /** Idempotent: a live REQUESTED row already exists ⇒ returns it unchanged. */
  async requestDeletion(userId: string, reason: string | null, at: Date): Promise<{ outcome: 'REQUESTED' | 'ALREADY_REQUESTED'; id: string; createdAt: Date }> {
    return this.db.transaction(async tx => {
      const [existing] = await tx.select({ id: accountDeletionRequests.id, createdAt: accountDeletionRequests.createdAt })
        .from(accountDeletionRequests)
        .where(and(eq(accountDeletionRequests.userId, userId), eq(accountDeletionRequests.status, 'REQUESTED')))
        .for('update');
      if (existing) return { outcome: 'ALREADY_REQUESTED' as const, id: existing.id, createdAt: existing.createdAt };
      const id = randomUUID();
      await tx.insert(accountDeletionRequests).values({ id, userId, reason, status: 'REQUESTED', createdAt: at, updatedAt: at });
      return { outcome: 'REQUESTED' as const, id, createdAt: at };
    });
  }

  async cancelDeletion(userId: string, at: Date): Promise<'CANCELLED' | 'NOT_FOUND'> {
    const updated = await this.db.update(accountDeletionRequests)
      .set({ status: 'CANCELLED', updatedAt: at })
      .where(and(eq(accountDeletionRequests.userId, userId), eq(accountDeletionRequests.status, 'REQUESTED')))
      .returning({ id: accountDeletionRequests.id });
    return updated.length > 0 ? 'CANCELLED' : 'NOT_FOUND';
  }

  async latestDeletion(userId: string): Promise<AccountDeletionRow | undefined> {
    const [row] = await this.db.select({ id: accountDeletionRequests.id, reason: accountDeletionRequests.reason, status: accountDeletionRequests.status, createdAt: accountDeletionRequests.createdAt, updatedAt: accountDeletionRequests.updatedAt })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.userId, userId))
      .orderBy(desc(accountDeletionRequests.createdAt), desc(accountDeletionRequests.id))
      .limit(1);
    return row;
  }

  async insertIdentityAudit(input: { readonly userId: string; readonly workspaceId: string | null; readonly action: string; readonly outcome: 'SUCCESS' | 'DENIED' | 'FAILED' }): Promise<void> {
    await this.db.insert(identityAudit).values({ id: randomUUID(), userId: input.userId, workspaceId: input.workspaceId, action: input.action, outcome: input.outcome });
  }

  async insertPlatformAudit(record: PlatformAuditRecord): Promise<void> {
    await this.db.insert(platformAdminAudit).values(platformAuditValues(record));
  }
}
