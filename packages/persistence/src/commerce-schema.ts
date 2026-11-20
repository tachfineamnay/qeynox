import { sql } from 'drizzle-orm';
import { pgTable,text,integer,jsonb,uniqueIndex,index,primaryKey,check } from 'drizzle-orm/pg-core';
export type CommercialState='AWAITING_ACCEPTANCE'|'PAYMENT_REQUIRED'|'AUTHORIZED'|'FULFILLING'|'DELIVERED'|'DISPUTED'|'CANCELLED';
export const offers=pgTable('raas_offers',{
 id:text('id').notNull(),version:integer('version').notNull(),status:text('status').notNull(),
 currency:text('currency').notNull(),amountMinor:integer('amount_minor').notNull(),
 configuration:jsonb('configuration').$type<Record<string,unknown>>().notNull(),
},t=>[primaryKey({columns:[t.id,t.version]}),uniqueIndex('raas_offer_active_id_unique').on(t.id).where(sql`${t.status} = 'ACTIVE'`)]);
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
/**
 * MISSION A08 — the webhook ledger.
 *
 * `providerEventId` is UNIQUE per provider, which is the durability primitive that makes webhook
 * processing exactly-once even when the provider retries or delivers duplicates concurrently. A row is
 * inserted in the same transaction that applies its effect; a duplicate insert violates the unique
 * constraint and the event is reported as a no-op instead of being applied twice.
 *
 * `orderId` is nullable because an event can arrive for a payment whose order is not resolvable here.
 * Such an event is still recorded (and then marked unresolved) rather than acknowledged and lost.
 */
export const paymentEvents=pgTable('raas_payment_events',{
 id:text('id').primaryKey(),orderId:text('order_id'),providerEventId:text('provider_event_id').unique(),
 provider:text('provider').notNull().default('stripe'),
 kind:text('kind').notNull(),eventType:text('event_type'),paymentId:text('payment_id'),outcome:text('outcome'),
 processedAt:text('processed_at'),providerCreatedAt:text('provider_created_at'),payloadDigest:text('payload_digest'),
 receivedAt:text('received_at').notNull(),redactedPayload:jsonb('redacted_payload').$type<Record<string,unknown>>().notNull(),
},t=>[index('raas_payment_event_order_index').on(t.orderId)]);

/**
 * One payment attempt against one order.
 *
 * Several attempts may exist over time — a failed or expired attempt is followed by a new one — but a
 * partial unique index in migration 0019 allows only ONE attempt at a time in a state that could still
 * take money. That is what makes a double charge impossible at the storage layer, not merely in code.
 */
export type PaymentStatus='CREATED'|'REQUIRES_ACTION'|'PROCESSING'|'AUTHORIZED'|'CAPTURED'|'FAILED'|'EXPIRED'|'CANCELLED'|'DISPUTED'|'REFUNDED';
export const payments=pgTable('raas_payments',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 orderId:text('order_id').notNull(),provider:text('provider').notNull().default('stripe'),
 providerSessionId:text('provider_session_id'),providerIntentId:text('provider_intent_id'),
 status:text('status').$type<PaymentStatus>().notNull(),amountMinor:integer('amount_minor').notNull(),
 currency:text('currency').notNull(),capturedMinor:integer('captured_minor').notNull().default(0),
 refundedMinor:integer('refunded_minor').notNull().default(0),checkoutUrl:text('checkout_url'),expiresAt:text('expires_at'),
 idempotencyKey:text('idempotency_key').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
 failureCode:text('failure_code'),failureMessage:text('failure_message'),version:integer('version').notNull().default(1),
},t=>[
 uniqueIndex('raas_payment_idempotency_unique').on(t.workspaceId,t.idempotencyKey),
 uniqueIndex('raas_payment_intent_unique').on(t.provider,t.providerIntentId).where(sql`${t.providerIntentId} IS NOT NULL`),
 // At most one attempt per order may still be able to take money. This is the storage-level guard against
 // a double charge, enforced by the database rather than by application discipline.
 uniqueIndex('raas_payment_one_live_per_order').on(t.orderId).where(sql`${t.status} IN ('CREATED','REQUIRES_ACTION','PROCESSING','AUTHORIZED','CAPTURED','DISPUTED')`),
 index('raas_payment_order_index').on(t.orderId),
 // Money invariants are enforced by the database, not only by the service: a negative amount, or a
 // refund that exceeds what was captured, is unrepresentable rather than merely refused in code.
 check('raas_payment_amount_positive', sql`${t.amountMinor} > 0`),
 check('raas_payment_captured_within_amount', sql`${t.capturedMinor} >= 0 AND ${t.capturedMinor} <= ${t.amountMinor}`),
 check('raas_payment_refunded_within_captured', sql`${t.refundedMinor} >= 0 AND ${t.refundedMinor} <= ${t.capturedMinor}`),
]);

/** A refund is attempted, then succeeds or fails. A refunded total is derived from succeeded rows. */
export type RefundStatus='PENDING'|'SUCCEEDED'|'FAILED';
export const refunds=pgTable('raas_refunds',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 orderId:text('order_id').notNull(),paymentId:text('payment_id').notNull(),provider:text('provider').notNull().default('stripe'),
 providerRefundId:text('provider_refund_id'),status:text('status').$type<RefundStatus>().notNull(),
 amountMinor:integer('amount_minor').notNull(),currency:text('currency').notNull(),reason:text('reason'),
 requestedBy:text('requested_by').notNull(),idempotencyKey:text('idempotency_key').notNull(),
 createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),failureMessage:text('failure_message'),
},t=>[
 uniqueIndex('raas_refund_idempotency_unique').on(t.workspaceId,t.idempotencyKey),
 uniqueIndex('raas_refund_provider_unique').on(t.provider,t.providerRefundId).where(sql`${t.providerRefundId} IS NOT NULL`),
 index('raas_refund_payment_index').on(t.paymentId),
 check('raas_refund_amount_positive', sql`${t.amountMinor} > 0`),
]);
