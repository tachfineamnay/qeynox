import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { identityUsers, identityWorkspaces } from './identity-schema';

/**
 * MISSION A17 — customer documents and tenant-safe knowledge.
 *
 * Extracted text and optional embeddings live here. `documents` stores content hashes and the
 * storage key — never content. Deleting a document cascades to chunks, attachments and (by FK)
 * citations built on chunk ids. `searchVector` is GENERATED ALWAYS in PostgreSQL and is never
 * written by the application.
 */
export type StoredDocumentState = 'PENDING_UPLOAD' | 'PROCESSING' | 'AVAILABLE' | 'FAILED' | 'DELETED';
export type IngestJobState = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  state: text('state').$type<StoredDocumentState>().notNull().default('PENDING_UPLOAD'),
  extractionCode: text('extraction_code'),
  purpose: text('purpose'),
  uploadedBy: text('uploaded_by').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  retentionDays: integer('retention_days').notNull().default(365),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  chunkCount: integer('chunk_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index('documents_workspace_state_idx').on(t.workspaceId, t.state, t.createdAt),
  index('documents_expiry_idx').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
  check('documents_state_check', sql`${t.state} IN ('PENDING_UPLOAD', 'PROCESSING', 'AVAILABLE', 'FAILED', 'DELETED')`),
  check('documents_size_check', sql`${t.sizeBytes} >= 0 AND ${t.sizeBytes} <= 10485760`),
  check('documents_retention_check', sql`${t.retentionDays} >= 1 AND ${t.retentionDays} <= 3650`),
]);

export const documentChunks = pgTable('document_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  page: integer('page'),
  text: text('text').notNull(),
  /** Optional embedding vector, written only when an operator-configured embedding provider is active. */
  embedding: jsonb('embedding_json').$type<number[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('document_chunks_ordinal_unique').on(t.documentId, t.ordinal),
  index('document_chunks_workspace_idx').on(t.workspaceId),
]);

export const operationDocuments = pgTable('operation_documents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  operationId: text('operation_id').notNull(),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  attachedBy: text('attached_by').notNull().references(() => identityUsers.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('operation_documents_unique').on(t.operationId, t.documentId),
  index('operation_documents_operation_idx').on(t.operationId),
]);

export const documentIngestJobs = pgTable('document_ingest_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull().unique().references(() => documents.id, { onDelete: 'cascade' }),
  state: text('state').$type<IngestJobState>().notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  // P11 (migration 0029): durable processing lease. leaseToken is a per-claim fencing token.
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('document_ingest_jobs_state_idx').on(t.state, t.updatedAt),
  index('document_ingest_jobs_lease_idx').on(t.leaseExpiresAt).where(sql`${t.state} = 'PROCESSING'`),
  check('document_ingest_jobs_state_check', sql`${t.state} IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')`),
]);

export const documentAuditEvents = pgTable('document_audit_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => identityWorkspaces.id, { onDelete: 'cascade' }),
  documentId: text('document_id'),
  userId: text('user_id'),
  action: text('action').notNull(),
  outcome: text('outcome').$type<'SUCCESS' | 'DENIED' | 'FAILED'>().notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('document_audit_workspace_idx').on(t.workspaceId, t.createdAt),
  check('document_audit_outcome_check', sql`${t.outcome} IN ('SUCCESS', 'DENIED', 'FAILED')`),
]);
