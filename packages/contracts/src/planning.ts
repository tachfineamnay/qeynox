import { z } from 'zod';
const idSchema=z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/);
export const planStepDraftSchema=z.object({
  title:z.string().min(3).max(180),description:z.string().min(8).max(3000),
  capabilityId:idSchema,dependsOnIndices:z.array(z.number().int().nonnegative()).max(100),
  intent:z.enum(['RESEARCH','ANALYZE','VERIFY','EXTERNAL_ACTION']),
});
export const planCreateSchema=z.object({
  expectedVersion:z.number().int().positive(),
  steps:z.array(planStepDraftSchema).min(1).max(100),
});
