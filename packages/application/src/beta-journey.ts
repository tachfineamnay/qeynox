import type { Principal } from '@qeynox/domain';
import type { CommercePolicy, CommerceMode } from './commerce-mode';
import type { WorkspaceBetaAccessService, WorkspaceBetaStatusView } from './beta-access';
import { summarizeRuntimeComponent, type OperationalState, type RuntimeComponentSummary, type RuntimeReadinessSource } from './runtime-readiness';

/**
 * MISSION A21.04 — the customer's free-beta journey, as one server-authoritative read model.
 *
 * The web never derives entitlement on its own: it renders `state` and the facts below. Every value
 * comes from an existing source of truth:
 * - commerce mode (A21.01): free beta is configured only in `BETA_FREE`; payments are frozen in every
 *   mode, so no card is ever requested and nothing is ever due today;
 * - the workspace's beta grant (A21.02): status from the clock, quota, concurrency and provider budget;
 * - runtime readiness: whether missions can execute on this deployment at all.
 *
 * `waiverApplies` mirrors the acceptance rule of A21.03 exactly (BETA_FREE + an ACTIVE, unexpired
 * grant): when true, accepting a priced quote creates a BETA_AUTHORIZED order at the published price
 * with nothing due. It is a preview of that rule, never an authorization by itself.
 */
export const BETA_JOURNEY_STATES = [
  'ACTIVE',
  'NOT_CONFIGURED',
  'NOT_ENROLLED',
  'INVITATION_PENDING',
  'EXPIRED',
  'REVOKED',
  'QUOTA_EXHAUSTED',
  'CONCURRENT_LIMIT_REACHED',
  'RUNTIME_UNAVAILABLE',
] as const;
export type BetaJourneyState = (typeof BETA_JOURNEY_STATES)[number];

export type BetaAccountStatus = 'NOT_ENROLLED' | 'INVITED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface BetaJourneyView {
  readonly workspaceId: string;
  /** The one state the customer journey renders (precedence documented in `journeyState`). */
  readonly state: BetaJourneyState;
  /** True only when a new mission can be launched under the free beta right now. */
  readonly canLaunch: boolean;
  readonly freeBeta: {
    readonly enabled: boolean;
    readonly mode: CommerceMode;
    /** Always false: payments are frozen (A21.01); no card or payment method is ever collected. */
    readonly cardRequired: false;
    /** Always false in this release. */
    readonly paymentsAvailable: false;
    /** Always 0: nothing is ever charged while payments are frozen. */
    readonly amountDueTodayMinor: 0;
    /** 100 when the free beta is configured; the waiver covers the full published price. */
    readonly waiverPercent: 100 | null;
    /** Mirrors the A21.03 acceptance rule: a priced quote accepted now is covered by the beta. */
    readonly waiverApplies: boolean;
  };
  readonly account: {
    readonly status: BetaAccountStatus;
    readonly expiresAt: string | null;
    readonly invitationExpiresAt: string | null;
    readonly activatedAt: string | null;
    readonly missionQuota: number | null;
    readonly missionsUsed: number | null;
    readonly missionsRemaining: number | null;
    readonly activeMissions: number;
    readonly concurrentLimit: number | null;
    readonly providerBudgetMinor: number | null;
    readonly providerBudgetRemainingMinor: number | null;
    readonly currency: string | null;
    /** Why the allowance is exhausted, when it is. */
    readonly quotaReason: 'MISSIONS' | 'PROVIDER_BUDGET' | null;
    /** An OWNER or ADMIN of this workspace may redeem a pending invitation. */
    readonly canActivate: boolean;
  };
  readonly runtime: {
    readonly canExecute: boolean;
    readonly state: OperationalState;
    /** A21.07: each component's own live verification (customer-safe: no endpoint or evidence ref). */
    readonly engine: RuntimeComponentSummary;
    readonly orchestrator: RuntimeComponentSummary;
  };
}

function accountStatus(view: WorkspaceBetaStatusView): BetaAccountStatus {
  if (!view.grant) return 'NOT_ENROLLED';
  return view.grant.status;
}

