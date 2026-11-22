import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { identityUsers } from './identity-schema';

/**
 * MISSION A19 — in-app notification inbox, durable e-mail delivery ledger and per-category
 * notification preferences. See migration 0024 for the rationale; every row is written by the
 * application services, never by ad-hoc SQL elsewhere.
 */

export const notificationKinds = ['APPROVALS', 'EXECUTION_FAILURES', 'RESULTS'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export type StoredNotification = typeof notifications.$inferSelect;
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id'),
  kind: text('kind').$type<NotificationKind>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  operationId: text('operation_id'),
  linkPath: text('link_path'),
  deduplicationKey: text('deduplication_key').notNull().unique(),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('notifications_user_created_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
  index('notifications_user_unread_idx').on(t.userId, t.createdAt.desc(), t.id.desc()).where(sql`${t.readAt} IS NULL`),
  check('notifications_kind_check', sql`${t.kind} IN ('APPROVALS', 'EXECUTION_FAILURES', 'RESULTS')`),
]);

export const deliveryStatuses = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export type StoredEmailDelivery = typeof emailDeliveries.$inferSelect;
export const emailDeliveries = pgTable('email_deliveries', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => identityUsers.id, { onDelete: 'set null' }),
  workspaceId: text('workspace_id'),
  category: text('category').notNull(),
  recipient: text('recipient').notNull(),
  subject: text('subject').notNull(),
  provider: text('provider').notNull(),
  status: text('status').$type<DeliveryStatus>().notNull().default('PENDING'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).notNull().defaultNow(),
  lastErrorCode: text('last_error_code'),
  providerMessageId: text('provider_message_id'),
  templateId: text('template_id'),
  templateVars: jsonb('template_vars').$type<Record<string, string>>(),
  locale: text('locale'),
  retryable: boolean('retryable').notNull().default(true),
  deduplicationKey: text('deduplication_key').notNull().unique(),
  notificationId: text('notification_id').references(() => notifications.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  // P14 (migration 0032): exclusive delivery ownership (fenced lease) and uncertain-outcome tracking.
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
  outcomeUncertain: boolean('outcome_uncertain').notNull().default(false),
}, t => [
  index('email_deliveries_lease_idx').on(t.leaseExpiresAt).where(sql`${t.status} = 'PENDING' AND ${t.leaseToken} IS NOT NULL`),
  index('email_deliveries_due_idx').on(t.status, t.nextRetryAt),
  index('email_deliveries_user_idx').on(t.userId, t.createdAt.desc()),
  check('email_deliveries_status_check', sql`${t.status} IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')`),
]);

export const notificationPreferenceCategories = notificationKinds;
export type NotificationPreferenceCategory = NotificationKind;

export type StoredNotificationPreference = typeof notificationPreferences.$inferSelect;
export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  category: text('category').$type<NotificationPreferenceCategory>().notNull(),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.userId, t.category] }),
  check('notification_preferences_category_check', sql`${t.category} IN ('APPROVALS', 'EXECUTION_FAILURES', 'RESULTS')`),
]);

/**
 * P13 (migration 0031) — durable per-event checkpoint for notification materialization. Written in
 * the same transaction as the event's inbox rows and delivery jobs.
 */
export const notificationEventReceipts = pgTable('notification_event_receipts', {
  eventId: text('event_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  kind: text('kind').notNull(),
  outcome: text('outcome').$type<'MATERIALIZED' | 'SKIPPED'>().notNull(),
  reason: text('reason'),
  notifications: integer('notifications').notNull().default(0),
  deliveries: integer('deliveries').notNull().default(0),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('notification_event_receipts_workspace_idx').on(t.workspaceId, t.processedAt),
  check('notification_event_receipts_outcome_check', sql`${t.outcome} IN ('MATERIALIZED', 'SKIPPED')`),
]);

/** P13 — conservative scan watermark (bounds the anti-join only; receipts carry correctness). */
export const notificationCheckpoints = pgTable('notification_checkpoints', {
  name: text('name').primaryKey(),
  watermark: text('watermark').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
