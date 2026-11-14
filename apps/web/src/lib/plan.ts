import 'server-only';
import { z } from 'zod';

/** Mirrors GET /v1/operations/:id/plan. Read-only projection of persisted state. */
export const planCapabilitySchema = z.object({
  id: z.string(),
  slot: z.number().int(),
  name: z.string(),
  purpose: z.string(),
  scope: z.array(z.string()),
  maximumSteps: z.number().int(),
  maximumToolCalls: z.number().int(),
  externalActions: z.boolean(),
  providerReady: z.boolean(),
  missingProviders: z.array(z.string()),
  profileReady: z.boolean(),
});

export const planStepSchema = z.object({
  id: z.string(),
  ordinal: z.number().int(),
  title: z.string(),
  description: z.string(),
  capabilityId: z.string(),
  dependsOn: z.array(z.string()),
  state: z.string(),
  intent: z.enum(['RESEARCH', 'ANALYZE', 'VERIFY', 'EXTERNAL_ACTION']),
  version: z.number().int(),
  capabilityActive: z.boolean(),
});

export const planAttemptSchema = z.object({
  attemptId: z.string(),
  stepId: z.string(),
  sequence: z.number().int(),
  state: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
});

export const planApprovalSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  status: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  stepAttemptId: z.string(),
  stale: z.boolean(),
});

export const planViewSchema = z.object({
  operation: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    version: z.number().int().positive(),
    currentRevisionId: z.string().nullable(),
    lastActivityAt: z.string(),
    lastErrorCode: z.string().nullable(),
  }),
  goal: z.object({ statement: z.string(), constraints: z.array(z.string()) }).nullable(),
  revision: z.object({
    id: z.string(),
    revision: z.number().int(),
    status: z.string(),
    reason: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
  }).nullable(),
  steps: z.array(planStepSchema),
  attempts: z.array(planAttemptSchema),
  approvals: z.array(planApprovalSchema),
  capabilities: z.array(planCapabilitySchema),
});

/** Mirrors GET /v1/operations/:id/readiness. The UI never infers availability by itself. */
export const readinessSchema = z.object({
  operationId: z.string(),
  version: z.number().int().positive(),
  status: z.string(),
  revisionId: z.string().nullable(),
  canStart: z.boolean(),
  blockers: z.array(z.object({ code: z.string(), detail: z.string(), category: z.string() })),
  plan: z.object({ present: z.boolean(), revision: z.number().int().nullable(), steps: z.number().int().nonnegative() }),
  cost: z.object({
    known: z.boolean(),
    amountMinor: z.number().int().nullable(),
    currency: z.string().nullable(),
    orderState: z.string().nullable(),
  }),
  budget: z.object({
    configured: z.boolean(),
    currency: z.string().nullable(),
    maxMoneyMinor: z.number().int().nullable(),
    spentMinor: z.number().int().nullable(),
    reservedMinor: z.number().int().nullable(),
  }),
  capabilities: z.object({ required: z.number().int(), active: z.number().int(), missing: z.array(z.string()) }),
  approvals: z.object({ pending: z.number().int() }),
  prerequisites: z.object({
    plan: z.object({ ok: z.boolean(), steps: z.number().int(), revision: z.number().int().nullable() }),
    capability: z.object({ ok: z.boolean(), required: z.number().int(), active: z.number().int(), missing: z.array(z.string()) }),
    offer: z.object({
      ok: z.boolean(), offerId: z.string().nullable(), label: z.string().nullable(),
      amountMinor: z.number().int().nullable(), currency: z.string().nullable(), isExplicitlyFree: z.boolean(),
    }),
    order: z.object({
      ok: z.boolean(), state: z.string().nullable(),
      amountMinor: z.number().int().nullable(), currency: z.string().nullable(),
    }),
    budget: z.object({
      ok: z.boolean(), source: z.enum(['OPERATION', 'POLICY', 'NONE']), currency: z.string().nullable(),
      ceiling: z.number().int().nullable(), spent: z.number().int().nullable(), reserved: z.number().int().nullable(),
    }),
    permission: z.object({ ok: z.boolean(), role: z.string().nullable() }),
    engine: z.object({ ok: z.boolean(), runtime: z.string(), missing: z.array(z.string()) }),
    orchestrator: z.object({ ok: z.boolean(), runtime: z.string(), missing: z.array(z.string()) }),
    profile: z.object({ ok: z.boolean(), missing: z.array(z.string()) }),
    provider: z.object({ ok: z.boolean(), missing: z.array(z.string()) }),
  }),
});

