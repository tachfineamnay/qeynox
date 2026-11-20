import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { identityUsers, identityWorkspaces } from './identity-schema';

/** Association only: Chatwoot remains the sole store for support messages. */
export const supportChatwootLinks = pgTable('support_chatwoot_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  chatwootContactId: text('chatwoot_contact_id').notNull(),
  chatwootConversationId: text('chatwoot_conversation_id').notNull(),
  /** ACTIVE: authorization mapping. ORPHANED: the remote conversation is gone or the mapping is ambiguous; never authorizes access. */
  state: text('state').notNull().default('ACTIVE').$type<'ACTIVE' | 'ORPHANED'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('support_chatwoot_conversation_unique').on(t.workspaceId, t.userId, t.chatwootConversationId),
  index('support_chatwoot_conversation_idx').on(t.chatwootConversationId),
  index('support_chatwoot_links_state_idx').on(t.state),
  // Declared here as well as in the migration: the schema must describe every constraint the database enforces.
  check('support_chatwoot_links_state_check', sql`${t.state} in ('ACTIVE', 'ORPHANED')`),
]);

/**
 * Durable intent-to-create record for the Chatwoot support engine. It stores only the
 * deterministic source_id chosen for one open-request and the resulting contact/conversation ids —
 * never message content — so an ambiguous remote write (timeout, 5xx, lost response) can be
 * reconciled by looking the source_id up instead of duplicated.
 */
export const supportIntents = pgTable('support_intents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  intentRef: text('intent_ref').notNull(),
  chatwootContactId: text('chatwoot_contact_id'),
  chatwootConversationId: text('chatwoot_conversation_id'),
  state: text('state').notNull().default('PENDING_CONTACT').$type<'PENDING_CONTACT' | 'PENDING_CONVERSATION' | 'LINKED' | 'FAILED' | 'ORPHANED'>(),
  failureCode: text('failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('support_intents_user_workspace_ref_unique').on(t.workspaceId, t.userId, t.intentRef),
  index('support_intents_state_idx').on(t.state, t.updatedAt),
  check('support_intents_state_check', sql`${t.state} in ('PENDING_CONTACT', 'PENDING_CONVERSATION', 'LINKED', 'FAILED', 'ORPHANED')`),
]);
