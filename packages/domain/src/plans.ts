import { DomainError } from './errors';
import { newId } from './identities';
import type { ID } from './identities';
import type { PlanRevision, StepAttempt, WorkStep } from './entities';

export function validatePlan(steps: readonly WorkStep[], revisionId: ID): void {
  const byId = new Map(steps.map(s => [s.id, s]));
  if (byId.size !== steps.length) throw new DomainError('INVALID_INPUT', 'Duplicate step IDs');
  if (steps.length === 0) throw new DomainError('INVALID_INPUT', 'Plan requires a step');
  const visited = new Set<ID>(); const active = new Set<ID>();
  const visit = (id: ID) => {
    if (active.has(id)) throw new DomainError('INVALID_INPUT', 'Cyclic plan dependencies');
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step || step.planRevisionId !== revisionId) throw new DomainError('INVALID_INPUT', 'Invalid plan dependency');
    active.add(id);
    for (const dep of step.dependsOn) visit(dep);
    active.delete(id); visited.add(id);
  };
  for (const s of steps) {
    if (s.planRevisionId !== revisionId) throw new DomainError('INVALID_INPUT', 'Plan revision mismatch');
    if (s.dependsOn.includes(s.id)) throw new DomainError('INVALID_INPUT', 'Self dependency');
    visit(s.id);
  }
}

export function descendants(steps: readonly WorkStep[], id: ID): ReadonlySet<ID> {
  const seen = new Set<ID>(); const queue = [id];
  while (queue.length) {
    const target = queue.shift()!;
    for (const s of steps) if (s.dependsOn.includes(target) && !seen.has(s.id)) {
      seen.add(s.id); queue.push(s.id);
    }
  }
  return seen;
}

export function redoStep(prior: StepAttempt, now: string, sequence: number): StepAttempt {
  if (prior.state === 'RUNNING' || prior.state === 'WAITING_APPROVAL') throw new DomainError('INVALID_STATE', 'Cannot redo an active attempt');
  if (sequence <= prior.sequence) throw new DomainError('CONFLICT', 'Sequence must increase');
  return {
    id: newId(), operationId: prior.operationId, planRevisionId: prior.planRevisionId, workStepId: prior.workStepId,
    sequence, priorAttemptId: prior.id, state: 'PENDING', version: 1, createdAt: now,
  };
}

export function forkRevision(prior: PlanRevision, actor: ID, reason: string, now: string): PlanRevision {
  if (!reason.trim()) throw new DomainError('INVALID_INPUT', 'Revision requires a reason');
  return {
    id: newId(), planId: prior.planId, operationId: prior.operationId,
    revision: prior.revision + 1, previousRevisionId: prior.id,
    createdAt: now, createdBy: actor, reason, status: 'ACTIVE',
  };
}
