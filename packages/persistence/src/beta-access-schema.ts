import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { identityUsers, identityWorkspaces } from './identity-schema';

/**
 * MISSION A21.02 — invite-only beta access (migration 0026).
 *
 * A beta grant is scoped to ONE existing identity workspace (no second organisation or account
 * model). It is created by an authorized platform operator in INVITED state with a single-use
 * invitation token (only its SHA-256 digest is stored), activated by an OWNER/ADMIN of that
 * workspace, and ends EXPIRED (time) or REVOKED (operator). At most one live (INVITED/ACTIVE) grant
 * exists per workspace.
 *
 * Limits are enforced under a row lock on the grant inside the same transaction as the mutation
 * they gate (mission launch, provider-spend reservation); the CHECK constraints below are a second,
 * database-level backstop so a code defect cannot push usage past a limit.
 */
export const betaGrantStatuses = ['INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type BetaGrantStatus = (typeof betaGrantStatuses)[number];

export const betaGrants = pgTable('beta_grants', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id),
  status: text('status').$type<BetaGrantStatus>().notNull().default('INVITED'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  missionQuota: integer('mission_quota').notNull(),
  concurrentLimit: integer('concurrent_limit').notNull(),
  maxProviderSpendMinor: integer('max_provider_spend_minor').notNull(),
  currency: text('currency').notNull(),
  missionsUsed: integer('missions_used').notNull().default(0),
  reservedMinor: integer('reserved_minor').notNull().default(0),
  spentMinor: integer('spent_minor').notNull().default(0),
  invitationTokenHash: text('invitation_token_hash').unique(),
  invitationExpiresAt: timestamp('invitation_expires_at', { withTimezone: true }),
  grantedBy: text('granted_by').notNull().references(() => identityUsers.id),
  grantReason: text('grant_reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  activatedBy: text('activated_by').references(() => identityUsers.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by').references(() => identityUsers.id),
  revokeReason: text('revoke_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('beta_grants_live_workspace_unique').on(t.workspaceId).where(sql`${t.status} IN ('INVITED', 'ACTIVE')`),
  index('beta_grants_workspace_created_idx').on(t.workspaceId, t.createdAt.desc()),
  index('beta_grants_status_expiry_idx').on(t.status, t.expiresAt),
  check('beta_grants_status_range', sql`${t.status} IN ('INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED')`),
  check('beta_grants_quota_range', sql`${t.missionQuota} BETWEEN 1 AND 10000`),
  check('beta_grants_concurrency_range', sql`${t.concurrentLimit} BETWEEN 1 AND 100`),
  check('beta_grants_spend_range', sql`${t.maxProviderSpendMinor} BETWEEN 0 AND 100000000`),
  check('beta_grants_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('beta_grants_missions_within_quota', sql`${t.missionsUsed} >= 0 AND ${t.missionsUsed} <= ${t.missionQuota}`),
  check('beta_grants_spend_within_cap', sql`${t.reservedMinor} >= 0 AND ${t.spentMinor} >= 0 AND ${t.reservedMinor} + ${t.spentMinor} <= ${t.maxProviderSpendMinor}`),
  check('beta_grants_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  check('beta_grants_revocation_consistent', sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL)`),
  check('beta_grants_activation_consistent', sql`${t.status} <> 'ACTIVE' OR ${t.activatedAt} IS NOT NULL`),
  check('beta_grants_invitation_consistent', sql`${t.status} <> 'INVITED' OR (${t.invitationTokenHash} IS NOT NULL AND ${t.invitationExpiresAt} IS NOT NULL)`),
  check('beta_grants_reason_length', sql`length(${t.grantReason}) BETWEEN 10 AND 500`),
]);

/**
 * One row per (grant, operation) admission. A mission consumes quota exactly once per grant; a
 * relaunch of the same operation under the same grant (retry/redo/restart) is recorded as an event
 * but does not consume another unit.
 */
export const betaGrantMissions = pgTable('beta_grant_missions', {
  id: text('id').primaryKey(),
  grantId: text('grant_id').notNull().references(() => betaGrants.id),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id),
  operationId: text('operation_id').notNull(),
  admittedBy: text('admitted_by').notNull().references(() => identityUsers.id),
  admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('beta_grant_missions_grant_operation_unique').on(t.grantId, t.operationId),
  index('beta_grant_missions_operation_idx').on(t.operationId, t.admittedAt.desc()),
]);

export const betaGrantEventKinds = [
  'INVITED', 'ACTIVATED', 'ACTIVATION_DENIED', 'REVOKED', 'EXPIRED',
  'MISSION_ADMITTED', 'MISSION_RESUMED', 'LAUNCH_DENIED',
  'SPEND_RESERVED', 'SPEND_SETTLED', 'SPEND_DENIED',
] as const;
export type BetaGrantEventKind = (typeof betaGrantEventKinds)[number];

/**
 * Append-only beta ledger: grant lifecycle and usage. Operator mutations are ALSO written to
 * platform_admin_audit in the same transaction; this table is the per-grant usage history.
 * grant_id is NULL only for a denial where no grant exists for the workspace.
 */
export const betaGrantEvents = pgTable('beta_grant_events', {
  id: text('id').primaryKey(),
  grantId: text('grant_id').references(() => betaGrants.id),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id),
  kind: text('kind').$type<BetaGrantEventKind>().notNull(),
  actorUserId: text('actor_user_id'),
  operationId: text('operation_id'),
  reservationId: text('reservation_id'),
  amountMinor: integer('amount_minor'),
  reason: text('reason'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('beta_grant_events_grant_time_idx').on(t.grantId, t.occurredAt.desc()),
  index('beta_grant_events_workspace_time_idx').on(t.workspaceId, t.occurredAt.desc()),
  uniqueIndex('beta_grant_events_reservation_unique').on(t.reservationId, t.kind).where(sql`${t.reservationId} IS NOT NULL AND ${t.kind} IN ('SPEND_RESERVED', 'SPEND_SETTLED')`),
  check('beta_grant_events_kind_range', sql`${t.kind} IN ('INVITED', 'ACTIVATED', 'ACTIVATION_DENIED', 'REVOKED', 'EXPIRED', 'MISSION_ADMITTED', 'MISSION_RESUMED', 'LAUNCH_DENIED', 'SPEND_RESERVED', 'SPEND_SETTLED', 'SPEND_DENIED')`),
  check('beta_grant_events_amount_nonnegative', sql`${t.amountMinor} IS NULL OR ${t.amountMinor} >= 0`),
]);
