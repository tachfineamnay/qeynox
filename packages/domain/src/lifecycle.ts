import { DomainError } from './errors';
import type { Operation, OperationStatus, WorkStep, WorkStepStatus } from './entities';

const allowed: Record<OperationStatus, readonly OperationStatus[]> = {
  DRAFT: ['READY','INTERRUPTED'],
  READY: ['RUNNING','WAITING_APPROVAL','INTERRUPTED'],
  RUNNING: ['WAITING_APPROVAL','INTERRUPT_REQUESTED','COMPLETED','FAILED'],
  WAITING_APPROVAL: ['RUNNING','INTERRUPT_REQUESTED','FAILED','INTERRUPTED'],
  INTERRUPT_REQUESTED: ['INTERRUPTED','COMPLETED','FAILED'],
  INTERRUPTED: ['READY','SUPERSEDED'],
  FAILED: ['READY','SUPERSEDED'],
  COMPLETED: ['SUPERSEDED'],
  SUPERSEDED: [],
};

export function transitionOperation(operation: Operation, next: OperationStatus, now: string, expectedVersion: number): Operation {
  if (operation.version !== expectedVersion) throw new DomainError('CONFLICT', 'Operation version changed');
  if (!allowed[operation.status].includes(next)) throw new DomainError('INVALID_STATE', 'Illegal operation transition: ' + operation.status + ' -> ' + next);
  return { ...operation, status: next, version: operation.version + 1, updatedAt: now, lastActivityAt: now };
}

const allowedStep: Record<WorkStepStatus, readonly WorkStepStatus[]> = {
  PENDING: ['RUNNING','SKIPPED','INVALIDATED'],
  RUNNING: ['WAITING_APPROVAL','COMPLETED','FAILED','INVALIDATED'],
  WAITING_APPROVAL: ['RUNNING','FAILED','INVALIDATED'],
  COMPLETED: ['INVALIDATED'],
  FAILED: ['PENDING','INVALIDATED'],
  SKIPPED: ['INVALIDATED'],
  INVALIDATED: [],
};

export function transitionStep(step: WorkStep, state: WorkStepStatus): WorkStep {
  if (!allowedStep[step.state].includes(state)) throw new DomainError('INVALID_STATE', 'Illegal step transition');
  return { ...step, state, version: step.version + 1 };
}

export function assertWorkspace(actual: string, expected: string): void {
  if (!actual || !expected || actual !== expected) throw new DomainError('DENIED', 'Workspace access denied');
}
