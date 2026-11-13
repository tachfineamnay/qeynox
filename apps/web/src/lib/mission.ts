import 'server-only';
import { z } from 'zod';
import { api, ApiError, operationSchema } from './api';
export const detailSchema = operationSchema.extend({ version: z.number().int().positive() });
const event = z.object({ id: z.string(), kind: z.string(), occurredAt: z.string() });
export const timelineSchema = z.array(event);
export const activitySchema = z.object({ events: z.array(event.extend({ sequence: z.number().int(), eventId: z.string() })), nextCursor: z.number().int().nonnegative(), transport: z.literal('POLLING') });
export const summarySchema = z.object({ operationId: z.string(), status: z.string(), stepCount: z.number().int().nonnegative(), completedSteps: z.number().int().nonnegative(), pendingApprovals: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative() });
export const guidanceSchema = z.object({ operationId: z.string(), status: z.string(), action: z.string(), reason: z.string() });
export const citationSchema = z.object({ sourceId: z.string(), provider: z.string(), uri: z.string().optional(), retrievedAt: z.string(), publishedAt: z.string().optional(), fingerprint: z.string().optional() });
export const documentSchema = z.object({ id: z.string(), operationId: z.string(), revisionId: z.string(), version: z.number().int(), title: z.string(), objective: z.string(), status: z.enum(['DRAFT','PARTIAL','READY_FOR_REVIEW','DELIVERABLE']), scope: z.array(z.string()), findings: z.array(z.object({ claimId: z.string(), statement: z.string(), status: z.string(), limitations: z.array(z.string()), citations: z.array(citationSchema) })), nextActions: z.array(z.string()), limitations: z.array(z.string()), unresolved: z.array(z.string()), citations: z.array(citationSchema), createdAt: z.string() });
export const contextSchema = z.array(z.object({ id: z.string(), key: z.string(), value: z.unknown(), consentId: z.string(), updatedAt: z.string() }));
export async function read<T>(path: string, schema: z.ZodType<T>): Promise<{ data: T; code?: never } | { data?: never; code: string }> {
  try { return { data: schema.parse(await api(path)) }; } catch (error) { return { code: error instanceof ApiError ? error.code : 'INVALID_RESPONSE' }; }
}
export function safeUrl(value?: string) { try { const u = new URL(value ?? ''); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } }
