import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { identityWorkspaces } from './identity-schema';
import { betaGrants } from './beta-access-schema';
import { commercialOrders, quoteAcceptances, quotes } from './commerce-schema';

/**
 * MISSION A21.03 — free beta execution authorization (migration 0027).
 *
 * A NON-FINANCIAL entitlement: an eligible beta workspace may execute one accepted, priced scope
 * without paying while QeyNox runs as a free beta. It is never a payment: no `raas_payments`,
 * refund, invoice, checkout session or provider object exists for it, and its order is in the
 * explicit state `BETA_AUTHORIZED` / `BETA_DELIVERED` — never `PAID`, `CAPTURED` or `AUTHORIZED`.
 *
 * The row pins the exact workspace, operation, plan revision, quote, terms acceptance, order and
 * accepted scope hash, plus the beta grant that was ACTIVE at authorization time. The published
 * list price and currency are recorded unchanged; `amount_due_now_minor` is pinned to 0.
 */
export const betaAuthorizationStatuses = ['AUTHORIZED', 'DELIVERED'] as const;
export type BetaAuthorizationStatus = (typeof betaAuthorizationStatuses)[number];

export const betaExecutionAuthorizations = pgTable('raas_beta_authorizations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id),
  operationId: text('operation_id').notNull(),
  revisionId: text('revision_id').notNull(),
  quoteId: text('quote_id').notNull().unique().references(() => quotes.id),
  acceptanceId: text('acceptance_id').notNull().unique().references(() => quoteAcceptances.id),
  orderId: text('order_id').notNull().unique().references(() => commercialOrders.id),
  betaGrantId: text('beta_grant_id').notNull().references(() => betaGrants.id),
  scopeHash: text('scope_hash').notNull(),
  offerId: text('offer_id').notNull(),
  offerVersion: integer('offer_version').notNull(),
  termsVersion: text('terms_version').notNull(),
  listAmountMinor: integer('list_amount_minor').notNull(),
  currency: text('currency').notNull(),
  amountDueNowMinor: integer('amount_due_now_minor').notNull().default(0),
  status: text('status').$type<BetaAuthorizationStatus>().notNull().default('AUTHORIZED'),
  authorizedBy: text('authorized_by').notNull(),
  authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, t => [
  uniqueIndex('raas_beta_authorization_operation_revision_unique').on(t.operationId, t.revisionId),
  index('raas_beta_authorization_grant_idx').on(t.betaGrantId, t.authorizedAt.desc()),
  index('raas_beta_authorization_workspace_idx').on(t.workspaceId, t.authorizedAt.desc()),
  check('raas_beta_authorizations_amount_due_zero', sql`${t.amountDueNowMinor} = 0`),
  check('raas_beta_authorizations_list_amount_positive', sql`${t.listAmountMinor} > 0`),
  check('raas_beta_authorizations_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check('raas_beta_authorizations_status_range', sql`${t.status} IN ('AUTHORIZED', 'DELIVERED')`),
  check('raas_beta_authorizations_delivery_consistent', sql`(${t.status} = 'DELIVERED') = (${t.deliveredAt} IS NOT NULL)`),
]);
