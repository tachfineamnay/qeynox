import 'server-only';
import { z } from 'zod';
import { tryApi, type ApiResult } from './api';
export { operationsQueueQuerySchema, queuePageSchema, providerSpendingSchema } from '../../../../packages/contracts/src/beta-operations';
export type { QueuePage, ProviderSpending } from '../../../../packages/contracts/src/beta-operations';

export async function tryParsed<T>(path: string, schema: z.ZodType<T>): Promise<ApiResult<T>> {
  const response = await tryApi<unknown>(path);
  if (!response.ok) return response;
  const parsed = schema.safeParse(response.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'INVALID_RESPONSE' };
}
export const runtimeDiagnosticSchema = z.object({ checkedAt: z.string(), overallState: z.string(), components: z.array(z.object({
  id: z.string(), configured: z.boolean(), state: z.string(), missing: z.array(z.string()), verifiedLive: z.boolean(), status: z.string(), failure: z.string().nullable(), checkedAt: z.string().nullable(), expiresAt: z.string().nullable(),
})) });
export const providerDiagnosticSchema = z.object({ boundary: z.string(), providers: z.array(z.object({
  connectorId: z.string(), version: z.string(), state: z.string(), reason: z.string().nullable(), tools: z.array(z.string()), credentialConfigured: z.boolean(), configuredMaxPerMinute: z.number().nullable(),
})) });
export const storageDiagnosticSchema = z.object({ checkedAt: z.string(), storage: z.object({ status: z.string(), failure: z.string().optional() }), configurationIssues: z.array(z.object({ key: z.string(), code: z.string() })), boundary: z.string() });
export const migrationsDiagnosticSchema = z.object({ status: z.string(), expected: z.number(), applied: z.number(), pending: z.array(z.string()), mismatches: z.array(z.string()), unknownApplied: z.array(z.string()), outOfOrder: z.array(z.string()), checkedAt: z.string() });
