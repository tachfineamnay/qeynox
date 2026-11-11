import { z } from 'zod';
export const idSchema = z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/);
export const principalSchema = z.object({ userId: idSchema, workspaceId: idSchema, roles: z.array(z.string()) });
export type AuthenticatedPrincipal = z.infer<typeof principalSchema>;
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export const createOperationSchema = z.object({
  title: z.string().trim().min(3).max(200),
  goal: z.string().trim().min(5).max(5000),
  constraints: z.array(z.string().max(500)).max(40).default([]),
});
export const revisionRequestSchema = z.object({expectedVersion:z.number().int().positive(),reason:z.string().min(3).max(2000)});
export const operationActionSchema = z.object({expectedVersion:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200)});
export const toolCallSchema = z.object({
  operationId:idSchema,stepAttemptId:idSchema,capabilityId:idSchema,
  connector:z.string().min(1),tool:z.string().min(1),version:z.string().min(1),
  input:z.unknown(),idempotencyKey:z.string().min(8),approvalId:idSchema.optional(),
});
export const agentRequestSchema = z.object({
  workspaceId:idSchema,operationId:idSchema,stepAttemptId:idSchema,
  profileId:idSchema,profileVersion:z.number().int().positive(),
  prompt:z.string().min(1),context:z.record(z.string(),z.unknown()),
});
export const workflowTaskInputSchema = z.object({
  operationId:idSchema,workspaceId:idSchema,planRevisionId:idSchema,
  stepAttemptId:idSchema,idempotencyKey:z.string().min(8),
});
export type WorkflowTaskInput=z.infer<typeof workflowTaskInputSchema>;
export type CreateOperationInput=z.infer<typeof createOperationSchema>;
export * from './planning';
export * from './configuration';
