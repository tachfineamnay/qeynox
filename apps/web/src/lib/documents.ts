import { z } from 'zod';

/** MISSION A17 — wire contracts shared by the documents page and its client components. */
export const documentViewSchema = z.object({
  id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(),
  sha256: z.string(), state: z.enum(['PENDING_UPLOAD', 'PROCESSING', 'AVAILABLE', 'FAILED', 'DELETED']),
  extractionCode: z.string().nullable(), purpose: z.string().nullable(), uploadedBy: z.string(),
  retentionDays: z.number().int(), expiresAt: z.string().nullable(), expired: z.boolean(),
  chunkCount: z.number().int(), createdAt: z.string(), attachments: z.number().int(),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

export const citationSchema = z.object({
  citationId: z.string(), documentId: z.string(), chunkId: z.string(),
  name: z.string(), sha256: z.string(), page: z.number().int().nullable(), ordinal: z.number().int(),
  snippet: z.string(), score: z.number(), mode: z.enum(['FTS', 'HYBRID']),
});
export type Citation = z.infer<typeof citationSchema>;

export const searchResultSchema = z.object({
  query: z.string(), mode: z.enum(['FTS', 'HYBRID']), embedding: z.enum(['CONFIGURED', 'NOT_CONFIGURED']),
  citations: z.array(citationSchema),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const beginUploadSchema = z.object({ documentId: z.string(), uploadUrl: z.string().url(), expiresInSeconds: z.number().int() });
export const downloadGrantSchema = z.object({ url: z.string().url(), expiresInSeconds: z.number().int() });
