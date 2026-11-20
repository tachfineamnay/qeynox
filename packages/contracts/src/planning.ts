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

// ---------------------------------------------------------------------------------------------
// MISSION A12 — Pilot plan proposals.
//
// The engine output is untrusted input until planProposalOutputSchema has parsed it and the
// planner has validated every capability reference, dependency and ceiling. Nothing in this file
// is persisted by the proposal endpoint; the customer persists by saving a plan explicitly.
// ---------------------------------------------------------------------------------------------

export const planProposalAnswerSchema = z.object({
  question: z.string().trim().min(3).max(400),
  answer: z.string().trim().min(1).max(2000),
});
export const planProposalRequestSchema = z.object({
  attemptKey: z.string().min(8).max(120),
  locale: z.enum(['en', 'fr']).default('en'),
  answers: z.array(planProposalAnswerSchema).max(10).default([]),
});
export type PlanProposalRequest = z.infer<typeof planProposalRequestSchema>;

export const planProposalStepSchema = z.object({
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(8).max(3000),
  capabilityId: idSchema,
  intent: z.enum(['RESEARCH', 'ANALYZE', 'VERIFY', 'EXTERNAL_ACTION']),
  dependsOnIndices: z.array(z.number().int().nonnegative()).max(100),
  /** What this step hands to the steps that depend on it, in one line. */
  expectedDeliverable: z.string().trim().min(1).max(300),
});
export type PlanProposalStep = z.infer<typeof planProposalStepSchema>;

/** The exact shape the model is asked to return. Anything else is rejected, never repaired silently. */
export const planProposalOutputSchema = z.object({
  summary: z.string().trim().min(10).max(1200),
  deliverables: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Ask the customer before drafting if these are answered; an empty list means "ready to draft". */
  questions: z.array(z.string().trim().min(3).max(300)).max(6).default([]),
  steps: z.array(planProposalStepSchema).min(1).max(40),
});
export type PlanProposalOutput = z.infer<typeof planProposalOutputSchema>;
