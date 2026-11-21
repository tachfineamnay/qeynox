/**
 * MISSION A21.02 — explicit beta precondition for QA suites that launch missions.
 *
 * Since A21.02 every launch (start/retry/redo) and every provider-spend reservation requires an
 * ACTIVE beta grant for the workspace (fail closed). Suites that verify OTHER behaviour (mission
 * lifecycle, agent runtime, connectors, payments…) therefore declare the grant as a fixture, exactly
 * as an operator would have issued and the workspace would have activated it. The limits are
 * generous on purpose so they never interfere with what those suites measure; the beta gate itself
 * is verified by `qa:beta-access`.
 *
 * Only for disposable QA databases. Never used by application code.
 */
import { randomUUID } from 'node:crypto';
import { betaGrantEvents, betaGrants, identityUsers, type QeyNoxDatabase } from '@qeynox/persistence';

export interface QaBetaGrantOptions {
  readonly currency?: string;
  readonly missionQuota?: number;
  readonly concurrentLimit?: number;
  readonly maxProviderSpendMinor?: number;
  readonly activatedBy?: string;
}

export async function seedQaBetaGrant(db: QeyNoxDatabase, workspaceId: string, options: QaBetaGrantOptions = {}): Promise<{ grantId: string; operatorUserId: string }> {
  const operatorUserId = 'qa-beta-operator-' + randomUUID();
  await db.insert(identityUsers).values({ id: operatorUserId, email: operatorUserId + '@example.invalid' });
  const now = new Date();
  const grantId = randomUUID();
  await db.insert(betaGrants).values({
    id: grantId, workspaceId, status: 'ACTIVE', expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    missionQuota: options.missionQuota ?? 10_000, concurrentLimit: options.concurrentLimit ?? 100,
    maxProviderSpendMinor: options.maxProviderSpendMinor ?? 100_000_000, currency: options.currency ?? 'USD',
    grantedBy: operatorUserId, grantReason: 'QA fixture: beta precondition for a non-beta suite',
    createdAt: now, activatedAt: now, activatedBy: options.activatedBy ?? null, updatedAt: now,
  });
  await db.insert(betaGrantEvents).values([
    { id: randomUUID(), grantId, workspaceId, kind: 'INVITED', actorUserId: operatorUserId, reason: 'QA fixture', occurredAt: now },
    { id: randomUUID(), grantId, workspaceId, kind: 'ACTIVATED', actorUserId: options.activatedBy ?? null, occurredAt: now },
  ]);
  return { grantId, operatorUserId };
}
