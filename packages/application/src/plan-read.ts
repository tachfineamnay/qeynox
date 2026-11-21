import { and, desc, eq, sql } from 'drizzle-orm';
import type { CapabilityDefinition, ID, OperationStatus, Principal, WorkStep } from '@qeynox/domain';
import { QeyNoxStore, BetaAccessStore, approvals, attempts, budgetPolicies, commercialOrders, offers, operationBudgets } from '@qeynox/persistence';
import { capabilityAvailability, type CapabilityAvailability } from './capability-availability';
import { failClosedRuntime, summarizeRuntimeComponent, type OperationalState, type RuntimeComponent, type RuntimeComponentSummary, type RuntimeReadinessSource } from './runtime-readiness';
import { commercePolicyFromEnvironment, type CommercePolicy } from './commerce-mode';
import { BetaExecutionAuthorizer, type BetaAuthorizationDenial } from './beta-execution';

/** Bounded customer-facing projection of one configured business capability. */
export interface PlanCapabilityView {
  id: string; slot: number; name: string; purpose: string;
  scope: readonly string[]; maximumSteps: number; maximumToolCalls: number;
  externalActions: boolean;
  providerReady: boolean; missingProviders: readonly string[]; profileReady: boolean;
  policyReady: boolean; missingPolicies: readonly string[];
  operationalState: OperationalState; isExecutable: boolean;
}
export interface PlanStepView {
  id: string; ordinal: number; title: string; description: string; capabilityId: string;
  dependsOn: readonly string[]; state: string; intent: string; version: number;
  capabilityActive: boolean;
}
export interface PlanAttemptView {
  attemptId: string; stepId: string; sequence: number; state: string; createdAt: string;
  startedAt: string | null; finishedAt: string | null; errorCode: string | null;
}
export interface PlanApprovalView {
  id: string; purpose: string; status: string; requestedAt: string; expiresAt: string;
  stepAttemptId: string; stale: boolean;
}
export interface OperationPlanView {
  operation: {
    id: string; title: string; status: string; version: number; currentRevisionId: string | null;
    lastActivityAt: string; lastErrorCode: string | null;
  };
  goal: { statement: string; constraints: readonly string[] } | null;
  revision: { id: string; revision: number; status: string; reason: string; createdBy: string; createdAt: string } | null;
  steps: PlanStepView[];
  attempts: PlanAttemptView[];
  approvals: PlanApprovalView[];
  capabilities: PlanCapabilityView[];
}

export type ReadinessCategory = 'PLAN' | 'CAPABILITY' | 'OFFER' | 'BUDGET' | 'PERMISSION' | 'ENGINE' | 'PROVIDER' | 'POLICY' | 'AUTHORIZATION';
export interface ReadinessBlocker { code: string; detail: string; category: ReadinessCategory }
export interface OperationReadinessView {
  operationId: string;
  version: number;
  status: OperationStatus;
  revisionId: string | null;
  canStart: boolean;
  /** Four-state operational readiness for the whole operation. */
  operationalState: OperationalState;
  blockers: ReadinessBlocker[];
  plan: { present: boolean; revision: number | null; steps: number };
  cost: { known: boolean; amountMinor: number | null; currency: string | null; orderState: string | null };
  budget: { configured: boolean; currency: string | null; maxMoneyMinor: number | null; spentMinor: number | null; reservedMinor: number | null };
  capabilities: { required: number; active: number; missing: readonly string[] };
  approvals: { pending: number };
  /** Server-exposed execution prerequisites. Missing prerequisites are listed exactly. */
  prerequisites: {
    plan: { ok: boolean; steps: number; revision: number | null };
    capability: { ok: boolean; required: number; active: number; missing: readonly string[] };
    offer: { ok: boolean; offerId: string | null; label: string | null; amountMinor: number | null; currency: string | null; isExplicitlyFree: boolean };
    order: { ok: boolean; state: string | null; amountMinor: number | null; currency: string | null };
    budget: { ok: boolean; source: 'OPERATION' | 'POLICY' | 'NONE'; currency: string | null; ceiling: number | null; spent: number | null; reserved: number | null };
    permission: { ok: boolean; role: string | null };
    /**
     * A21.07: `ok` means verified live by fresh probe evidence (not merely configured). `verification`
     * is the customer-safe summary of the component's own probe (no endpoint, identity or evidence ref).
     */
    engine: { ok: boolean; runtime: string; missing: readonly string[]; state: OperationalState; verifiedLive: boolean; attested: boolean; verification: RuntimeComponentSummary };
    orchestrator: { ok: boolean; runtime: string; missing: readonly string[]; state: OperationalState; verifiedLive: boolean; attested: boolean; verification: RuntimeComponentSummary };
    profile: { ok: boolean; missing: readonly string[] };
    provider: { ok: boolean; missing: readonly string[] };
    policy: { ok: boolean; missing: readonly string[] };
    /**
     * `basis` names WHY execution is authorized: a payment-authorized order, an explicitly free offer, or
     * (A21.03) a non-financial free-beta authorization. FREE_BETA never means money moved.
     */
    executionAuthorization: { ok: boolean; state: string | null; authorized: boolean; basis: 'PAID_ORDER' | 'FREE_OFFER' | 'FREE_BETA' | null };
    /** A21.03 — the free-beta authorization of the current revision's order, re-evaluated now. */
    betaAuthorization: { present: boolean; valid: boolean; denial: BetaAuthorizationDenial | null; grantId: string | null; listAmountMinor: number | null; currency: string | null; amountDueNowMinor: 0 | null };
  };
}

