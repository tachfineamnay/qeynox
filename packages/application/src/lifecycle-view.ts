import type { OperationStatus } from '@qeynox/domain';

/**
 * MISSION A06 — the customer-visible lifecycle, derived from persisted business state only.
 *
 * Every customer-facing surface (MyDash attention, mission progress, activity timeline) must agree
 * with what PostgreSQL actually recorded. To make that checkable instead of hopeful, the derivation
 * lives here as one pure function and every caller uses it. Nothing in this module reads the clock,
 * the network or a provider: it is a total function of persisted status.
 */

/**
 * The seven lifecycle milestones of the product contract:
 * GOAL → PLAN → APPROVAL → EXECUTION → TOOL EVIDENCE → HUMAN REVIEW → RESULT.
 */
export const LIFECYCLE_MILESTONES = ['GOAL', 'PLAN', 'APPROVAL', 'EXECUTION', 'TOOL_EVIDENCE', 'HUMAN_REVIEW', 'RESULT'] as const;
export type LifecycleMilestone = (typeof LIFECYCLE_MILESTONES)[number];

export type LifecycleAttention =
  /** Nothing to do. */
  | 'NONE'
  /** The customer must approve something before work continues. */
  | 'APPROVAL'
  /** The plan is ready but execution has not started. */
  | 'START'
  /** Work is in flight; no customer action. */
  | 'INCOMPLETE'
  /** The result is assembled and awaiting human review. */
  | 'REQUIRES_REVIEW'
  /** Execution stopped and needs a decision (retry, revise, abandon). */
  | 'FAILED'
  /** A stop was requested; the outcome is not yet reconciled with the executor. */
  | 'INTERRUPTION'
  /** The last attempt is over but the operation was never resumed. */
  | 'STALLED';

/** A milestone is only ever marked complete when the persisted status proves it. */
export interface MilestoneProgress {
  readonly milestone: LifecycleMilestone;
  readonly complete: boolean;
  /** True for the milestone the operation is currently at. */
  readonly current: boolean;
}

export interface LifecycleView {
  readonly status: OperationStatus;
  readonly attention: LifecycleAttention;
  readonly milestones: readonly MilestoneProgress[];
  /** The first milestone not yet complete, or 'RESULT' when everything is done. */
  readonly currentMilestone: LifecycleMilestone;
  /**
   * True when the reported state is an assumption about an external system that QeyNox has not
   * confirmed. The UI must not present these states as settled facts.
   */
  readonly provisional: boolean;
}

/** Statuses whose meaning depends on an external executor or provider we have not observed. */
const PROVISIONAL_STATUSES: ReadonlySet<OperationStatus> = new Set<OperationStatus>(['INTERRUPT_REQUESTED', 'RUNNING']);

/**
 * How far each persisted status proves the lifecycle has progressed. A status only marks a
 * milestone complete when the work behind that milestone is durably recorded.
 */
const COMPLETED_THROUGH: Readonly<Record<OperationStatus, LifecycleMilestone | null>> = {
  // A draft operation may already carry a goal statement; nothing else is proven.
  DRAFT: 'GOAL',
  // A sealed, current plan revision exists.
  READY: 'PLAN',
  // Execution was accepted and dispatched.
  RUNNING: 'EXECUTION',
  // Every step finished, so evidence exists and the result document was assembled for review.
  WAITING_APPROVAL: 'TOOL_EVIDENCE',
  INTERRUPT_REQUESTED: 'EXECUTION',
  INTERRUPTED: 'EXECUTION',
  // A failed attempt still leaves the goal, the plan, and whatever evidence it recorded.
  FAILED: 'EXECUTION',
  // Delivery transitions to COMPLETED only after an approved review released the document.
  COMPLETED: 'RESULT',
  SUPERSEDED: 'PLAN',
};

const ATTENTION_BY_STATUS: Readonly<Record<OperationStatus, LifecycleAttention>> = {
  DRAFT: 'START',
  READY: 'START',
  RUNNING: 'INCOMPLETE',
  WAITING_APPROVAL: 'REQUIRES_REVIEW',
  // A stop request is not a settled outcome: the customer is told it is unresolved.
  INTERRUPT_REQUESTED: 'INTERRUPTION',
  INTERRUPTED: 'STALLED',
  FAILED: 'FAILED',
  COMPLETED: 'NONE',
  SUPERSEDED: 'START',
};

/**
 * Derives the lifecycle view for an operation.
 *
 * `pendingApprovals` overrides the status-derived attention for a single reason: a pending
 * approval is an action the customer can actually take, so it outranks "in progress". It never
 * invents progress — it only redirects attention.
 */
export function lifecycleView(status: OperationStatus, pendingApprovals = 0): LifecycleView {
  const through = COMPLETED_THROUGH[status];
  const throughIndex = through ? LIFECYCLE_MILESTONES.indexOf(through) : -1;
  const attention: LifecycleAttention = pendingApprovals > 0 && status !== 'COMPLETED' ? 'APPROVAL' : ATTENTION_BY_STATUS[status];
  const milestones = LIFECYCLE_MILESTONES.map((milestone, index) => {
    const complete = index <= throughIndex;
    return { milestone, complete, current: !complete && index === throughIndex + 1 };
  });
  // Every milestone complete means the result exists; otherwise report the first open one.
  const currentMilestone = throughIndex >= LIFECYCLE_MILESTONES.length - 1
    ? 'RESULT'
    : LIFECYCLE_MILESTONES[throughIndex + 1]!;
  return {
    status,
    attention,
    milestones,
    currentMilestone,
    provisional: PROVISIONAL_STATUSES.has(status) || attention === 'INTERRUPTION',
  };
}

/**
 * Customer-facing label for a state the product cannot confirm yet. Used instead of a status word
 * whenever `provisional` is true, so an unconfirmed cancellation is never shown as "Interrupted".
 */
export function provisionalLabel(status: OperationStatus): string | null {
  if (status === 'INTERRUPT_REQUESTED') return 'STOP_NOT_CONFIRMED';
  if (status === 'RUNNING') return 'EXECUTION_IN_FLIGHT';
  return null;
}

/** True when the operation can still advance without new customer input. */
export function isActive(status: OperationStatus): boolean {
  return ['RUNNING', 'WAITING_APPROVAL', 'INTERRUPT_REQUESTED'].includes(status);
}
