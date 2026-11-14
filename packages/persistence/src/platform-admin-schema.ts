import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { identityUsers } from './identity-schema';

/**
 * Platform administration tables (migration 0012).
 * These tables reference identity_users for the credentialed human but are never joined to
 * identity_memberships: workspace roles stay workspace-scoped.
 */
export const platformAdminAssignments = pgTable('platform_admin_assignments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id),
  role: text('role').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  grantedBy: text('granted_by').notNull(),
  grantReason: text('grant_reason').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedBy: text('revoked_by'),
  revokeReason: text('revoke_reason'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  uniqueIndex('platform_admin_active_user_role_unique').on(t.userId, t.role).where(sql`${t.status} = 'ACTIVE'`),
  index('platform_admin_assignment_user_idx').on(t.userId, t.status),
  check('platform_admin_role_range', sql`${t.role} IN ('PLATFORM_ADMIN', 'SUPPORT', 'OPERATIONS', 'AUDITOR')`),
  check('platform_admin_status_range', sql`${t.status} IN ('ACTIVE', 'REVOKED')`),
  check('platform_admin_revocation_consistent', sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL)`),
]);

export const platformAdminSessions = pgTable('platform_admin_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, t => [
  index('platform_admin_session_expiry_idx').on(t.expiresAt),
  index('platform_admin_session_user_idx').on(t.userId),
]);

export type PlatformAuditOutcomeColumn = 'SUCCESS' | 'DENIED' | 'ERROR';

export const platformAdminAudit = pgTable('platform_admin_audit', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id'),
  actorSessionId: text('actor_session_id'),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  action: text('action').notNull(),
  permission: text('permission'),
  outcome: text('outcome').$type<PlatformAuditOutcomeColumn>().notNull(),
  reason: text('reason'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  happenedAt: timestamp('happened_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('platform_audit_time_idx').on(t.happenedAt),
  index('platform_audit_actor_idx').on(t.actorUserId, t.happenedAt),
  index('platform_audit_action_idx').on(t.action, t.happenedAt),
  index('platform_audit_target_idx').on(t.targetType, t.targetId, t.happenedAt),
  check('platform_audit_outcome_range', sql`${t.outcome} IN ('SUCCESS', 'DENIED', 'ERROR')`),
  check('platform_audit_action_present', sql`length(${t.action}) > 0`),
]);
