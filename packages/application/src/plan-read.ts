import { and, desc, eq, sql } from 'drizzle-orm';
import type { CapabilityDefinition, ID, OperationStatus, Principal, WorkStep } from '@qeynox/domain';
import { QeyNoxStore, approvals, attempts, budgetPolicies, commercialOrders, operationBudgets } from '@qeynox/persistence';

/** Bounded customer-facing projection of one configured business capability. */
export interface PlanCapabilityView {
  id: string; slot: number; name: string; purpose: string;
  scope: readonly string[]; maximumSteps: number; maximumToolCalls: number;
  externalActions: boolean;
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

export interface ReadinessBlocker { code: string; detail: string }
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
}

const startableStatuses: readonly OperationStatus[] = ['READY', 'INTERRUPTED', 'FAILED'];
const authorizedOrderStates: readonly string[] = ['AUTHORIZED', 'FULFILLING'];

function capabilityView(definition: CapabilityDefinition): PlanCapabilityView {
  return {
    id: definition.id,
    slot: definition.slot,
    name: definition.name ?? 'Unnamed capability',
    purpose: definition.purpose ?? '',
    scope: definition.scope,
    maximumSteps: definition.maximumSteps,
    maximumToolCalls: definition.maximumToolCalls,
    externalActions: definition.allowedTools.length > 0,
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
 * is requested. Readiness mirrors the checks OperationExecutionService.start performs so the
 * interface never offers a launch the backend would refuse.
 */
export class PlanReadService {
  constructor(private readonly store: QeyNoxStore) {}

  async read(actor: Principal, operationId: ID): Promise<OperationPlanView> {
    const operation = await this.store.getOperation(actor, operationId);
    const goal = await this.store.getGoal(actor, operationId);
    const revisionId = operation.currentRevisionId ?? null;
    const revision = revisionId ? await this.store.getRevision(revisionId) : undefined;
    const planSteps = revisionId ? await this.store.getSteps(revisionId) : [];
    const attemptRows = revisionId
      ? await this.store.db.select().from(attempts).where(eq(attempts.revisionId, revisionId))
      : [];
    const approvalRows = await this.store.db.select().from(approvals)
      .where(and(eq(approvals.workspaceId, actor.workspaceId), eq(approvals.operationId, operationId)));
    const definitions = await this.store.getCapabilities();
    const activeIds = new Set(definitions.filter(item => item.status === 'ACTIVE').map(item => item.id));

    const latestByStep = new Map<string, typeof attemptRows[number]>();
    for (const row of attemptRows) {
      const prior = latestByStep.get(row.stepId);
      if (!prior || row.sequence > prior.sequence) latestByStep.set(row.stepId, row);
    }

    const steps: PlanStepView[] = planSteps
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((step: WorkStep) => ({
        id: step.id, ordinal: step.ordinal, title: step.title, description: step.description,
        capabilityId: step.capabilityId, dependsOn: step.dependsOn, state: step.state,
        intent: step.intent, version: step.version, capabilityActive: activeIds.has(step.capabilityId),
      }));

    const attemptViews: PlanAttemptView[] = [...latestByStep.values()]
      .sort((a, b) => b.sequence - a.sequence)
      .map(row => ({
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
      capabilities: definitions.filter(item => item.status === 'ACTIVE')
        .sort((a, b) => a.slot - b.slot)
        .map(capabilityView),
    };
  }

  async readiness(actor: Principal, operationId: ID): Promise<OperationReadinessView> {
    const operation = await this.store.getOperation(actor, operationId);
    const blockers: ReadinessBlocker[] = [];
    const revisionId = operation.currentRevisionId ?? null;
    const currentRevision = revisionId ? await this.store.getRevision(revisionId) : undefined;
    const definitions = await this.store.getCapabilities();
    const active = new Map(definitions.filter(item => item.status === 'ACTIVE').map(item => [item.id, item]));

    let planSteps: WorkStep[] = [];
    if (!revisionId) {
      blockers.push({ code: 'PLAN_MISSING', detail: 'No current plan revision' });
    } else {
      planSteps = await this.store.getSteps(revisionId);
      if (!planSteps.length) blockers.push({ code: 'PLAN_EMPTY', detail: 'The current plan has no steps' });
    }
    // A missing plan is the actionable blocker; reporting the status as well would only repeat it.
    if (planSteps.length > 0 && !startableStatuses.includes(operation.status)) {
      blockers.push({ code: 'STATUS_NOT_STARTABLE', detail: 'Operation status is ' + operation.status });
    }

    const missing = new Set<string>();
    for (const step of planSteps) {
      const definition = active.get(step.capabilityId);
      if (!definition) {
        if (!missing.has(step.capabilityId)) {
          missing.add(step.capabilityId);
          blockers.push({ code: 'CAPABILITY_NOT_CONFIGURED', detail: 'Business capability not configured: ' + step.capabilityId });
        }
        continue;
      }
      if (step.intent === 'EXTERNAL_ACTION' && !definition.allowedTools.length) {
        blockers.push({ code: 'EXTERNAL_ACTION_NOT_CONFIGURED', detail: 'External action requires reviewed tools: ' + step.capabilityId });
      }
    }

    let order: typeof commercialOrders.$inferSelect | undefined;
    if (revisionId && planSteps.length) {
      [order] = await this.store.db.select().from(commercialOrders)
        .where(and(eq(commercialOrders.workspaceId, actor.workspaceId), eq(commercialOrders.operationId, operationId), eq(commercialOrders.revisionId, revisionId)))
        .limit(1);
      if (!order) blockers.push({ code: 'SCOPE_NOT_ACCEPTED', detail: 'No accepted service scope for the current plan revision' });
      else if (order.state === 'PAYMENT_REQUIRED') blockers.push({ code: 'PAYMENT_NOT_CONFIGURED', detail: 'No payment provider configured for the accepted order' });
      else if (!authorizedOrderStates.includes(order.state)) blockers.push({ code: 'ORDER_NOT_AUTHORIZED', detail: 'Order state is ' + order.state });
    }

    const [operationBudget] = await this.store.db.select().from(operationBudgets)
      .where(and(eq(operationBudgets.workspaceId, actor.workspaceId), eq(operationBudgets.operationId, operationId))).limit(1);
    const [policy] = await this.store.db.select().from(budgetPolicies)
      .where(and(eq(budgetPolicies.workspaceId, actor.workspaceId), eq(budgetPolicies.status, 'ACTIVE')))
      .orderBy(desc(budgetPolicies.version)).limit(1);
    const policyPayload = operationBudget ? undefined : budgetPolicyPayload(policy);
    if (!operationBudget && !policyPayload) {
      blockers.push({ code: 'BUDGET_NOT_CONFIGURED', detail: 'No active workspace budget policy' });
    }
    if (operationBudget) {
      if (operationBudget.maxMoneyMinor > 0 && operationBudget.spentMinor >= operationBudget.maxMoneyMinor) {
        blockers.push({ code: 'BUDGET_EXHAUSTED', detail: 'Operation spending ceiling reached' });
      }
      if ((Date.now() - Date.parse(operationBudget.startedAt)) / 1000 > operationBudget.maxDurationSeconds) {
        blockers.push({ code: 'BUDGET_EXHAUSTED', detail: 'Operation wall-time budget exceeded' });
      }
    }

    const [pending] = await this.store.db.select({ n: sql<number>`count(*)::int` }).from(approvals)
      .where(and(eq(approvals.workspaceId, actor.workspaceId), eq(approvals.operationId, operationId), eq(approvals.status, 'PENDING')));

    const startable = startableStatuses.includes(operation.status);
    return {
      operationId,
      version: operation.version,
      status: operation.status,
      revisionId,
      canStart: startable && blockers.length === 0,
      blockers,
      plan: { present: Boolean(revisionId && planSteps.length), revision: currentRevision?.revision ?? null, steps: planSteps.length },
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
      capabilities: { required: planSteps.length, active: planSteps.filter(step => active.has(step.capabilityId)).length, missing: [...missing] },
      approvals: { pending: pending?.n ?? 0 },
    };
  }
}
