import { z } from 'zod';

/**
 * Mirrors the server-side PlanProposalResult (packages/roles/src/pilot-planner.ts).
 * A proposal is advisory data, never an action: the customer edits and explicitly saves a plan.
 */
export const proposalBudgetSchema = z.object({
  configured: z.boolean(),
  currency: z.string().optional(),
  maxMoneyMinor: z.number().int().nonnegative().optional(),
  maxAgentCalls: z.number().int().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  maxDurationSeconds: z.number().int().nonnegative().optional(),
});

export const proposalStepSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string(),
  description: z.string(),
  capabilityId: z.string(),
  intent: z.enum(['RESEARCH', 'ANALYZE', 'VERIFY', 'EXTERNAL_ACTION']),
  dependsOnIndices: z.array(z.number().int().nonnegative()),
  expectedDeliverable: z.string(),
});
export type ProposalStep = z.infer<typeof proposalStepSchema>;

export const proposalCapabilityNoteSchema = z.object({
  capabilityId: z.string(),
  name: z.string(),
  operationalState: z.string(),
  isExecutable: z.boolean(),
  missingProviders: z.array(z.string()),
  missingPolicies: z.array(z.string()),
});

export const planProposalResultSchema = z.object({
  source: z.enum(['AI', 'DETERMINISTIC_FALLBACK']),
  aiGenerated: z.boolean(),
  reason: z.string(),
  engineAttempted: z.boolean(),
  summary: z.string().nullable(),
  deliverables: z.array(z.string()),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  steps: z.array(proposalStepSchema),
  capabilityNotes: z.array(proposalCapabilityNoteSchema),
  budget: proposalBudgetSchema,
  requiresApproval: z.boolean(),
  generatedAt: z.string(),
});
export type PlanProposalResult = z.infer<typeof planProposalResultSchema>;
