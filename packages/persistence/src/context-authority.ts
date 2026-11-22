import { and, eq, isNull, sql } from 'drizzle-orm';
import { DomainError, isConsentActive, type Principal } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { agentProfiles, consents } from './schema';
import { identityMemberships, identityUsers } from './identity-schema';

export async function assertActiveWorkspaceMember(db: QeyNoxDatabase, actor: Principal): Promise<void> {
  const [member] = await db.select({ id: identityMemberships.id }).from(identityMemberships)
    .innerJoin(identityUsers, and(eq(identityUsers.id, identityMemberships.userId), isNull(identityUsers.disabledAt)))
    .where(and(eq(identityMemberships.userId, actor.userId), eq(identityMemberships.workspaceId, actor.workspaceId), eq(identityMemberships.status, 'ACTIVE'))).limit(1);
  if (!member) throw new DomainError('DENIED', 'Workspace membership no longer active');
}

/** User-requested Soul/Pilot advice is not mission execution or a beta admission. It must still
 * reauthorize membership/profile and every stored fact's ORIGINAL consent before sending a prompt.
 * This short read transaction ends before inference, with no network callback or held row lock.
 */
export async function assertInteractiveInference(
  db: QeyNoxDatabase, actor: Principal, profile: { readonly id: string; readonly version: number },
  bindings: readonly { readonly id: string; readonly version: number }[] = [],
): Promise<void> {
  const observedAt=Date.now();
  await db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    // Use the same snapshot without starting a nested transaction.
    const [member] = await tx.select({ id: identityMemberships.id }).from(identityMemberships)
      .innerJoin(identityUsers, and(eq(identityUsers.id, identityMemberships.userId), isNull(identityUsers.disabledAt)))
      .where(and(eq(identityMemberships.userId, actor.userId), eq(identityMemberships.workspaceId, actor.workspaceId), eq(identityMemberships.status, 'ACTIVE'))).limit(1);
    const [activeProfile] = await tx.select({ id: agentProfiles.id }).from(agentProfiles)
      .where(and(eq(agentProfiles.id, profile.id), eq(agentProfiles.version, profile.version), eq(agentProfiles.active, true))).limit(1);
    if (!member || !activeProfile) throw new DomainError('DENIED', 'Inference actor or profile changed');
    const permits = await tx.select().from(consents).where(and(eq(consents.workspaceId, actor.workspaceId), eq(consents.userId, actor.userId)));
    if (bindings.some(binding => !permits.some(row => row.id === binding.id && row.payload.version === binding.version && row.payload.userId === actor.userId && row.payload.workspaceId === actor.workspaceId && row.payload.scopes.includes('context:read') && isConsentActive(row.payload, new Date().toISOString())))) throw new DomainError('DENIED', 'Prepared fact consent changed');
  });
  if(Date.now()-observedAt>2000)throw new DomainError('DENIED','Interactive inference authority expired before dispatch');
}