/** Mirrors GET /v1/capabilities: the eight slots and their real availability. */
export const capabilityCatalogueSchema = z.object({
  slots: z.array(z.object({
    slot: z.number().int(),
    status: z.enum(['ACTIVE', 'UNCONFIGURED']),
    available: z.boolean(),
    capability: z.object({
      id: z.string(),
      version: z.number().int(),
      name: z.string(),
      purpose: z.string(),
      scope: z.array(z.string()),
      maximumSteps: z.number().int(),
      maximumToolCalls: z.number().int(),
      externalActions: z.boolean(),
      providerReady: z.boolean(),
      missingProviders: z.array(z.string()),
      profileReady: z.boolean(),
    }).nullable(),
  })),
  total: z.number().int(),
  active: z.number().int(),
  available: z.number().int(),
});
export type CapabilityCatalogue = z.infer<typeof capabilityCatalogueSchema>;

/** Mirrors GET /v1/operations/:id/commercial. */
export const commercialViewSchema = z.object({
  operationId: z.string(),
  revisionId: z.string().nullable(),
  offers: z.array(z.object({
    id: z.string(), version: z.number().int(), label: z.string(), amountMinor: z.number().int(),
    currency: z.string(), isExplicitlyFree: z.boolean(), termsVersion: z.string(),
    scope: z.array(z.string()), exclusions: z.array(z.string()),
  })),
  quotes: z.array(z.object({
    id: z.string(), offerId: z.string(), amountMinor: z.number().int(), currency: z.string(),
    expiresAt: z.string(), createdAt: z.string(), accepted: z.boolean(), expired: z.boolean(),
  })),
  order: z.object({
    id: z.string(), state: z.string(), amountMinor: z.number().int(), currency: z.string(), createdAt: z.string(),
  }).nullable(),
  executionAuthorized: z.boolean(),
  payment: z.object({ required: z.boolean(), state: z.string().nullable() }),
});
export type CommercialView = z.infer<typeof commercialViewSchema>;

export const claimSchema = z.object({
  id: z.string(), statement: z.string(), kind: z.string(), status: z.string(), createdAt: z.string(),
});
export const claimListSchema = z.array(claimSchema);
export type ClaimView = z.infer<typeof claimSchema>;

export type PlanView = z.infer<typeof planViewSchema>;
export type PlanAttempt = z.infer<typeof planAttemptSchema>;
export type Readiness = z.infer<typeof readinessSchema>;

/** Payload exchanged between the browser editor and the plan server action. */
export const editorStepSchema = z.object({
  key: z.string().min(1).max(40),
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(8).max(3000),
  capabilityId: z.string().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/),
  intent: z.enum(['RESEARCH', 'ANALYZE', 'VERIFY', 'EXTERNAL_ACTION']),
  dependsOn: z.array(z.string().min(1).max(40)).max(100),
});

export const planPayloadSchema = z.object({ steps: z.array(editorStepSchema).min(1).max(100) });
export type EditorStep = z.infer<typeof editorStepSchema>;

export function formatMoney(minor: number | null, currency: string | null, lang: 'en' | 'fr'): string {
  if (minor === null || !currency) return '—';
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return minor / 100 + ' ' + currency;
  }
}