const startableStatuses: readonly OperationStatus[] = ['READY', 'INTERRUPTED', 'FAILED'];
const authorizedOrderStates: readonly string[] = ['AUTHORIZED', 'FULFILLING'];
const attemptHistoryLimit = 200;

function capabilityView(definition: CapabilityDefinition, index: CapabilityAvailability | undefined): PlanCapabilityView {
  return {
    id: definition.id,
    slot: definition.slot,
    name: definition.name ?? 'Unnamed capability',
    purpose: definition.purpose ?? '',
    scope: definition.scope,
    maximumSteps: definition.maximumSteps,
    maximumToolCalls: definition.maximumToolCalls,
    externalActions: definition.allowedTools.length > 0,
    providerReady: index?.providerReady ?? false,
    missingProviders: index?.missingProviders ?? [],
    profileReady: index?.profileReady ?? false,
    policyReady: index?.policyReady ?? false,
    missingPolicies: index?.missingPolicies ?? [],
    operationalState: index?.operationalState ?? 'BLOCKED',
    isExecutable: index?.isExecutable ?? false,
  };
}

export function budgetPolicyPayload(row: { payload: Record<string, unknown> } | undefined) {
  const policy = row?.payload as { currency?: unknown; maxMoneyMinor?: unknown; unitMaxMinor?: unknown } | undefined;
  if (!policy || typeof policy.currency !== 'string' || !/^[A-Z]{3}$/.test(policy.currency)) return undefined;
  if (typeof policy.maxMoneyMinor !== 'number' || !Number.isSafeInteger(policy.maxMoneyMinor) || policy.maxMoneyMinor < 0) return undefined;
  if (!policy.unitMaxMinor || typeof policy.unitMaxMinor !== 'object' || !Object.keys(policy.unitMaxMinor).length) return undefined;
  return policy;
}

/**
 * Minimal customer read model for the mission preparation and execution contract.
 *
 * It only reads persisted state: no plan is generated, no budget is materialized and no execution
 * is requested. Readiness mirrors the checks OperationExecutionService.start and the worker perform
 * so the interface never offers a launch the backend would refuse.
 *
 * MISSION A01: readiness now distinguishes CONFIGURED / OPERATIONAL / BLOCKED / UNVERIFIED.
 * canStart is true only when operationalState is OPERATIONAL (all prerequisites + verifiedLive).
 * A configuration flag alone never yields OPERATIONAL.
 */
