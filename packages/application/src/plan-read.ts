import { and, desc, eq, sql } from 'drizzle-orm';
import type { CapabilityDefinition, ID, OperationStatus, Principal, WorkStep } from '@qeynox/domain';
import { QeyNoxStore, approvals, attempts, budgetPolicies, commercialOrders, offers, operationBudgets } from '@qeynox/persistence';
import { capabilityAvailability, type CapabilityAvailability } from './capability-availability';
import { failClosedRuntime, type RuntimeReadinessSource } from './runtime-readiness';

/** Bounded customer-facing projection of one configured business capability. */
export interface PlanCapabilityView {
  id: string; slot: number; name: string; purpose: string;
  scope: readonly string[]; maximumSteps: number; maximumToolCalls: number;
  externalActions: boolean;
  providerReady: boolean; missingProviders: readonly string[]; profileReady: boolean;
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

export type ReadinessCategory = 'PLAN' | 'CAPABILITY' | 'OFFER' | 'BUDGET' | 'PERMISSION' | 'ENGINE' | 'PROVIDER';
export interface ReadinessBlocker { code: string; detail: string; category: ReadinessCategory }
export interface OperationReadinessView {
  operationId: string;
  version: number;
  status: OperationStatus;
  revisionId: string | null;
  canStart: boolean;
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
    engine: { ok: boolean; runtime: string; missing: readonly string[] };
    orchestrator: { ok: boolean; runtime: string; missing: readonly string[] };
    profile: { ok: boolean; missing: readonly string[] };
    provider: { ok: boolean; missing: readonly string[] };
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
  };
}

function budgetPolicyPayload(row: { payload: Record<string, unknown> } | undefined) {
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
 */
export class PlanReadService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
  ) {}

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
    const availability = await capabilityAvailability(this.store, activeDefinitions);
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
    const availability = await capabilityAvailability(this.store, [...active.values()]);

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
    }

    let order: typeof commercialOrders.$inferSelect | undefined;
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
      } else if (order.state === 'PAYMENT_REQUIRED') {
        blockers.push({ code: 'PAYMENT_NOT_CONFIGURED', category: 'OFFER', detail: 'No payment provider configured for the accepted order' });
      } else if (!authorizedOrderStates.includes(order.state)) {
        blockers.push({ code: 'ORDER_NOT_AUTHORIZED', category: 'OFFER', detail: 'Order state is ' + order.state });
      }

      if (!runtime.engine.configured) {
        blockers.push({ code: 'ENGINE_NOT_CONFIGURED', category: 'ENGINE', detail: 'Missing: ' + runtime.engine.missing.join(', ') });
      }
      if (!runtime.orchestrator.configured) {
        blockers.push({ code: 'ORCHESTRATOR_NOT_CONFIGURED', category: 'ENGINE', detail: 'Missing: ' + runtime.orchestrator.missing.join(', ') });
      }
      if (missingProfiles.size) {
        blockers.push({ code: 'PROFILE_NOT_CONFIGURED', category: 'ENGINE', detail: 'Missing active business profile: ' + [...missingProfiles].join(', ') });
      }
      if (missingProviders.size) {
        blockers.push({ code: 'PROVIDER_NOT_CONFIGURED', category: 'PROVIDER', detail: 'Missing enabled tool configuration: ' + [...missingProviders].join(', ') });
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
    const orderAuthorized = Boolean(order && authorizedOrderStates.includes(order.state));
    const offerConfiguration = coveringOffer?.configuration as { label?: unknown; isExplicitlyFree?: unknown } | undefined;
    const offerLabel = typeof offerConfiguration?.label === 'string' ? offerConfiguration.label : null;
    const offerFree = offerConfiguration?.isExplicitlyFree === true;
    const budgetOk = Boolean(operationBudget || policyPayload);
    return {
      operationId,
      version: operation.version,
      status: operation.status,
      revisionId,
      canStart: startable && blockers.length === 0,
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
          ok: Boolean(order && authorizedOrderStates.includes(order.state)),
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
        engine: { ok: runtime.engine.configured, runtime: runtime.engine.id, missing: runtime.engine.missing },
        orchestrator: { ok: runtime.orchestrator.configured, runtime: runtime.orchestrator.id, missing: runtime.orchestrator.missing },
        profile: { ok: missingProfiles.size === 0, missing: [...missingProfiles] },
        provider: { ok: missingProviders.size === 0, missing: [...missingProviders] },
      },
    };
  }
}

/** The authenticated principal is always an ACTIVE workspace member: the guard verified it. */
function workflowPermission(actor: Principal): boolean {
  return Boolean(actor.userId && actor.workspaceId && actor.roles.length > 0);
}
