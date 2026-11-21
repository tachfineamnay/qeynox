import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { identityUsers, identityWorkspaces } from './identity-schema';
import { betaGrants } from './beta-access-schema';

/**
 * MISSION A21.05 — invite-only registration (migration 0028).
 *
 * A registration invitation lets exactly one person (bound by e-mail address) create an account and a
 * NEW workspace while registration is INVITE_ONLY. It is issued by an authorized platform operator,
 * stores only the SHA-256 digest of its single-use token, and carries the beta terms that become an
 * ACTIVE beta grant (migration 0026) for the new workspace in the same transaction as the signup.
 */
export const registrationInvitationStatuses = ['PENDING', 'REDEEMED', 'EXPIRED', 'REVOKED'] as const;
export type RegistrationInvitationStatus = (typeof registrationInvitationStatuses)[number];

export const registrationInvitations = pgTable('registration_invitations', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  status: text('status').$type<RegistrationInvitationStatus>().notNull().default('PENDING'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  betaExpiresAt: timestamp('beta_expires_at', { withTimezone: true }).notNull(),
  missionQuota: integer('mission_quota').notNull(),
  concurrentLimit: integer('concurrent_limit').notNull(),
  maxProviderSpendMinor: integer('max_provider_spend_minor').notNull(),
  currency: text('currency').notNull(),
  createdBy: text('created_by').notNull().references(() => identityUsers.id),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedUserId: text('redeemed_user_id').references(() => identityUsers.id),
  redeemedWorkspaceId: text('redeemed_workspace_id').references(() => identityWorkspaces.id),
  betaGrantId: text('beta_grant_id').references(() => betaGrants.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by').references(() => identityUsers.id),
  revokeReason: text('revoke_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('registration_invitations_pending_email_unique').on(t.email).where(sql`${t.status} = 'PENDING'`),
  index('registration_invitations_status_expiry_idx').on(t.status, t.expiresAt),
  index('registration_invitations_created_idx').on(t.createdAt.desc()),
  check('registration_invitations_status_range', sql`${t.status} IN ('PENDING', 'REDEEMED', 'EXPIRED', 'REVOKED')`),
  check('registration_invitations_email_normalised', sql`${t.email} = lower(${t.email}) AND length(${t.email}) BETWEEN 3 AND 320`),
  check('registration_invitations_quota_range', sql`${t.missionQuota} BETWEEN 1 AND 10000`),
  check('registration_invitations_concurrency_range', sql`${t.concurrentLimit} BETWEEN 1 AND 100`),
  check('registration_invitations_spend_range', sql`${t.maxProviderSpendMinor} BETWEEN 0 AND 100000000`),
  check('registration_invitations_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('registration_invitations_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  check('registration_invitations_beta_outlives_invitation', sql`${t.betaExpiresAt} >= ${t.expiresAt}`),
  check('registration_invitations_redemption_consistent', sql`(${t.status} = 'REDEEMED') = (${t.redeemedAt} IS NOT NULL AND ${t.redeemedUserId} IS NOT NULL AND ${t.redeemedWorkspaceId} IS NOT NULL AND ${t.betaGrantId} IS NOT NULL)`),
  check('registration_invitations_revocation_consistent', sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL)`),
  check('registration_invitations_reason_length', sql`length(${t.reason}) BETWEEN 10 AND 500`),
]);