function runtimePrerequisite(component: RuntimeComponent) {
  return {
    ok: component.state === 'OPERATIONAL' && component.verifiedLive,
    runtime: component.id,
    missing: component.missing,
    state: component.state,
    verifiedLive: component.verifiedLive,
    attested: component.attested,
    verification: summarizeRuntimeComponent(component),
  };
}

/** A21.07: one blocker per runtime component, derived from that component's own verification. */
function runtimeBlocker(prefix: 'ENGINE' | 'ORCHESTRATOR', component: RuntimeComponent): ReadinessBlocker | null {
  const label = prefix === 'ENGINE' ? 'Agent runtime (Hermes)' : 'Workflow executor (Hatchet)';
  const v = component.verification;
  if (!component.configured) return { code: prefix + '_NOT_CONFIGURED', category: 'ENGINE', detail: 'Missing: ' + component.missing.join(', ') };
  if (!component.attested) return { code: prefix + '_NOT_ATTESTED', category: 'ENGINE', detail: label + ' attestations missing: ' + component.missing.join(', ') };
  if (v.status === 'FAILED') return { code: prefix + '_UNAVAILABLE', category: 'ENGINE', detail: label + ' failed its live check at ' + v.observedAt + ' (' + v.failure + ')' };
  if (v.status === 'STALE') return { code: prefix + '_UNVERIFIED', category: 'ENGINE', detail: label + ' verification expired at ' + v.expiresAt + '; a new live check is required' };
  if (v.status === 'TARGET_CHANGED') return { code: prefix + '_UNVERIFIED', category: 'ENGINE', detail: label + ' configuration changed since its last live check' };
  if (!component.verifiedLive) return { code: prefix + '_UNVERIFIED', category: 'ENGINE', detail: label + ' has not passed a live check yet; configuration alone is not proof of functionality' };
  return null;
}

export class PlanReadService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
    policy: CommercePolicy = commercePolicyFromEnvironment(),
  ) { this.beta = new BetaExecutionAuthorizer(policy); }
  private readonly beta: BetaExecutionAuthorizer;

  async read(actor: Principal, operationId: ID): Promise<OperationPlanView> {
    const operation = await this.store.getOperation(actor, operationId);
    const goal = await this.store.getGoal(actor, operationId);
    const revisionId = operation.currentRevisionId ?? null;
    const revision = revisionId ? await this.store.getRevision(revisionId) : undefined;
    const planSteps = revisionId ? await this.store.getSteps(revisionId) : [];
    const attemptRows = revisionId
      ? await this.store.db.select().from(attempts).where(eq(attempts.revisionId, revisionId))
          .orderBy(desc(attempts.sequence)).limit(attemptHistoryLimit)
      : [];
    const approvalRows = await this.store.db.select().from(approvals)
      .where(and(eq(approvals.workspaceId, actor.workspaceId), eq(approvals.operationId, operationId)));
    const definitions = await this.store.getCapabilities();
    const activeDefinitions = definitions.filter(item => item.status === 'ACTIVE');
    const availability = await capabilityAvailability(this.store, activeDefinitions, this.runtime);
    const activeIds = new Set(activeDefinitions.map(item => item.id));

    const steps: PlanStepView[] = planSteps
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((step: WorkStep) => ({
        id: step.id, ordinal: step.ordinal, title: step.title, description: step.description,
        capabilityId: step.capabilityId, dependsOn: step.dependsOn, state: step.state,
        intent: step.intent, version: step.version, capabilityActive: activeIds.has(step.capabilityId),
      }));

    const attemptViews: PlanAttemptView[] = attemptRows.map(row => ({
      attemptId: row.id, stepId: row.stepId, sequence: row.sequence, state: row.state,
      createdAt: row.payload.createdAt, startedAt: row.payload.startedAt ?? null,
      finishedAt: row.payload.finishedAt ?? null, errorCode: row.payload.errorCode ?? null,
    }));

    const approvalViews: PlanApprovalView[] = approvalRows
      .map(row => row.payload)
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
      .map(approval => ({
        id: approval.id, purpose: approval.purpose, status: approval.status,
        requestedAt: approval.requestedAt, expiresAt: approval.expiresAt,
        stepAttemptId: approval.stepAttemptId, stale: approval.planRevisionId !== revisionId,
      }));

    return {
      operation: {
        id: operation.id, title: operation.title, status: operation.status, version: operation.version,
        currentRevisionId: revisionId, lastActivityAt: operation.lastActivityAt,
        lastErrorCode: operation.lastErrorCode ?? null,
      },
      goal: goal ? { statement: goal.statement, constraints: goal.constraints } : null,
      revision: revision ? {
        id: revision.id, revision: revision.revision, status: revision.status, reason: revision.reason,
        createdBy: revision.createdBy, createdAt: revision.createdAt,
      } : null,
      steps,
      attempts: attemptViews,
      approvals: approvalViews,
      capabilities: activeDefinitions
        .sort((a, b) => a.slot - b.slot)
        .map(definition => capabilityView(definition, availability.byCapabilityId.get(definition.id))),
    };
  }

  async readiness(actor: Principal, operationId: ID): Promise<OperationReadinessView> {
    const operation = await this.store.getOperation(actor, operationId);
    const runtime = this.runtime();
    const blockers: ReadinessBlocker[] = [];
    const revisionId = operation.currentRevisionId ?? null;
    const currentRevision = revisionId ? await this.store.getRevision(revisionId) : undefined;
    const definitions = await this.store.getCapabilities();
    const active = new Map(definitions.filter(item => item.status === 'ACTIVE').map(item => [item.id, item]));
    const availability = await capabilityAvailability(this.store, [...active.values()], this.runtime);

    let planSteps: WorkStep[] = [];
    if (!revisionId) {
      blockers.push({ code: 'PLAN_MISSING', category: 'PLAN', detail: 'No current plan revision' });
    } else {
      planSteps = await this.store.getSteps(revisionId);
      if (!planSteps.length) blockers.push({ code: 'PLAN_EMPTY', category: 'PLAN', detail: 'The current plan has no steps' });
    }
    const planExists = planSteps.length > 0;
    // A missing plan is the actionable blocker; reporting the status as well would only repeat it.
    if (planExists && !startableStatuses.includes(operation.status)) {
      blockers.push({ code: 'STATUS_NOT_STARTABLE', category: 'PLAN', detail: 'Operation status is ' + operation.status });
    }

    const missingCapabilities = new Set<string>();
    const missingProfiles = new Set<string>();
    const missingProviders = new Set<string>();
    const missingPolicies = new Set<string>();
    for (const step of planSteps) {
      const definition = active.get(step.capabilityId);
      if (!definition) {
        if (!missingCapabilities.has(step.capabilityId)) {
          missingCapabilities.add(step.capabilityId);
          blockers.push({ code: 'CAPABILITY_NOT_CONFIGURED', category: 'CAPABILITY', detail: 'Business capability not configured: ' + step.capabilityId });
        }
        continue;
      }
      if (step.intent === 'EXTERNAL_ACTION' && !definition.allowedTools.length) {
        blockers.push({ code: 'EXTERNAL_ACTION_NOT_CONFIGURED', category: 'CAPABILITY', detail: 'External action requires reviewed tools: ' + step.capabilityId });
      }
      const index = availability.byCapabilityId.get(definition.id);
      if (index && !index.profileReady) missingProfiles.add('business:' + definition.slot);
      for (const ref of index?.missingProviders ?? []) missingProviders.add(ref);
      for (const ref of index?.missingPolicies ?? []) missingPolicies.add(ref);
    }

    let order: typeof commercialOrders.$inferSelect | undefined;
    let betaEvaluation: Awaited<ReturnType<BetaExecutionAuthorizer['evaluate']>> | undefined;
    let coveringOffer: typeof offers.$inferSelect | undefined;
    if (planExists) {
      const offerRows = await this.store.db.select().from(offers).where(eq(offers.status, 'ACTIVE'));
      const requiredCapabilities = new Set(planSteps.map(step => step.capabilityId));
      coveringOffer = offerRows.find(row => {
        const configuration = row.configuration as { capabilityIds?: unknown };
        const capabilityIds = Array.isArray(configuration.capabilityIds)
          ? configuration.capabilityIds.filter((value): value is string => typeof value === 'string')
          : [];
        return capabilityIds.length > 0 && [...requiredCapabilities].every(id => capabilityIds.includes(id));
      });
      if (revisionId) {
        [order] = await this.store.db.select().from(commercialOrders)
          .where(and(eq(commercialOrders.workspaceId, actor.workspaceId), eq(commercialOrders.operationId, operationId), eq(commercialOrders.revisionId, revisionId)))
          .limit(1);
      }
      if (!order) {
        blockers.push(coveringOffer
          ? { code: 'SCOPE_NOT_ACCEPTED', category: 'OFFER', detail: 'No accepted service scope for the current plan revision' }
          : { code: 'OFFER_NOT_CONFIGURED', category: 'OFFER', detail: 'No active configured offer covers every capability in this plan' });
      } else if (order.state === 'BETA_AUTHORIZED') {
        // A21.03: mirrors the authorization check of OperationExecutionService.start for free-beta orders.
        betaEvaluation = await this.beta.evaluate(this.store.db, { order, currentRevisionId: revisionId, at: new Date(), purpose: 'EXECUTION' });
        if (!betaEvaluation.ok) {
          blockers.push({ code: 'BETA_AUTHORIZATION_INVALID', category: 'AUTHORIZATION', detail: 'Free beta authorization no longer allows execution: ' + betaEvaluation.denial });
        }
      } else if (order.state === 'PAYMENT_REQUIRED' && this.beta.enabled && order.amountMinor > 0
        && 'grantId' in await this.beta.eligibleGrant(this.store.db, actor.workspaceId, new Date(), false)) {
        // A21.03: an order accepted before the grant was active can be covered by the free beta with an
        // explicit customer action (POST …/commercial/beta-authorization). Until then it stays blocked.
        blockers.push({ code: 'BETA_AUTHORIZATION_AVAILABLE', category: 'OFFER', detail: 'The accepted order is unpaid; it can be covered by the free beta authorization (nothing is charged)' });
      } else if (order.state === 'PAYMENT_REQUIRED') {
        // A21.01: every supported QEYNOX_COMMERCE_MODE freezes payments, so an unpaid paid order cannot be
        // paid in this release. Naming the freeze (not a missing provider) keeps the blocker truthful even
        // when Stripe credentials happen to be configured.
        blockers.push({ code: 'PAYMENTS_FROZEN', category: 'OFFER', detail: 'Payments are frozen (QEYNOX_COMMERCE_MODE); the accepted paid order cannot be paid or executed' });
      } else if (!authorizedOrderStates.includes(order.state)) {
        blockers.push({ code: 'ORDER_NOT_AUTHORIZED', category: 'OFFER', detail: 'Order state is ' + order.state });
      }

      // A21.02: invite-only beta. Mirrors the locked launch gate in OperationExecutionService.start.
      const betaBlocker = await new BetaAccessStore(this.store.db).previewAdmission(actor.workspaceId, operationId, new Date());
      if (betaBlocker) {
        const limit = betaBlocker === 'CONCURRENT_LIMIT_REACHED' || betaBlocker === 'MISSION_QUOTA_REACHED';
        blockers.push({ code: limit ? 'BETA_LIMIT_REACHED' : 'BETA_ACCESS_REQUIRED', category: 'AUTHORIZATION', detail: 'Beta access: ' + betaBlocker });
      }

      // A21.07: each runtime component is judged on its OWN probe evidence. A failed probe is
      // UNAVAILABLE (hard blocker); absent, expired or re-targeted evidence is UNVERIFIED.
      const engineBlocker = runtimeBlocker('ENGINE', runtime.engine);
      if (engineBlocker) blockers.push(engineBlocker);
      const orchestratorBlocker = runtimeBlocker('ORCHESTRATOR', runtime.orchestrator);
      if (orchestratorBlocker) blockers.push(orchestratorBlocker);
      if (missingProfiles.size) {
        blockers.push({ code: 'PROFILE_NOT_CONFIGURED', category: 'ENGINE', detail: 'Missing active business profile: ' + [...missingProfiles].join(', ') });
      }
      if (missingProviders.size) {
        blockers.push({ code: 'PROVIDER_NOT_CONFIGURED', category: 'PROVIDER', detail: 'Missing enabled tool configuration: ' + [...missingProviders].join(', ') });
      }
      if (missingPolicies.size) {
        blockers.push({ code: 'POLICY_NOT_CONFIGURED', category: 'POLICY', detail: 'Missing active verification policy: ' + [...missingPolicies].join(', ') });
      }
    }

    const [operationBudget] = await this.store.db.select().from(operationBudgets)
      .where(and(eq(operationBudgets.workspaceId, actor.workspaceId), eq(operationBudgets.operationId, operationId))).limit(1);
    const [policy] = await this.store.db.select().from(budgetPolicies)
      .where(and(eq(budgetPolicies.workspaceId, actor.workspaceId), eq(budgetPolicies.status, 'ACTIVE')))
      .orderBy(desc(budgetPolicies.version)).limit(1);
    const policyPayload = operationBudget ? undefined : budgetPolicyPayload(policy);
    if (!operationBudget && !policyPayload) {
      blockers.push({ code: 'BUDGET_NOT_CONFIGURED', category: 'BUDGET', detail: 'No active workspace budget policy' });
    }
    if (operationBudget) {
      if (operationBudget.maxMoneyMinor > 0 && operationBudget.spentMinor >= operationBudget.maxMoneyMinor) {
        blockers.push({ code: 'BUDGET_EXHAUSTED', category: 'BUDGET', detail: 'Operation spending ceiling reached' });
      }
      if ((Date.now() - Date.parse(operationBudget.startedAt)) / 1000 > operationBudget.maxDurationSeconds) {
        blockers.push({ code: 'BUDGET_EXHAUSTED', category: 'BUDGET', detail: 'Operation wall-time budget exceeded' });
      }
    }

    const [pending] = await this.store.db.select({ n: sql<number>`count(*)::int` }).from(approvals)
      .where(and(eq(approvals.workspaceId, actor.workspaceId), eq(approvals.operationId, operationId), eq(approvals.status, 'PENDING')));

    const startable = startableStatuses.includes(operation.status);
    const betaValid = Boolean(order && order.state === 'BETA_AUTHORIZED' && betaEvaluation?.ok);
    const orderAuthorized = Boolean(order && (authorizedOrderStates.includes(order.state) || betaValid));
    const authorizationBasis = !order || !orderAuthorized ? null : betaValid ? 'FREE_BETA' as const : order.amountMinor === 0 ? 'FREE_OFFER' as const : 'PAID_ORDER' as const;
    const betaRow = betaEvaluation?.authorization ?? null;
    const offerConfiguration = coveringOffer?.configuration as { label?: unknown; isExplicitlyFree?: unknown } | undefined;
    const offerLabel = typeof offerConfiguration?.label === 'string' ? offerConfiguration.label : null;
    const offerFree = offerConfiguration?.isExplicitlyFree === true;
    const budgetOk = Boolean(operationBudget || policyPayload);

    // Compute operational state: OPERATIONAL only when all prerequisites + verifiedLive + authorized.
    let operationalState: OperationalState;
    if (blockers.length > 0) {
      // Distinguish BLOCKED vs UNVERIFIED: if only UNVERIFIED blockers, state is UNVERIFIED
      const unverifiedOnly = blockers.every(b => b.code === 'ENGINE_UNVERIFIED' || b.code === 'ORCHESTRATOR_UNVERIFIED');
      operationalState = unverifiedOnly ? 'UNVERIFIED' : 'BLOCKED';
    } else if (!runtime.engine.verifiedLive || !runtime.orchestrator.verifiedLive) {
      operationalState = 'UNVERIFIED';
    } else if (!orderAuthorized) {
      operationalState = 'BLOCKED';
    } else if (!budgetOk || missingProfiles.size > 0 || missingProviders.size > 0 || missingPolicies.size > 0) {
      operationalState = 'BLOCKED';
    } else {
      operationalState = 'OPERATIONAL';
    }

    // canStart requires OPERATIONAL, not just no blockers. This separates QA contract success
    // (blockers empty in isolated fixture) from real operational readiness (verifiedLive).
    const canStart = startable && operationalState === 'OPERATIONAL';

    return {
      operationId,
      version: operation.version,
      status: operation.status,
      revisionId,
      canStart,
      operationalState,
      blockers,
      plan: { present: planExists, revision: currentRevision?.revision ?? null, steps: planSteps.length },
      cost: order
        ? { known: true, amountMinor: order.amountMinor, currency: order.currency, orderState: order.state }
        : { known: false, amountMinor: null, currency: null, orderState: null },
      budget: operationBudget
        ? {
            configured: true, currency: operationBudget.currency, maxMoneyMinor: operationBudget.maxMoneyMinor,
            spentMinor: operationBudget.spentMinor, reservedMinor: operationBudget.reservedMinor,
          }
        : {
            configured: Boolean(policyPayload),
            currency: (policyPayload?.currency as string | undefined) ?? null,
            maxMoneyMinor: (policyPayload?.maxMoneyMinor as number | undefined) ?? null,
            spentMinor: null, reservedMinor: null,
          },
      capabilities: { required: planSteps.length, active: planSteps.filter(step => active.has(step.capabilityId)).length, missing: [...missingCapabilities] },
      approvals: { pending: pending?.n ?? 0 },
      prerequisites: {
        plan: { ok: planExists, steps: planSteps.length, revision: currentRevision?.revision ?? null },
        capability: { ok: missingCapabilities.size === 0, required: planSteps.length, active: planSteps.filter(step => active.has(step.capabilityId)).length, missing: [...missingCapabilities] },
        offer: {
          ok: Boolean(coveringOffer),
          offerId: coveringOffer?.id ?? null,
          label: offerLabel,
          amountMinor: coveringOffer?.amountMinor ?? null,
          currency: coveringOffer?.currency ?? null,
          isExplicitlyFree: offerFree,
        },
        order: {
          ok: orderAuthorized,
          state: order?.state ?? null,
          amountMinor: order?.amountMinor ?? null,
          currency: order?.currency ?? null,
        },
        budget: {
          ok: budgetOk,
          source: operationBudget ? 'OPERATION' : policyPayload ? 'POLICY' : 'NONE',
          currency: operationBudget?.currency ?? ((policyPayload?.currency as string | undefined) ?? null),
          ceiling: operationBudget?.maxMoneyMinor ?? ((policyPayload?.maxMoneyMinor as number | undefined) ?? null),
          spent: operationBudget?.spentMinor ?? null,
          reserved: operationBudget?.reservedMinor ?? null,
        },
        permission: { ok: workflowPermission(actor), role: actor.roles[0] ?? null },
        engine: runtimePrerequisite(runtime.engine),
        orchestrator: runtimePrerequisite(runtime.orchestrator),
        profile: { ok: missingProfiles.size === 0, missing: [...missingProfiles] },
        provider: { ok: missingProviders.size === 0, missing: [...missingProviders] },
        policy: { ok: missingPolicies.size === 0, missing: [...missingPolicies] },
        executionAuthorization: { ok: orderAuthorized, state: order?.state ?? null, authorized: orderAuthorized, basis: authorizationBasis },
        betaAuthorization: {
          present: Boolean(betaRow), valid: betaValid,
          denial: betaEvaluation && !betaEvaluation.ok ? betaEvaluation.denial : null,
          grantId: betaRow?.betaGrantId ?? null, listAmountMinor: betaRow?.listAmountMinor ?? null,
          currency: betaRow?.currency ?? null, amountDueNowMinor: betaRow ? 0 : null,
        },
      },
    };
  }
}

/** The authenticated principal is always an ACTIVE workspace member: the guard verified it. */
function workflowPermission(actor: Principal): boolean {
  return Boolean(actor.userId && actor.workspaceId && actor.roles.length > 0);
}
