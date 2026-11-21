import 'server-only';
import { z } from 'zod';

import { optionalRuntimeSummary } from './runtime-copy';

export const operationalStateSchema = z.enum(['CONFIGURED', 'OPERATIONAL', 'BLOCKED', 'UNVERIFIED']);

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
  policyReady: z.boolean().optional().default(false),
  missingPolicies: z.array(z.string()).optional().default([]),
  operationalState: operationalStateSchema.optional().default('BLOCKED'),
  isExecutable: z.boolean().optional().default(false),
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
  operationalState: operationalStateSchema.optional().default('BLOCKED'),
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
    // A21.07: `verification` is the component's own live-check summary; absent reads as NOT_PROBED.
    engine: z.object({ ok: z.boolean(), runtime: z.string(), missing: z.array(z.string()), state: operationalStateSchema.optional().default('BLOCKED'), verifiedLive: z.boolean().optional().default(false), attested: z.boolean().optional().default(false), verification: optionalRuntimeSummary }),
    orchestrator: z.object({ ok: z.boolean(), runtime: z.string(), missing: z.array(z.string()), state: operationalStateSchema.optional().default('BLOCKED'), verifiedLive: z.boolean().optional().default(false), attested: z.boolean().optional().default(false), verification: optionalRuntimeSummary }),
    profile: z.object({ ok: z.boolean(), missing: z.array(z.string()) }),
    provider: z.object({ ok: z.boolean(), missing: z.array(z.string()) }),
    policy: z.object({ ok: z.boolean(), missing: z.array(z.string()) }).optional().default({ ok: true, missing: [] }),
    executionAuthorization: z.object({
      ok: z.boolean(), state: z.string().nullable(), authorized: z.boolean(),
      // A21.03 — why execution is authorized. FREE_BETA is NOT a payment.
      basis: z.enum(['PAID_ORDER', 'FREE_OFFER', 'FREE_BETA']).nullable().optional().default(null),
    }).optional().default({ ok: false, state: null, authorized: false, basis: null }),
    betaAuthorization: z.object({
      present: z.boolean(), valid: z.boolean(), denial: z.string().nullable(), grantId: z.string().nullable(),
      listAmountMinor: z.number().int().nullable(), currency: z.string().nullable(), amountDueNowMinor: z.literal(0).nullable(),
    }).optional().default({ present: false, valid: false, denial: null, grantId: null, listAmountMinor: null, currency: null, amountDueNowMinor: null }),
  }),
});

/** Mirrors GET /v1/capabilities: the eight slots and their real availability. */
export const capabilityCatalogueSchema = z.object({
  slots: z.array(z.object({
    slot: z.number().int(),
    status: z.enum(['ACTIVE', 'UNCONFIGURED']),
    available: z.boolean(),
    operationalState: operationalStateSchema.optional().default('BLOCKED'),
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
      policyReady: z.boolean().optional().default(false),
      missingPolicies: z.array(z.string()).optional().default([]),
      operationalState: operationalStateSchema.optional().default('BLOCKED'),
      isExecutable: z.boolean().optional().default(false),
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
  /**
   * MISSION A21.03 — the free-beta execution authorization of the current order, if any. It is a
   * distinct, non-financial authorization: the list price is shown unchanged and nothing is due now.
   * `valid` is re-evaluated by the API on every read (mode, grant, revision, scope).
   */
  betaAuthorization: z.object({
    id: z.string(), basis: z.literal('FREE_BETA'), grantId: z.string(), status: z.enum(['AUTHORIZED', 'DELIVERED']),
    revisionId: z.string(), offerId: z.string(), offerVersion: z.number().int(), termsVersion: z.string(),
    listAmountMinor: z.number().int(), currency: z.string(), amountDueNowMinor: z.literal(0),
    authorizedAt: z.string(), deliveredAt: z.string().nullable(), valid: z.boolean(), denial: z.string().nullable(),
  }).nullable().optional().default(null),
  /** True when an accepted PAYMENT_REQUIRED order can be covered by the workspace's active beta grant. */
  betaAuthorizationAvailable: z.boolean().optional().default(false),
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

// Re-exported so existing server call sites keep working; the implementation lives in a client-safe
// module because the payment panel formats amounts too.
export { formatMoney } from './money';

/**
 * MIRROR OF `GET /v1/operations/:id/payment` (MISSION A08, frozen by A21.01).
 *
 * Every state the customer can see is named explicitly by the server. The page must never infer
 * "paid" from anything, so there is no boolean here that the UI could misread as success: it reads
 * `executionAuthorized`, which the server derives from a verified order state.
 */
export const paymentViewSchema = z.object({
  orderId: z.string().nullable(),
  orderState: z.string().nullable(),
  payment: z.object({
    id: z.string(),
    status: z.enum(['CREATED', 'REQUIRES_ACTION', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED', 'DISPUTED', 'REFUNDED']),
    amountMinor: z.number().int(),
    currency: z.string(),
    capturedMinor: z.number().int(),
    refundedMinor: z.number().int(),
    checkoutUrl: z.string().nullable(),
    expiresAt: z.string().nullable(),
    failureCode: z.string().nullable(),
  }).nullable(),
  refunds: z.array(z.object({ id: z.string(), status: z.string(), amountMinor: z.number().int(), createdAt: z.string() })),
  executionAuthorized: z.boolean(),
  canStartCheckout: z.boolean(),
  blockedReason: z.string().nullable(),
  providerConfigured: z.boolean(),
  /**
   * MISSION A21.01 — server-authoritative commerce availability. Required: a response without it is
   * rejected, and the page then reports payment status as unavailable rather than guessing a mode.
   * Every supported mode freezes payments, so the availability flags are literal `false`.
   */
  commerce: z.object({
    mode: z.enum(['PAYMENTS_DISABLED', 'BETA_FREE']),
    paymentsAvailable: z.literal(false),
    checkoutAvailable: z.literal(false),
    refundsAvailable: z.literal(false),
    betaFree: z.boolean(),
    reason: z.literal('PAYMENTS_FROZEN'),
  }),
});
export type PaymentView = z.infer<typeof paymentViewSchema>;
