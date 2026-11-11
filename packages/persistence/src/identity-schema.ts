import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const identityUsers = pgTable('identity_users', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(),
  locale: text('locale').notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone:true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', {withTimezone:true}),
});
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
},t=>[uniqueIndex('identity_member_unique').on(t.userId,t.workspaceId),index('identity_workspace_member_idx').on(t.workspaceId)]);
export const identitySessions=pgTable('identity_sessions',{
  id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>identityUsers.id),
  tokenHash:text('token_hash').notNull().unique(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  revokedAt:timestamp('revoked_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  lastUsedAt:timestamp('last_used_at',{withTimezone:true}),
},t=>[index('identity_session_expiry_idx').on(t.expiresAt)]);
export const identityAudit=pgTable('identity_audit',{
  id:text('id').primaryKey(),userId:text('user_id'),workspaceId:text('workspace_id'),
  action:text('action').notNull(),outcome:text('outcome').notNull(),
  happenedAt:timestamp('happened_at',{withTimezone:true}).notNull().defaultNow(),
});
