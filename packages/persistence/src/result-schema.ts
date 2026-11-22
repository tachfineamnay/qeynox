import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, uniqueIndex, index, timestamp, check } from 'drizzle-orm/pg-core';
import { identityUsers, identityWorkspaces } from './identity-schema';

export type DocumentState = 'DRAFT' | 'PARTIAL' | 'READY_FOR_REVIEW' | 'DELIVERABLE';

export const resultDocuments = pgTable(
  'result_documents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    operationId: text('operation_id').notNull(),
    revisionId: text('revision_id').notNull(),
    version: integer('version').notNull(),
    state: text('state').$type<DocumentState>().notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    createdAt: text('created_at').notNull(),
    supersedesId: text('supersedes_id'),
  },
  t => [
    uniqueIndex('result_doc_operation_version').on(t.operationId, t.version),
    index('result_documents_workspace_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('result_documents_workspace_state_created_idx').on(t.workspaceId, t.state, t.createdAt, t.id),
    index('result_documents_workspace_op_version_idx').on(t.workspaceId, t.operationId, t.version),
  ],
);

export const artifactObjects = pgTable(
  'artifact_objects',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    operationId: text('operation_id').notNull(),
    key: text('key').notNull().unique(),
    sha256: text('sha256').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    state: text('state').notNull(),
    versionId: text('version_id'),
    createdAt: text('created_at').notNull(),
  },
  t => [index('artifact_objects_workspace_doc_state_idx').on(t.workspaceId, t.documentId, t.state, t.createdAt)],
);

export const resultShareLinks = pgTable(
  'result_share_links',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    documentId: text('document_id')
      .notNull()
      .references(() => resultDocuments.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label'),
    createdBy: text('created_by')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by').references(() => identityUsers.id, { onDelete: 'set null' }),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    accessCount: integer('access_count').notNull().default(0),
  },
  t => [index('result_share_links_workspace_doc_idx').on(t.workspaceId, t.documentId, t.createdAt.desc()),check('result_share_links_access_count_check', sql`${t.accessCount} >= 0`)],
);
