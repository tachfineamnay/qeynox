import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DomainError } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { identityMemberships, identityUsers, identityWorkspaces } from './identity-schema';
import { platformAdminAudit } from './platform-admin-schema';
import { platformAuditValues, type PlatformAuditRecord } from './platform-admin-store';
import { betaGrantEvents, betaGrantMissions, betaGrants, type BetaGrantEventKind, type BetaGrantStatus } from './beta-access-schema';
import { operations } from './schema';

/**
 * MISSION A21.02 — persistence for invite-only beta access.
 *
 * Every limit check runs under `SELECT … FOR UPDATE` on the grant row inside the caller's
 * transaction, so concurrent launches or spend reservations for one workspace are serialised on
 * that row and cannot overshoot. Lock order is always "operation/budget/reservation rows first,
 * grant row last" (revocation and creation lock only grant rows), so no lock cycle exists.
 */
export type BetaGrantRow = typeof betaGrants.$inferSelect;
export type BetaGrantEventRow = typeof betaGrantEvents.$inferSelect;
export type BetaGrantMissionRow = typeof betaGrantMissions.$inferSelect;
export type BetaTransaction = Parameters<Parameters<QeyNoxDatabase['transaction']>[0]>[0];
type Executor = QeyNoxDatabase | BetaTransaction;

/** Operation statuses that occupy a concurrent-mission slot. */
export const betaActiveOperationStatuses = ['RUNNING', 'WAITING_APPROVAL', 'INTERRUPT_REQUESTED'] as const;

export type BetaDenialReason =
  | 'NO_GRANT' | 'GRANT_NOT_ACTIVATED' | 'GRANT_EXPIRED' | 'GRANT_REVOKED' | 'MISSION_NOT_ADMITTED'
  | 'MISSION_QUOTA_REACHED' | 'CONCURRENT_LIMIT_REACHED' | 'PROVIDER_SPEND_CAP_REACHED' | 'CURRENCY_MISMATCH';

/**
 * Effective state at `now`. Time-based expiry is evaluated on every read and every gate, so a grant
 * whose stored status is still ACTIVE/INVITED but whose deadline has passed is EXPIRED (fail closed)
 * even before anything materialises the transition.
 */
export function effectiveBetaStatus(row: Pick<BetaGrantRow, 'status' | 'expiresAt' | 'invitationExpiresAt'>, now: Date): BetaGrantStatus {
  if (row.status === 'REVOKED' || row.status === 'EXPIRED') return row.status;
  if (row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.status === 'INVITED' && (!row.invitationExpiresAt || row.invitationExpiresAt.getTime() <= now.getTime())) return 'EXPIRED';
  return row.status;
}

function betaError(reason: BetaDenialReason, grantId: string | null): DomainError {
  const limit = reason === 'MISSION_QUOTA_REACHED' || reason === 'CONCURRENT_LIMIT_REACHED' || reason === 'PROVIDER_SPEND_CAP_REACHED';
  const context: Record<string, string> = { reason };
  if (grantId) context.grantId = grantId;
  return new DomainError(limit ? 'BETA_LIMIT_REACHED' : 'BETA_ACCESS_REQUIRED', (limit ? 'Beta limit reached: ' : 'Beta access required: ') + reason, context);
}

function inactiveReason(status: BetaGrantStatus): BetaDenialReason {
  if (status === 'REVOKED') return 'GRANT_REVOKED';
  if (status === 'EXPIRED') return 'GRANT_EXPIRED';
  return 'GRANT_NOT_ACTIVATED';
}

function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') return true;
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export interface BetaGrantInsert {
  readonly id: string;
  readonly workspaceId: string;
  readonly expiresAt: Date;
  readonly missionQuota: number;
  readonly concurrentLimit: number;
  readonly maxProviderSpendMinor: number;
  readonly currency: string;
  readonly invitationTokenHash: string;
  readonly invitationExpiresAt: Date;
  readonly grantedBy: string;
  readonly grantReason: string;
  readonly createdAt: Date;
}

export type BetaCreateOutcome = { readonly outcome: 'CREATED'; readonly grant: BetaGrantRow } | { readonly outcome: 'CONFLICT'; readonly existingGrantId: string };
export type BetaRevokeOutcome =
  | { readonly outcome: 'REVOKED'; readonly grant: BetaGrantRow }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'ALREADY_REVOKED'; readonly grant: BetaGrantRow };
