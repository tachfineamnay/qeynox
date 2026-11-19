import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';

export const identityUsers = pgTable('identity_users', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(),
  locale: text('locale').notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone:true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', {withTimezone:true}),
  /** NULL means the e-mail address has not been proven; registration never implies verification. */
  verifiedAt: timestamp('verified_at', {withTimezone:true}),
},t=>[index('identity_user_created_idx').on(t.createdAt,t.id)]);
export const identityCredentials = pgTable('identity_credentials',{
  userId:text('user_id').primaryKey().references(()=>identityUsers.id),
  salt:text('salt').notNull(), passwordHash:text('password_hash').notNull(),
  failedAttempts:integer('failed_attempts').notNull().default(0),
  lockedUntil:timestamp('locked_until',{withTimezone:true}),
  changedAt:timestamp('changed_at',{withTimezone:true}).notNull().defaultNow(),
});
export const identityWorkspaces=pgTable('identity_workspaces',{
  id:text('id').primaryKey(),name:text('name').notNull(),
  createdBy:text('created_by').notNull().references(()=>identityUsers.id),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const identityMemberships=pgTable('identity_memberships',{
  id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>identityUsers.id),
  workspaceId:text('workspace_id').notNull().references(()=>identityWorkspaces.id),
  role:text('role').notNull(),status:text('status').notNull().default('ACTIVE'),
  invitedBy:text('invited_by'),invitedAt:timestamp('invited_at',{withTimezone:true}),
  joinedAt:timestamp('joined_at',{withTimezone:true}),updatedAt:timestamp('updated_at',{withTimezone:true}),
  invitationTokenHash:text('invitation_token_hash'),invitationExpiresAt:timestamp('invitation_expires_at',{withTimezone:true}),
},t=>[uniqueIndex('identity_member_unique').on(t.userId,t.workspaceId),index('identity_workspace_member_idx').on(t.workspaceId),index('identity_membership_workspace_status_idx').on(t.workspaceId,t.status),index('identity_membership_user_status_idx').on(t.userId,t.status),uniqueIndex('identity_membership_invitation_token_unique').on(t.invitationTokenHash).where(sql`${t.invitationTokenHash} IS NOT NULL`)]);
export const identitySessions=pgTable('identity_sessions',{
  id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>identityUsers.id),
  tokenHash:text('token_hash').notNull().unique(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  revokedAt:timestamp('revoked_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  lastUsedAt:timestamp('last_used_at',{withTimezone:true}),
},t=>[index('identity_session_expiry_idx').on(t.expiresAt),index('identity_session_user_idx').on(t.userId)]);
export const identityAudit=pgTable('identity_audit',{
  id:text('id').primaryKey(),userId:text('user_id'),workspaceId:text('workspace_id'),
  action:text('action').notNull(),outcome:text('outcome').notNull(),
  happenedAt:timestamp('happened_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[index('identity_audit_user_idx').on(t.userId,t.happenedAt)]);

/**
 * MISSION A04 — single-use verification and recovery tokens.
 *
 * Only a SHA-256 digest is stored: the bearer value exists in the message handed to the configured
 * transport and nowhere else, so a database read cannot replay a link. `used_at` marks consumption
 * and `revoked_at` supersedes a token when a newer one is issued for the same purpose; the partial
 * unique index in migration 0018 allows exactly one live token per user and purpose.
 */
export const identityTokens = pgTable('identity_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id),
  purpose: text('purpose').$type<'EMAIL_VERIFICATION' | 'PASSWORD_RESET'>().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  requestFingerprint: text('request_fingerprint'),
}, t => [
  index('identity_token_user_purpose_idx').on(t.userId, t.purpose),
  uniqueIndex('identity_token_live_unique').on(t.userId, t.purpose).where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  // Declared here as well as in the migration: the schema must describe every constraint the
  // database enforces, or drift between the two goes unnoticed.
  check('identity_token_purpose_range', sql`${t.purpose} IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')`),
  check('identity_token_lifecycle_consistent', sql`${t.usedAt} IS NULL OR ${t.revokedAt} IS NULL`),
]);

/** Attempt ledger backing the durable rate limiter (stores a hashed bucket key, never a raw address). */
export const identityAttempts = pgTable('identity_attempts', {
  id: text('id').primaryKey(),
  bucket: text('bucket').notNull(),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('identity_attempt_bucket_idx').on(t.bucket, t.attemptedAt)]);
