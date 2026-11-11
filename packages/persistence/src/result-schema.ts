import { pgTable,text,integer,jsonb,uniqueIndex } from 'drizzle-orm/pg-core';
export type DocumentState='DRAFT'|'PARTIAL'|'READY_FOR_REVIEW'|'DELIVERABLE';
export const resultDocuments=pgTable('result_documents',{
 id:text('id').primaryKey(),workspaceId:text('workspace_id').notNull(),operationId:text('operation_id').notNull(),
 revisionId:text('revision_id').notNull(),version:integer('version').notNull(),state:text('state').$type<DocumentState>().notNull(),
 document:jsonb('document').$type<Record<string,unknown>>().notNull(),createdAt:text('created_at').notNull(),supersedesId:text('supersedes_id'),
},t=>[uniqueIndex('result_doc_operation_version').on(t.operationId,t.version)]);
export const artifactObjects=pgTable('artifact_objects',{
 id:text('id').primaryKey(),documentId:text('document_id').notNull(),workspaceId:text('workspace_id').notNull(),
 operationId:text('operation_id').notNull(),key:text('key').notNull().unique(),sha256:text('sha256').notNull(),
 contentType:text('content_type').notNull(),size:integer('size').notNull(),state:text('state').notNull(),
 versionId:text('version_id'),createdAt:text('created_at').notNull(),
});
