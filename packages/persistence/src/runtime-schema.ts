import { pgTable,text,integer,jsonb,uniqueIndex } from 'drizzle-orm/pg-core';
export const engineSelections=pgTable('engine_selections',{
 attemptId:text('attempt_id').primaryKey(),workspaceId:text('workspace_id').notNull(),
 operationId:text('operation_id').notNull(),revisionId:text('revision_id').notNull(),
 engineId:text('engine_id').notNull(),engineVersion:text('engine_version').notNull(),
 profileId:text('profile_id').notNull(),profileVersion:integer('profile_version').notNull(),
 selectedAt:text('selected_at').notNull(),selectionPolicy:jsonb('selection_policy').$type<Record<string,unknown>>().notNull(),
});
export const workspaceDataPolicies=pgTable('workspace_data_policies',{
 workspaceId:text('workspace_id').primaryKey(),version:integer('version').notNull(),
 retentionDays:integer('retention_days').notNull(),updatedAt:text('updated_at').notNull(),
});
export const erasureRequests=pgTable('data_erasure_requests',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),userId:text('user_id').notNull(),
 requestedAt:text('requested_at').notNull(),localContextRevoked:text('local_context_revoked').notNull(),
 externalDeletion:text('external_deletion').notNull(),notes:text('notes').notNull(),
});