/**
 * Precedence: a deployment that is not configured for the free beta says so first; then the
 * workspace's own account state (what the customer or an operator can act on); then the platform
 * runtime. `ACTIVE` means nothing known blocks a free-beta launch.
 */
export function journeyState(enabled: boolean, view: WorkspaceBetaStatusView, runtimeCanExecute: boolean): { state: BetaJourneyState; quotaReason: 'MISSIONS' | 'PROVIDER_BUDGET' | null } {
  if (!enabled) return { state: 'NOT_CONFIGURED', quotaReason: null };
  const grant = view.grant;
  if (!grant) return { state: 'NOT_ENROLLED', quotaReason: null };
  if (grant.status === 'INVITED') return { state: 'INVITATION_PENDING', quotaReason: null };
  if (grant.status === 'EXPIRED') return { state: 'EXPIRED', quotaReason: null };
  if (grant.status === 'REVOKED') return { state: 'REVOKED', quotaReason: null };
  if (grant.missionsRemaining <= 0) return { state: 'QUOTA_EXHAUSTED', quotaReason: 'MISSIONS' };
  // The launch gate admits on quota and concurrency; an exhausted provider budget refuses every
  // provider spend, so a mission could not run — the allowance is exhausted either way.
  if (grant.spendRemainingMinor <= 0) return { state: 'QUOTA_EXHAUSTED', quotaReason: 'PROVIDER_BUDGET' };
  if (view.activeMissions >= grant.concurrentLimit) return { state: 'CONCURRENT_LIMIT_REACHED', quotaReason: null };
  if (!runtimeCanExecute) return { state: 'RUNTIME_UNAVAILABLE', quotaReason: null };
  return { state: 'ACTIVE', quotaReason: null };
}

export class BetaJourneyService {
  constructor(
    private readonly beta: WorkspaceBetaAccessService,
    private readonly policy: CommercePolicy,
    private readonly runtime: RuntimeReadinessSource,
  ) {}

  async view(principal: Principal): Promise<BetaJourneyView> {
    // Authorization and tenant scoping are those of the A21.02 status read (session-bound workspace).
    const status = await this.beta.status(principal);
    const runtime = this.runtime();
    const enabled = this.policy.betaFree;
    const { state, quotaReason } = journeyState(enabled, status, runtime.canExecute);
    const account = accountStatus(status);
    const grant = status.grant;
    return {
      workspaceId: status.workspaceId,
      state,
      canLaunch: state === 'ACTIVE',
      freeBeta: {
        enabled,
        mode: this.policy.mode,
        cardRequired: false,
        paymentsAvailable: false,
        amountDueTodayMinor: 0,
        waiverPercent: enabled ? 100 : null,
        waiverApplies: enabled && account === 'ACTIVE',
      },
      account: {
        status: account,
        expiresAt: grant?.expiresAt ?? null,
        invitationExpiresAt: grant?.invitationExpiresAt ?? null,
        activatedAt: grant?.activatedAt ?? null,
        missionQuota: grant?.missionQuota ?? null,
        missionsUsed: grant?.missionsUsed ?? null,
        missionsRemaining: grant?.missionsRemaining ?? null,
        activeMissions: status.activeMissions,
        concurrentLimit: grant?.concurrentLimit ?? null,
        providerBudgetMinor: grant?.maxProviderSpendMinor ?? null,
        providerBudgetRemainingMinor: grant?.spendRemainingMinor ?? null,
        currency: grant?.currency ?? null,
        quotaReason,
        // Mirrors WorkspaceBetaAccessService.activate exactly: a single OWNER or ADMIN role.
        canActivate: account === 'INVITED' && principal.roles.length === 1 && (principal.roles[0] === 'OWNER' || principal.roles[0] === 'ADMIN'),
      },
      runtime: { canExecute: runtime.canExecute, state: runtime.overallState, engine: summarizeRuntimeComponent(runtime.engine), orchestrator: summarizeRuntimeComponent(runtime.orchestrator) },
    };
  }
}
