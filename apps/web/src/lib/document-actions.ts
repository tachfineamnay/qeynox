'use server';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { beginUploadSchema, searchResultSchema, type SearchResult } from './documents';

/**
 * MISSION A17 — document vault server actions.
 *
 * Upload is a three-step dance the browser drives through these actions:
 *   1. beginUploadAction({ name, contentType, sizeBytes, sha256, purpose, retentionDays })
 *      — the server declares the upload and returns a presigned single-PUT URL;
 *   2. the browser PUTs the bytes directly to object storage (never through the API);
 *   3. completeUploadAction(documentId) — the server verifies size + SHA-256 + type before ingesting.
 *
 * Nothing here fabricates state: every response comes from the API, and failures surface the
 * error code unchanged.
 */
export interface BeginState { code: string; documentId?: string; uploadUrl?: string; error?: string }

export async function beginUploadAction(input: {
  name: string; contentType: string; sizeBytes: number; sha256: string; purpose: string; retentionDays?: number; consent: boolean;
}): Promise<BeginState> {
  try {
    if (input.consent !== true) return { code: 'INVALID_INPUT' };
    const parsed = z.object({
      name: z.string().trim().min(1).max(200),
      contentType: z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'text/csv']),
      sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      purpose: z.string().trim().min(3).max(300),
      retentionDays: z.number().int().min(1).max(3650).optional(),
    }).strict().parse({
      name: input.name, contentType: input.contentType, sizeBytes: input.sizeBytes,
      sha256: input.sha256, purpose: input.purpose, retentionDays: input.retentionDays,
    });
    const begun = beginUploadSchema.parse(await api('/v1/documents/begin', 'POST', parsed));
    return { code: 'OK', documentId: begun.documentId, uploadUrl: begun.uploadUrl };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT', error: error instanceof Error ? error.message : undefined };
  }
}

export async function completeUploadAction(documentId: string): Promise<{ code: string }> {
  try {
    await api('/v1/documents/' + idSchema.parse(documentId) + '/complete', 'POST');
    return { code: 'OK' };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}

export async function deleteDocumentAction(documentId: string): Promise<{ code: string }> {
  try {
    await api('/v1/documents/' + idSchema.parse(documentId), 'DELETE');
    return { code: 'OK' };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}

export async function attachDocumentAction(operationId: string, documentId: string): Promise<{ code: string }> {
  try {
    await api('/v1/operations/' + idSchema.parse(operationId) + '/documents/' + idSchema.parse(documentId) + '/attach', 'POST');
    return { code: 'OK' };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}

export async function detachDocumentAction(operationId: string, documentId: string): Promise<{ code: string }> {
  try {
    await api('/v1/operations/' + idSchema.parse(operationId) + '/documents/' + idSchema.parse(documentId) + '/detach', 'POST');
    return { code: 'OK' };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}

export async function searchDocumentsAction(query: string, limit = 8): Promise<{ code: string; result?: SearchResult }> {
  try {
    const parsed = z.object({ query: z.string().trim().min(2).max(300), limit: z.number().int().min(1).max(20).optional() }).parse({ query, limit });
    const result = searchResultSchema.parse(await api('/v1/documents/search', 'POST', parsed));
    return { code: 'OK', result };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'INVALID_INPUT' };
  }
}
