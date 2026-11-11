import { pgTable,text,integer,jsonb,index,uniqueIndex } from 'drizzle-orm/pg-core';
export const eventEnvelopes=pgTable('operation_event_envelopes',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 eventId:text('event_id').notNull().unique(),sequence:integer('sequence').notNull(),
 schemaVersion:integer('schema_version').notNull().default(1),kind:text('kind').notNull(),
 revisionId:text('revision_id'),attemptId:text('attempt_id'),actorType:text('actor_type').notNull(),
 correlationId:text('correlation_id'),causationId:text('causation_id'),
 occurredAt:text('occurred_at').notNull(),data:jsonb('data').$type<Record<string,unknown>>().notNull(),
},t=>[uniqueIndex('envelope_operation_sequence_unique').on(t.operationId,t.sequence)]);
export const operationViews=pgTable('operation_views',{
 operationId:text('operation_id').primaryKey(),workspaceId:text('workspace_id').notNull(),
 status:text('status').notNull(),title:text('title').notNull(),revisionId:text('revision_id'),
 attention:text('attention').notNull(),lastActivityAt:text('last_activity_at').notNull(),
 stepCount:integer('step_count').notNull(),completedSteps:integer('completed_steps').notNull(),
 pendingApprovals:integer('pending_approvals').notNull(),resultCount:integer('result_count').notNull(),
 evidenceCount:integer('evidence_count').notNull(),lastSequence:integer('last_sequence').notNull(),
},t=>[index('views_workspace_recent_idx').on(t.workspaceId,t.lastActivityAt)]);
export const projectionCursors=pgTable('projection_cursors',{
 operationId:text('operation_id').primaryKey(),lastSequence:integer('last_sequence').notNull().default(0),
});
