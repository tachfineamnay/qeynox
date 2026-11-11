import { pgTable, text, integer, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
export const planSeals=pgTable('plan_seals',{
  revisionId:text('revision_id').primaryKey(),operationId:text('operation_id').notNull(),
  contentHash:text('content_hash').notNull(),sealedAt:text('sealed_at').notNull(),
  capabilityVersions:jsonb('capability_versions').$type<Record<string,number>>().notNull(),
});
export const stepOutputs=pgTable('step_outputs',{
  id:text('id').primaryKey(),operationId:text('operation_id').notNull(),
  revisionId:text('revision_id').notNull(),stepId:text('step_id').notNull(),
  attemptId:text('attempt_id').notNull().unique(),content:jsonb('content').$type<unknown>().notNull(),
  quality:text('quality').notNull().default('UNVERIFIED'),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('step_output_revision_attempt').on(t.revisionId,t.attemptId)]);
