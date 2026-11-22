import { z } from 'zod';
const idSchema = z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/);

export const queueKindSchema = z.enum(['OUTBOX', 'INGESTION', 'DELETION', 'EMAIL']);
export const operationsQueueQuerySchema = z.object({
  kind: queueKindSchema.default('OUTBOX'), workspaceId: idSchema.optional(), operationId: idSchema.optional(),
  state: z.string().regex(/^[A-Z_]{2,30}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
export const queueItemSchema = z.object({
  id: z.string(), workspaceId: z.string().nullable(), operationId: z.string().nullable(), documentId: z.string().nullable(),
  state: z.string(), attempts: z.number().int(), errorCode: z.string().nullable(),
  createdAt: z.string(), nextAttemptAt: z.string().nullable(), leaseExpiresAt: z.string().nullable(),
  uncertain: z.boolean(), canExpedite: z.boolean(),
});
export const queuePageSchema = z.object({
  kind: queueKindSchema, items: z.array(queueItemSchema), hasMore: z.boolean(), limit: z.number(), offset: z.number(),
});
export const operationsRecoverySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('EXPEDITE_OUTBOX'), id: idSchema, workspaceId: idSchema, reason: z.string().trim().min(10).max(500), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal('ESCALATE_INCIDENT'), id: idSchema, workspaceId: idSchema, reason: z.string().trim().min(10).max(500), confirm: z.literal(true) }).strict(),
]);
export const spendingQuerySchema = z.object({ workspaceId: idSchema, operationId: idSchema.optional() }).strict();
export const providerSpendingSchema = z.object({
  workspaceId: z.string(), truncated: z.boolean(),
  items: z.array(z.object({ provider: z.string(), currency: z.string(), origin: z.string(), costMinor: z.string().nullable(), calls: z.number(), tokensIn: z.string().nullable(), tokensOut: z.string().nullable() })),
  reservations: z.array(z.object({ provider: z.string(), currency: z.string(), state: z.string(), reservedMinor: z.string(), calls: z.number() })),
});
export type QueuePage = z.infer<typeof queuePageSchema>;
export type OperationsRecoveryInput = z.infer<typeof operationsRecoverySchema>;
export type ProviderSpending = z.infer<typeof providerSpendingSchema>;
