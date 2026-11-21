import 'server-only';
import { z } from 'zod';
import { optionalRuntimeSummary } from './runtime-copy';
import { api, ApiError } from './api';

/**
 * MISSION A21.04 — the customer's free-beta journey, read from the API
 * (`GET /v1/workspaces/current/beta-access/journey`). The web never derives entitlement on its own:
 * it renders the server's `state` and facts. A failed or malformed read is reported as such — the UI
 * then states that the beta status is unknown and claims nothing (the server still gates every launch).
 */
export const betaJourneyStates = [
  'ACTIVE', 'NOT_CONFIGURED', 'NOT_ENROLLED', 'INVITATION_PENDING', 'EXPIRED', 'REVOKED',
  'QUOTA_EXHAUSTED', 'CONCURRENT_LIMIT_REACHED', 'RUNTIME_UNAVAILABLE',
] as const;
export type BetaJourneyState = (typeof betaJourneyStates)[number];

const count = z.number().int().nonnegative();
const money = z.number().int();

export const betaJourneySchema = z.object({
  workspaceId: z.string().min(1),
  state: z.enum(betaJourneyStates),
  canLaunch: z.boolean(),
  freeBeta: z.object({
    enabled: z.boolean(),
    mode: z.enum(['PAYMENTS_DISABLED', 'BETA_FREE']),
    // Literal contract: the moment the API could ask for a card or charge today, this parse fails and
    // the UI falls back to the "status unavailable" state instead of rendering free-beta claims.
    cardRequired: z.literal(false),
    paymentsAvailable: z.literal(false),
    amountDueTodayMinor: z.literal(0),
    waiverPercent: z.literal(100).nullable(),
    waiverApplies: z.boolean(),
  }),
  account: z.object({
    status: z.enum(['NOT_ENROLLED', 'INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED']),
    expiresAt: z.string().nullable(),
    invitationExpiresAt: z.string().nullable(),
    activatedAt: z.string().nullable(),
    missionQuota: count.nullable(),
    missionsUsed: count.nullable(),
    missionsRemaining: count.nullable(),
    activeMissions: count,
    concurrentLimit: count.nullable(),
    providerBudgetMinor: money.nullable(),
    providerBudgetRemainingMinor: money.nullable(),
    currency: z.string().length(3).nullable(),
    quotaReason: z.enum(['MISSIONS', 'PROVIDER_BUDGET']).nullable(),
    canActivate: z.boolean(),
  }),
  runtime: z.object({
    canExecute: z.boolean(),
    state: z.enum(['CONFIGURED', 'OPERATIONAL', 'BLOCKED', 'UNVERIFIED']),
    // A21.07: each component's own live verification (absent reads as NOT_PROBED, never verified).
    engine: optionalRuntimeSummary,
    orchestrator: optionalRuntimeSummary,
  }),
}).superRefine((value, ctx) => {
  // Cross-field coherence: a waiver may only apply when the free beta is configured, and a launch
  // may only be possible in the ACTIVE state.
  if (value.freeBeta.waiverApplies && !value.freeBeta.enabled) ctx.addIssue({ code: 'custom', message: 'waiver without free beta' });
  if (value.canLaunch !== (value.state === 'ACTIVE')) ctx.addIssue({ code: 'custom', message: 'canLaunch mismatch' });
});
export type BetaJourney = z.infer<typeof betaJourneySchema>;

export type BetaJourneyRead = { journey: BetaJourney; code?: never } | { journey: null; code: string };

export async function readBetaJourney(): Promise<BetaJourneyRead> {
  try {
    return { journey: betaJourneySchema.parse(await api('/v1/workspaces/current/beta-access/journey')) };
  } catch (error) {
    return { journey: null, code: error instanceof ApiError ? error.code : 'INVALID_RESPONSE' };
  }
}
