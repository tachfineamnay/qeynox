import { pgTable,text,integer,jsonb,index,uniqueIndex } from 'drizzle-orm/pg-core';
export type LedgerOrigin='PROVIDER_REPORTED'|'ESTIMATED'|'UNKNOWN';
export const operationBudgets=pgTable('operation_budgets',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull().unique(),
 version:integer('version').notNull(),currency:text('currency').notNull(),maxMoneyMinor:integer('max_money_minor').notNull(),
 reservedMinor:integer('reserved_minor').notNull().default(0),spentMinor:integer('spent_minor').notNull().default(0),
 maxAgentCalls:integer('max_agent_calls').notNull(),maxToolCalls:integer('max_tool_calls').notNull(),
 usedAgentCalls:integer('used_agent_calls').notNull().default(0),usedToolCalls:integer('used_tool_calls').notNull().default(0),
 maxDurationSeconds:integer('max_duration_seconds').notNull(),maxConcurrent:integer('max_concurrent').notNull(),
 startedAt:text('started_at').notNull(),policy:jsonb('policy').$type<Record<string,unknown>>().notNull(),
});
export const usageReservations=pgTable('usage_reservations',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 attemptId:text('attempt_id').notNull(),key:text('key').notNull().unique(),kind:text('kind').notNull(),
 providerKey:text('provider_key').notNull(),policyVersion:integer('policy_version').notNull(),
 reservedMinor:integer('reserved_minor').notNull(),state:text('state').notNull(),
 createdAt:text('created_at').notNull(),settledAt:text('settled_at'),
},t=>[index('usage_op_state_idx').on(t.operationId,t.state)]);
export const usageLedger=pgTable('usage_ledger',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 reservationId:text('reservation_id').notNull().unique(),origin:text('origin').$type<LedgerOrigin>().notNull(),
 costMinor:integer('cost_minor'),currency:text('currency').notNull(),tokensIn:integer('tokens_in'),tokensOut:integer('tokens_out'),
 recordedAt:text('recorded_at').notNull(),
});
export const loopFingerprints=pgTable('loop_fingerprints',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 fingerprint:text('fingerprint').notNull(),count:integer('count').notNull(),lastProgressHash:text('last_progress_hash').notNull(),
 updatedAt:text('updated_at').notNull(),
},t=>[uniqueIndex('loop_op_fingerprint_unique').on(t.operationId,t.fingerprint)]);
