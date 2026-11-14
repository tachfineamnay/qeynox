import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Association only: Chatwoot remains the sole store for support messages. */
export const supportChatwootLinks = pgTable('support_chatwoot_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  chatwootContactId: text('chatwoot_contact_id').notNull(),
  chatwootConversationId: text('chatwoot_conversation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, t => [
  uniqueIndex('support_chatwoot_conversation_unique').on(t.workspaceId, t.userId, t.chatwootConversationId),
  index('support_chatwoot_conversation_idx').on(t.chatwootConversationId),
]);
