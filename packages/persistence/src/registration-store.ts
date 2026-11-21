import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { QeyNoxDatabase } from './database';
import { identityAudit, identityCredentials, identityMemberships, identityUsers, identityWorkspaces } from './identity-schema';
import { platformAdminAudit } from './platform-admin-schema';
import { platformAuditValues, type PlatformAuditRecord } from './platform-admin-store';
import { betaGrantEvents, betaGrants } from './beta-access-schema';
import { registrationInvitations, type RegistrationInvitationStatus } from './registration-schema';

/**
 * MISSION A21.05 — persistence for account registration and invite-only registration invitations.
 *
 * The signup transaction lives here so that the account, its workspace, its OWNER membership, the
 * redemption of an invitation and the resulting ACTIVE beta grant are written atomically: either the
 * person gets all of it, or nothing is written and the invitation stays PENDING.
 */
export type RegistrationInvitationRow = typeof registrationInvitations.$inferSelect;

export interface RegistrationInvitationInsert {
  readonly id: string;
  readonly email: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly betaExpiresAt: Date;
  readonly missionQuota: number;
  readonly concurrentLimit: number;
  readonly maxProviderSpendMinor: number;
  readonly currency: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly createdAt: Date;
}

export type RegistrationInvitationCreateOutcome =
  | { readonly outcome: 'CREATED'; readonly invitation: RegistrationInvitationRow }
  | { readonly outcome: 'CONFLICT'; readonly existingInvitationId: string };

export type RegistrationInvitationRevokeOutcome =
  | { readonly outcome: 'REVOKED'; readonly invitation: RegistrationInvitationRow }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'NOT_PENDING'; readonly status: RegistrationInvitationStatus };

export interface AccountRegistrationInput {
  readonly userId: string;
  readonly email: string;
  readonly locale: string;
  readonly salt: string;
  readonly passwordHash: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** SHA-256 digest of the presented invitation token; undefined for an uninvited (OPEN) signup. */
  readonly invitationTokenHash?: string | undefined;
  readonly at: Date;
}

export type AccountRegistrationOutcome =
  | { readonly outcome: 'REGISTERED'; readonly invitationId: string | null; readonly betaGrantId: string | null }
  | { readonly outcome: 'INVITATION_INVALID' }
  | { readonly outcome: 'DUPLICATE' };