export type BetaActivationOutcome =
  | { readonly outcome: 'ACTIVATED'; readonly grant: BetaGrantRow }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'DENIED'; readonly reason: 'WRONG_WORKSPACE' | 'ROLE_REQUIRED' | 'SELF_ACTIVATION' | 'GRANT_EXPIRED' | 'GRANT_REVOKED' | 'NOT_INVITED'; readonly grantId: string };

export interface BetaAdmission { readonly grantId: string; readonly consumedQuota: boolean }

export class BetaAccessStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  // ── Operator side ─────────────────────────────────────────────────────────────────────────────

  async findWorkspace(workspaceId: string): Promise<{ id: string; name: string; createdBy: string } | undefined> {
    const [row] = await this.db.select({ id: identityWorkspaces.id, name: identityWorkspaces.name, createdBy: identityWorkspaces.createdBy })
      .from(identityWorkspaces).where(eq(identityWorkspaces.id, workspaceId)).limit(1);
    return row;
  }

  /** True when the user holds ANY membership row (any role, any status) in the workspace. */
  async hasAnyMembership(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: identityMemberships.id }).from(identityMemberships)
      .where(and(eq(identityMemberships.workspaceId, workspaceId), eq(identityMemberships.userId, userId))).limit(1);
    return Boolean(row);
  }

  /**
   * Creates an INVITED grant. A live grant whose deadline has passed is first materialised as
   * EXPIRED (with an event) in the same transaction; any other live grant is a CONFLICT. The
   * partial unique index is the backstop against two concurrent creations.
   */
  async createGrant(input: BetaGrantInsert, audit: PlatformAuditRecord): Promise<BetaCreateOutcome> {
    try {
      return await this.db.transaction(async tx => {
        const live = await tx.select().from(betaGrants)
          .where(and(eq(betaGrants.workspaceId, input.workspaceId), inArray(betaGrants.status, ['INVITED', 'ACTIVE'])))
          .for('update');
        for (const row of live) {
          if (effectiveBetaStatus(row, input.createdAt) !== 'EXPIRED') return { outcome: 'CONFLICT' as const, existingGrantId: row.id };
          await this.materialiseExpiry(tx, row, input.grantedBy, input.createdAt);
        }
        const [grant] = await tx.insert(betaGrants).values({
          id: input.id, workspaceId: input.workspaceId, status: 'INVITED', expiresAt: input.expiresAt,
          missionQuota: input.missionQuota, concurrentLimit: input.concurrentLimit, maxProviderSpendMinor: input.maxProviderSpendMinor,
          currency: input.currency, invitationTokenHash: input.invitationTokenHash, invitationExpiresAt: input.invitationExpiresAt,
          grantedBy: input.grantedBy, grantReason: input.grantReason, createdAt: input.createdAt, updatedAt: input.createdAt,
        }).returning();
        await this.insertEvent(tx, {
          grantId: input.id, workspaceId: input.workspaceId, kind: 'INVITED', actorUserId: input.grantedBy, reason: input.grantReason,
          detail: {
            expiresAt: input.expiresAt.toISOString(), missionQuota: input.missionQuota, concurrentLimit: input.concurrentLimit,
            maxProviderSpendMinor: input.maxProviderSpendMinor, currency: input.currency, invitationExpiresAt: input.invitationExpiresAt.toISOString(),
          },
          occurredAt: input.createdAt,
        });
        await tx.insert(platformAdminAudit).values(platformAuditValues(audit));
        return { outcome: 'CREATED' as const, grant: grant! };
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const [existing] = await this.db.select({ id: betaGrants.id }).from(betaGrants)
        .where(and(eq(betaGrants.workspaceId, input.workspaceId), inArray(betaGrants.status, ['INVITED', 'ACTIVE']))).limit(1);
      return { outcome: 'CONFLICT', existingGrantId: existing?.id ?? 'unknown' };
    }
  }

  async revokeGrant(input: { grantId: string; actorUserId: string; reason: string; at: Date; buildAudit: (grant: BetaGrantRow) => PlatformAuditRecord }): Promise<BetaRevokeOutcome> {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(betaGrants).where(eq(betaGrants.id, input.grantId)).for('update').limit(1);
      if (!row) return { outcome: 'NOT_FOUND' as const };
      if (row.status === 'REVOKED') return { outcome: 'ALREADY_REVOKED' as const, grant: row };
      const previous = effectiveBetaStatus(row, input.at);
      const [updated] = await tx.update(betaGrants).set({
        status: 'REVOKED', revokedAt: input.at, revokedBy: input.actorUserId, revokeReason: input.reason,
        invitationTokenHash: null, updatedAt: input.at,
      }).where(eq(betaGrants.id, row.id)).returning();
      await this.insertEvent(tx, {
        grantId: row.id, workspaceId: row.workspaceId, kind: 'REVOKED', actorUserId: input.actorUserId, reason: input.reason,
        detail: { previousStatus: previous, missionsUsed: row.missionsUsed, reservedMinor: row.reservedMinor, spentMinor: row.spentMinor },
        occurredAt: input.at,
      });
      await tx.insert(platformAdminAudit).values(platformAuditValues(input.buildAudit(updated!)));
      return { outcome: 'REVOKED' as const, grant: updated! };
    });
  }

  async getGrant(grantId: string): Promise<BetaGrantRow | undefined> {
    const [row] = await this.db.select().from(betaGrants).where(eq(betaGrants.id, grantId)).limit(1);
    return row;
  }

  async listGrants(input: { grantId?: string | undefined; workspaceId?: string | undefined; statuses?: readonly BetaGrantStatus[] | undefined; limit: number }): Promise<readonly (BetaGrantRow & { workspaceName: string; grantedByEmail: string | null })[]> {
    const filters = [];
    if (input.grantId) filters.push(eq(betaGrants.id, input.grantId));
    if (input.workspaceId) filters.push(eq(betaGrants.workspaceId, input.workspaceId));
    if (input.statuses && input.statuses.length) filters.push(inArray(betaGrants.status, [...input.statuses]));
    const rows = await this.db.select({ grant: betaGrants, workspaceName: identityWorkspaces.name, grantedByEmail: identityUsers.email })
      .from(betaGrants)
      .innerJoin(identityWorkspaces, eq(identityWorkspaces.id, betaGrants.workspaceId))
      .leftJoin(identityUsers, eq(identityUsers.id, betaGrants.grantedBy))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(betaGrants.createdAt), desc(betaGrants.id))
      .limit(input.limit);
    return rows.map(row => ({ ...row.grant, workspaceName: row.workspaceName, grantedByEmail: row.grantedByEmail }));
  }

  async listEvents(input: { grantId?: string; workspaceId?: string; limit: number }): Promise<readonly BetaGrantEventRow[]> {
    const filters = [];
    if (input.grantId) filters.push(eq(betaGrantEvents.grantId, input.grantId));
    if (input.workspaceId) filters.push(eq(betaGrantEvents.workspaceId, input.workspaceId));
    if (!filters.length) throw new DomainError('INVALID_INPUT', 'A grant or workspace filter is required');
    return this.db.select().from(betaGrantEvents).where(and(...filters))
      .orderBy(desc(betaGrantEvents.occurredAt), desc(betaGrantEvents.id)).limit(input.limit);
  }

  async countActiveOperations(workspaceId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(operations)
      .where(and(eq(operations.workspaceId, workspaceId), inArray(operations.status, [...betaActiveOperationStatuses])));
    return row?.n ?? 0;
  }

  /** The most recent grant of a workspace (any status) — the one a workspace status view reports. */
  async latestGrantForWorkspace(workspaceId: string): Promise<BetaGrantRow | undefined> {
    const [row] = await this.db.select().from(betaGrants).where(eq(betaGrants.workspaceId, workspaceId))
      .orderBy(desc(betaGrants.createdAt), desc(betaGrants.id)).limit(1);
    return row;
  }

  // ── Workspace side ────────────────────────────────────────────────────────────────────────────

  /**
   * Activation by an OWNER/ADMIN of the grant's own workspace. A denial is RETURNED (not thrown)
   * so its ACTIVATION_DENIED event commits; it never mutates the grant.
   */
  async activate(input: { tokenHash: string; workspaceId: string; userId: string; role: string; at: Date }): Promise<BetaActivationOutcome> {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(betaGrants).where(eq(betaGrants.invitationTokenHash, input.tokenHash)).for('update').limit(1);
      if (!row) return { outcome: 'NOT_FOUND' as const };
      const deny = async (reason: Extract<BetaActivationOutcome, { outcome: 'DENIED' }>['reason']) => {
        // A token presented from another workspace is recorded against the grant's OWN workspace
        // only; nothing about the grant is disclosed to the presenting workspace.
        await this.insertEvent(tx, {
          grantId: row.id, workspaceId: row.workspaceId, kind: 'ACTIVATION_DENIED', actorUserId: input.userId, reason,
          detail: { presentedFromWorkspace: input.workspaceId === row.workspaceId ? 'SAME' : 'OTHER' }, occurredAt: input.at,
        });
        return { outcome: 'DENIED' as const, reason, grantId: row.id };
      };
      if (row.workspaceId !== input.workspaceId) return deny('WRONG_WORKSPACE');
      if (input.role !== 'OWNER' && input.role !== 'ADMIN') return deny('ROLE_REQUIRED');
      if (row.grantedBy === input.userId) return deny('SELF_ACTIVATION');
      const status = effectiveBetaStatus(row, input.at);
      if (status === 'REVOKED') return deny('GRANT_REVOKED');
      if (status === 'EXPIRED') return deny('GRANT_EXPIRED');
      if (status !== 'INVITED') return deny('NOT_INVITED');
      const [updated] = await tx.update(betaGrants).set({
        status: 'ACTIVE', activatedAt: input.at, activatedBy: input.userId, invitationTokenHash: null, updatedAt: input.at,
      }).where(and(eq(betaGrants.id, row.id), eq(betaGrants.status, 'INVITED'))).returning();
      await this.insertEvent(tx, { grantId: row.id, workspaceId: row.workspaceId, kind: 'ACTIVATED', actorUserId: input.userId, occurredAt: input.at });
      return { outcome: 'ACTIVATED' as const, grant: updated! };
    });
  }

  /**
   * Read-only preview of `admitMission` for readiness views (no lock, no write). The launch itself
   * re-decides under lock; this only keeps the interface from offering a launch that would be refused.
   */
  async previewAdmission(workspaceId: string, operationId: string, at: Date): Promise<BetaDenialReason | null> {
    const [grant] = await this.db.select().from(betaGrants).where(eq(betaGrants.workspaceId, workspaceId))
      .orderBy(desc(betaGrants.createdAt), desc(betaGrants.id)).limit(1);
    if (!grant) return 'NO_GRANT';
    const status = effectiveBetaStatus(grant, at);
    if (status !== 'ACTIVE') return inactiveReason(status);
    const [active] = await this.db.select({ n: sql<number>`count(*)::int` }).from(operations)
      .where(and(eq(operations.workspaceId, workspaceId), inArray(operations.status, [...betaActiveOperationStatuses]), ne(operations.id, operationId)));
    if ((active?.n ?? 0) >= grant.concurrentLimit) return 'CONCURRENT_LIMIT_REACHED';
    const [already] = await this.db.select({ id: betaGrantMissions.id }).from(betaGrantMissions)
      .where(and(eq(betaGrantMissions.grantId, grant.id), eq(betaGrantMissions.operationId, operationId))).limit(1);
    if (!already && grant.missionsUsed >= grant.missionQuota) return 'MISSION_QUOTA_REACHED';
    return null;
  }

  // ── Launch and spend gates (run inside the caller's transaction) ─────────────────────────────

  /**
   * Admits a mission launch (start, retry or redo) for `operationId`. Throws BETA_ACCESS_REQUIRED /
   * BETA_LIMIT_REACHED (rolling back the caller's transaction) unless the workspace holds an ACTIVE,
   * unexpired, unrevoked grant with a free concurrent slot and — for an operation not yet admitted
   * under this grant — remaining mission quota.
   */
  async admitMission(tx: BetaTransaction, input: { workspaceId: string; operationId: string; actorUserId: string; at: Date; trigger: 'START' | 'RETRY' | 'REDO' }): Promise<BetaAdmission> {
    // Re-evaluated after the lock is granted (READ COMMITTED): a revocation that committed while we
    // waited makes the row no longer match, so the launch is refused.
    const [grant] = await tx.select().from(betaGrants)
      .where(and(eq(betaGrants.workspaceId, input.workspaceId), inArray(betaGrants.status, ['INVITED', 'ACTIVE'])))
      .for('update').limit(1);
    if (!grant) {
      const [latest] = await tx.select({ id: betaGrants.id, status: betaGrants.status }).from(betaGrants)
        .where(eq(betaGrants.workspaceId, input.workspaceId)).orderBy(desc(betaGrants.createdAt)).limit(1);
      if (!latest) throw betaError('NO_GRANT', null);
      throw betaError(inactiveReason(latest.status), latest.id);
    }
    const status = effectiveBetaStatus(grant, input.at);
    if (status !== 'ACTIVE') throw betaError(inactiveReason(status), grant.id);
    const [active] = await tx.select({ n: sql<number>`count(*)::int` }).from(operations)
      .where(and(eq(operations.workspaceId, input.workspaceId), inArray(operations.status, [...betaActiveOperationStatuses]), ne(operations.id, input.operationId)));
    if ((active?.n ?? 0) >= grant.concurrentLimit) throw betaError('CONCURRENT_LIMIT_REACHED', grant.id);
    const [already] = await tx.select({ id: betaGrantMissions.id }).from(betaGrantMissions)
      .where(and(eq(betaGrantMissions.grantId, grant.id), eq(betaGrantMissions.operationId, input.operationId))).limit(1);
    if (already) {
      await this.insertEvent(tx, {
        grantId: grant.id, workspaceId: input.workspaceId, kind: 'MISSION_RESUMED', actorUserId: input.actorUserId,
        operationId: input.operationId, detail: { trigger: input.trigger }, occurredAt: input.at,
      });
      return { grantId: grant.id, consumedQuota: false };
    }
    if (grant.missionsUsed >= grant.missionQuota) throw betaError('MISSION_QUOTA_REACHED', grant.id);
    await tx.insert(betaGrantMissions).values({
      id: randomUUID(), grantId: grant.id, workspaceId: input.workspaceId, operationId: input.operationId,
      admittedBy: input.actorUserId, admittedAt: input.at,
    });
    await tx.update(betaGrants).set({ missionsUsed: grant.missionsUsed + 1, updatedAt: input.at }).where(eq(betaGrants.id, grant.id));
    await this.insertEvent(tx, {
      grantId: grant.id, workspaceId: input.workspaceId, kind: 'MISSION_ADMITTED', actorUserId: input.actorUserId,
      operationId: input.operationId, detail: { trigger: input.trigger, missionsUsed: grant.missionsUsed + 1, missionQuota: grant.missionQuota }, occurredAt: input.at,
    });
    return { grantId: grant.id, consumedQuota: true };
  }

  /**
   * Reserves provider spend against the grant the operation was most recently admitted under.
   * An operation never admitted under a beta grant cannot reserve provider spend (fail closed).
   */
  async reserveSpend(tx: BetaTransaction, input: { workspaceId: string; operationId: string; reservationId: string; amountMinor: number; currency: string; actorUserId: string; at: Date }): Promise<{ grantId: string }> {
    const [admission] = await tx.select({ grantId: betaGrantMissions.grantId }).from(betaGrantMissions)
      .where(and(eq(betaGrantMissions.workspaceId, input.workspaceId), eq(betaGrantMissions.operationId, input.operationId)))
      .orderBy(desc(betaGrantMissions.admittedAt), desc(betaGrantMissions.id)).limit(1);
    if (!admission) throw betaError('MISSION_NOT_ADMITTED', null);
    const [grant] = await tx.select().from(betaGrants)
      .where(and(eq(betaGrants.id, admission.grantId), eq(betaGrants.workspaceId, input.workspaceId))).for('update').limit(1);
    if (!grant) throw betaError('NO_GRANT', null);
    const status = effectiveBetaStatus(grant, input.at);
    if (status !== 'ACTIVE') throw betaError(inactiveReason(status), grant.id);
    if (grant.currency !== input.currency) throw betaError('CURRENCY_MISMATCH', grant.id);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new DomainError('INVALID_INPUT', 'Reservation amount is invalid');
    if (grant.spentMinor + grant.reservedMinor + input.amountMinor > grant.maxProviderSpendMinor) throw betaError('PROVIDER_SPEND_CAP_REACHED', grant.id);
    await tx.update(betaGrants).set({ reservedMinor: grant.reservedMinor + input.amountMinor, updatedAt: input.at }).where(eq(betaGrants.id, grant.id));
    await this.insertEvent(tx, {
      grantId: grant.id, workspaceId: input.workspaceId, kind: 'SPEND_RESERVED', actorUserId: input.actorUserId,
      operationId: input.operationId, reservationId: input.reservationId, amountMinor: input.amountMinor,
      detail: { currency: input.currency, reservedAfter: grant.reservedMinor + input.amountMinor, spent: grant.spentMinor, cap: grant.maxProviderSpendMinor },
      occurredAt: input.at,
    });
    return { grantId: grant.id };
  }

  /**
   * Settles a reservation against the grant it was reserved on (never blocked, even after revocation
   * or expiry). An uncertain outcome keeps the amount reserved: money that may have been spent stays
   * counted against the cap.
   */
  async settleSpend(tx: BetaTransaction, input: { workspaceId: string; reservationId: string; reservedMinor: number; costMinor: number | undefined; uncertain: boolean; actorUserId: string; at: Date }): Promise<void> {
    const [reserved] = await tx.select().from(betaGrantEvents)
      .where(and(eq(betaGrantEvents.reservationId, input.reservationId), eq(betaGrantEvents.kind, 'SPEND_RESERVED'), eq(betaGrantEvents.workspaceId, input.workspaceId))).limit(1);
    if (!reserved || !reserved.grantId) return; // reservation predates beta admission tracking
    const [grant] = await tx.select().from(betaGrants).where(eq(betaGrants.id, reserved.grantId)).for('update').limit(1);
    if (!grant) throw new DomainError('INVALID_STATE', 'Beta grant for reservation is missing');
    const amount = reserved.amountMinor ?? input.reservedMinor;
    if (!input.uncertain) {
      const cost = input.costMinor ?? 0;
      await tx.update(betaGrants).set({ reservedMinor: grant.reservedMinor - amount, spentMinor: grant.spentMinor + cost, updatedAt: input.at }).where(eq(betaGrants.id, grant.id));
    }
    await this.insertEvent(tx, {
      grantId: grant.id, workspaceId: input.workspaceId, kind: 'SPEND_SETTLED', actorUserId: input.actorUserId,
      operationId: reserved.operationId, reservationId: input.reservationId, amountMinor: input.uncertain ? null : (input.costMinor ?? 0),
      detail: { uncertain: input.uncertain, reservedMinor: amount }, occurredAt: input.at,
    });
  }

  /** Best-effort denial ledger entry written AFTER the denied transaction rolled back. */
  async recordDenial(input: { workspaceId: string; grantId: string | null; kind: 'LAUNCH_DENIED' | 'SPEND_DENIED'; actorUserId: string; operationId: string; reason: string; amountMinor?: number | undefined; at: Date }): Promise<void> {
    try {
      await this.insertEvent(this.db, {
        grantId: input.grantId, workspaceId: input.workspaceId, kind: input.kind, actorUserId: input.actorUserId,
        operationId: input.operationId, reason: input.reason, amountMinor: input.amountMinor ?? null, occurredAt: input.at,
      });
    } catch {
      // A ledger outage must never turn a refusal into success; the denial is still thrown.
    }
  }

  private async materialiseExpiry(tx: BetaTransaction, row: BetaGrantRow, actorUserId: string, at: Date): Promise<void> {
    await tx.update(betaGrants).set({ status: 'EXPIRED', invitationTokenHash: null, updatedAt: at }).where(eq(betaGrants.id, row.id));
    await this.insertEvent(tx, {
      grantId: row.id, workspaceId: row.workspaceId, kind: 'EXPIRED', actorUserId, reason: 'DEADLINE_PASSED',
      detail: { storedStatus: row.status, expiresAt: row.expiresAt.toISOString() }, occurredAt: at,
    });
  }

  private async insertEvent(executor: Executor, event: {
    grantId: string | null; workspaceId: string; kind: BetaGrantEventKind; actorUserId?: string | null; operationId?: string | null;
    reservationId?: string | null; amountMinor?: number | null; reason?: string | null; detail?: Record<string, unknown> | null; occurredAt: Date;
  }): Promise<void> {
    await executor.insert(betaGrantEvents).values({
      id: randomUUID(), grantId: event.grantId, workspaceId: event.workspaceId, kind: event.kind,
      actorUserId: event.actorUserId ?? null, operationId: event.operationId ?? null, reservationId: event.reservationId ?? null,
      amountMinor: event.amountMinor ?? null, reason: event.reason ?? null, detail: event.detail ?? null, occurredAt: event.occurredAt,
    });
  }
}
