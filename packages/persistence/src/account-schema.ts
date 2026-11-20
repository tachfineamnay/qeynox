import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { identityUsers } from './identity-schema';

/**
 * MISSION A18 — customer account deletion requests.
 *
 * A row is a recorded intent, never an effect: REQUESTED = the customer asked for deletion
 * (delivery elsewhere is BLOCKED), CANCELLED = the customer withdrew it. No row erases data.
 */
export type StoredDeletionStatus = 'REQUESTED' | 'CANCELLED';

export const accountDeletionRequests = pgTable('account_deletion_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  status: text('status').$type<StoredDeletionStatus>().notNull().default('REQUESTED'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('account_deletion_live_user_unique').on(t.userId).where(sql`${t.status} = 'REQUESTED'`),
  index('account_deletion_user_idx').on(t.userId, t.createdAt),
  check('account_deletion_status_check', sql`${t.status} IN ('REQUESTED', 'CANCELLED')`),
]);