/** Stored PENDING rows past their deadline are EXPIRED; every other stored status is final. */
export function effectiveRegistrationInvitationStatus(row: Pick<RegistrationInvitationRow, 'status' | 'expiresAt'>, now: Date): RegistrationInvitationStatus {
  if (row.status === 'PENDING' && row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return row.status;
}

function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') return true;
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Internal rollback signal: the invitation was missing, used, revoked, expired or for another e-mail. */
class InvitationRejected extends Error {}

export class RegistrationStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async findUserEmail(userId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ email: identityUsers.email }).from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    return row?.email;
  }

  async emailRegistered(email: string): Promise<boolean> {
    const [row] = await this.db.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.email, email)).limit(1);
    return Boolean(row);
  }

  /**
   * Creates a PENDING invitation. A PENDING invitation for the same e-mail whose deadline has passed is
   * first materialised as EXPIRED in the same transaction; a live one is a CONFLICT. The partial unique
   * index is the backstop against two concurrent creations.
   */
  async createInvitation(input: RegistrationInvitationInsert, audit: PlatformAuditRecord): Promise<RegistrationInvitationCreateOutcome> {
    try {
      return await this.db.transaction(async tx => {
        const pending = await tx.select().from(registrationInvitations)
          .where(and(eq(registrationInvitations.email, input.email), eq(registrationInvitations.status, 'PENDING')))
          .for('update');
        for (const row of pending) {
          if (effectiveRegistrationInvitationStatus(row, input.createdAt) !== 'EXPIRED') return { outcome: 'CONFLICT' as const, existingInvitationId: row.id };
          await tx.update(registrationInvitations).set({ status: 'EXPIRED', updatedAt: input.createdAt }).where(eq(registrationInvitations.id, row.id));
        }
        const [invitation] = await tx.insert(registrationInvitations).values({
          id: input.id, email: input.email, tokenHash: input.tokenHash, status: 'PENDING', expiresAt: input.expiresAt,
          betaExpiresAt: input.betaExpiresAt, missionQuota: input.missionQuota, concurrentLimit: input.concurrentLimit,
          maxProviderSpendMinor: input.maxProviderSpendMinor, currency: input.currency, createdBy: input.createdBy,
          reason: input.reason, createdAt: input.createdAt, updatedAt: input.createdAt,
        }).returning();
        await tx.insert(platformAdminAudit).values(platformAuditValues(audit));
        return { outcome: 'CREATED' as const, invitation: invitation! };
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const [existing] = await this.db.select({ id: registrationInvitations.id }).from(registrationInvitations)
        .where(and(eq(registrationInvitations.email, input.email), eq(registrationInvitations.status, 'PENDING'))).limit(1);
      return { outcome: 'CONFLICT', existingInvitationId: existing?.id ?? 'unknown' };
    }
  }

  async listInvitations(input: { invitationId?: string | undefined; email?: string | undefined; statuses?: readonly RegistrationInvitationStatus[] | undefined; limit: number }): Promise<RegistrationInvitationRow[]> {
    const conditions = [];
    if (input.invitationId) conditions.push(eq(registrationInvitations.id, input.invitationId));
    if (input.email) conditions.push(eq(registrationInvitations.email, input.email));
    if (input.statuses?.length) conditions.push(inArray(registrationInvitations.status, [...input.statuses]));
    return this.db.select().from(registrationInvitations)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(registrationInvitations.createdAt)).limit(input.limit);
  }

  async revokeInvitation(input: { invitationId: string; actorUserId: string; reason: string; at: Date; buildAudit: (row: RegistrationInvitationRow) => PlatformAuditRecord }): Promise<RegistrationInvitationRevokeOutcome> {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(registrationInvitations).where(eq(registrationInvitations.id, input.invitationId)).for('update');
      if (!row) return { outcome: 'NOT_FOUND' as const };
      const status = effectiveRegistrationInvitationStatus(row, input.at);
      if (status !== 'PENDING') return { outcome: 'NOT_PENDING' as const, status };
      const [revoked] = await tx.update(registrationInvitations)
        .set({ status: 'REVOKED', revokedAt: input.at, revokedBy: input.actorUserId, revokeReason: input.reason, updatedAt: input.at })
        .where(eq(registrationInvitations.id, row.id)).returning();
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildAudit(revoked!)));
      return { outcome: 'REVOKED' as const, invitation: revoked! };
    });
  }

  /**
   * The signup transaction. With an invitation digest, the invitation must be PENDING, unexpired and
   * bound to the same (normalised) e-mail; it is locked first, so two concurrent redemptions cannot both
   * succeed (the loser re-evaluates the row after the winner commits and sees REDEEMED). Any failure —
   * rejected invitation or duplicate e-mail — rolls back everything, so a duplicate-email attempt never
   * consumes an invitation.
   */
  async register(input: AccountRegistrationInput): Promise<AccountRegistrationOutcome> {
    try {
      return await this.db.transaction(async tx => {
        let invitation: RegistrationInvitationRow | undefined;
        if (input.invitationTokenHash !== undefined) {
          [invitation] = await tx.select().from(registrationInvitations).where(and(
            eq(registrationInvitations.tokenHash, input.invitationTokenHash),
            eq(registrationInvitations.status, 'PENDING'),
            gt(registrationInvitations.expiresAt, input.at),
            eq(registrationInvitations.email, input.email),
          )).for('update');
          if (!invitation) throw new InvitationRejected();
        }
        await tx.insert(identityUsers).values({ id: input.userId, email: input.email, locale: input.locale });
        await tx.insert(identityCredentials).values({ userId: input.userId, salt: input.salt, passwordHash: input.passwordHash });
        await tx.insert(identityWorkspaces).values({ id: input.workspaceId, name: input.workspaceName, createdBy: input.userId });
        await tx.insert(identityMemberships).values({ id: randomUUID(), userId: input.userId, workspaceId: input.workspaceId, role: 'OWNER', status: 'ACTIVE' });
        await tx.insert(identityAudit).values({ id: randomUUID(), userId: input.userId, workspaceId: input.workspaceId, action: 'REGISTER', outcome: 'SUCCESS' });
        if (!invitation) return { outcome: 'REGISTERED' as const, invitationId: null, betaGrantId: null };

        // The invitation's beta terms become an ACTIVE grant for the new workspace. The operator who
        // issued the invitation is the grantor; the registrant is the activator (the redemption of the
        // single-use token is the activation). beta_expires_at >= expires_at > now, so the grant's
        // expiry is always after its creation.
        const grantId = randomUUID();
        await tx.insert(betaGrants).values({
          id: grantId, workspaceId: input.workspaceId, status: 'ACTIVE', expiresAt: invitation.betaExpiresAt,
          missionQuota: invitation.missionQuota, concurrentLimit: invitation.concurrentLimit,
          maxProviderSpendMinor: invitation.maxProviderSpendMinor, currency: invitation.currency,
          invitationTokenHash: null, invitationExpiresAt: null, grantedBy: invitation.createdBy, grantReason: invitation.reason,
          createdAt: input.at, activatedAt: input.at, activatedBy: input.userId, updatedAt: input.at,
        });
        const source = { source: 'REGISTRATION_INVITATION', registrationInvitationId: invitation.id };
        await tx.insert(betaGrantEvents).values([
          {
            id: randomUUID(), grantId, workspaceId: input.workspaceId, kind: 'INVITED', actorUserId: invitation.createdBy, reason: invitation.reason,
            detail: {
              ...source, expiresAt: invitation.betaExpiresAt.toISOString(), missionQuota: invitation.missionQuota,
              concurrentLimit: invitation.concurrentLimit, maxProviderSpendMinor: invitation.maxProviderSpendMinor, currency: invitation.currency,
            },
            occurredAt: input.at,
          },
          { id: randomUUID(), grantId, workspaceId: input.workspaceId, kind: 'ACTIVATED', actorUserId: input.userId, detail: source, occurredAt: input.at },
        ]);
        await tx.update(registrationInvitations).set({
          status: 'REDEEMED', redeemedAt: input.at, redeemedUserId: input.userId, redeemedWorkspaceId: input.workspaceId,
          betaGrantId: grantId, updatedAt: input.at,
        }).where(eq(registrationInvitations.id, invitation.id));
        return { outcome: 'REGISTERED' as const, invitationId: invitation.id, betaGrantId: grantId };
      });
    } catch (error: unknown) {
      if (error instanceof InvitationRejected) return { outcome: 'INVITATION_INVALID' };
      if (isUniqueViolation(error)) return { outcome: 'DUPLICATE' };
      throw error;
    }
  }
}
