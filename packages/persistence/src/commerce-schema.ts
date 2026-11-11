import { pgTable,text,integer,jsonb,uniqueIndex } from 'drizzle-orm/pg-core';
export type CommercialState='AWAITING_ACCEPTANCE'|'PAYMENT_REQUIRED'|'AUTHORIZED'|'FULFILLING'|'DELIVERED'|'DISPUTED'|'CANCELLED';
export const offers=pgTable('raas_offers',{
 id:text('id').primaryKey(),version:integer('version').notNull(),status:text('status').notNull(),
 currency:text('currency').notNull(),amountMinor:integer('amount_minor').notNull(),
 configuration:jsonb('configuration').$type<Record<string,unknown>>().notNull(),
},t=>[uniqueIndex('offer_version_unique').on(t.id,t.version)]);
export const quotes=pgTable('raas_quotes',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 revisionId:text('revision_id').notNull(),offerId:text('offer_id').notNull(),offerVersion:integer('offer_version').notNull(),
 amountMinor:integer('amount_minor').notNull(),currency:text('currency').notNull(),scopeHash:text('scope_hash').notNull(),
 expiresAt:text('expires_at').notNull(),createdAt:text('created_at').notNull(),termsVersion:text('terms_version').notNull(),
 payload:jsonb('payload').$type<Record<string,unknown>>().notNull(),
});
export const quoteAcceptances=pgTable('raas_acceptances',{
 id:text('id').primaryKey(),quoteId:text('quote_id').notNull().unique(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 revisionId:text('revision_id').notNull(),actorId:text('actor_id').notNull(),scopeHash:text('scope_hash').notNull(),
 acceptedAt:text('accepted_at').notNull(),termsVersion:text('terms_version').notNull(),idempotencyKey:text('idempotency_key').notNull().unique(),
});
export const commercialOrders=pgTable('raas_orders',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 revisionId:text('revision_id').notNull(),quoteId:text('quote_id').notNull().unique(),
 state:text('state').$type<CommercialState>().notNull(),amountMinor:integer('amount_minor').notNull(),currency:text('currency').notNull(),
 updatedAt:text('updated_at').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('order_operation_revision_unique').on(t.operationId,t.revisionId)]);
export const paymentEvents=pgTable('raas_payment_events',{
 id:text('id').primaryKey(),orderId:text('order_id').notNull(),providerEventId:text('provider_event_id').unique(),
 kind:text('kind').notNull(),receivedAt:text('received_at').notNull(),redactedPayload:jsonb('redacted_payload').$type<Record<string,unknown>>().notNull(),
});
