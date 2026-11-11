import { pgTable,text,jsonb,index } from 'drizzle-orm/pg-core';
export const recoveryIncidents=pgTable('recovery_incidents',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 executionId:text('execution_id'),outboxId:text('outbox_id'),
 category:text('category').notNull(),status:text('status').notNull(),
 reason:text('reason').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('recovery_workspace_operation_idx').on(t.workspaceId,t.operationId)]);
export const recoveryActions=pgTable('recovery_actions',{
 id:text('id').primaryKey(),incidentId:text('incident_id').notNull(),workspaceId:text('workspace_id').notNull(),
 operationId:text('operation_id').notNull(),actorId:text('actor_id').notNull(),
 action:text('action').notNull(),reason:text('reason').notNull(),createdAt:text('created_at').notNull(),
 details:jsonb('details').$type<Record<string,unknown>>().notNull(),
});
