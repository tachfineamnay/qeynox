/**
 * QA fixture support for the P09 final-step contract. This is not a worker or a model:
 * canned QA output still passes the real request-bound validator and claim/evidence pipeline.
 * Human assessment is deliberately left to the calling QA suite.
 */
import { and, eq } from 'drizzle-orm';
import { DomainError, type ID, type Principal, type StepAttempt } from '@qeynox/domain';
import type { PackDeliverable } from '@qeynox/contracts';
import { claims, type QeyNoxStore } from '@qeynox/persistence';
import {
  acceptBusinessPackDeliverable, businessPackStepRole, capturedPackSources, ClaimsService,
  recordBusinessPackClaims, recoverBusinessPackMission, type BusinessDeliverableRecord,
} from '@qeynox/application';

export async function prepareQaPackStep(
  store: QeyNoxStore,
  actor: Principal,
  attempt: StepAttempt,
  deliverable: PackDeliverable,
): Promise<{ businessDeliverable?: BusinessDeliverableRecord; claimIds: readonly ID[] }> {
  const mission = recoverBusinessPackMission(await store.getGoal(actor, attempt.operationId));
  if (!mission) throw new DomainError('INVALID_STATE', 'QA fixture requires a recorded business-pack mission');
  const steps = await store.getSteps(attempt.planRevisionId);
  const step = steps.find(candidate => candidate.id === attempt.workStepId);
  if (!step) throw new DomainError('INVALID_STATE', 'QA attempt has no recorded step');
  if (businessPackStepRole(mission, steps, step) !== 'DELIVERABLE') return { claimIds: [] };
  const captured = await capturedPackSources(store, actor.workspaceId, attempt.operationId, attempt.planRevisionId);
  const accepted = acceptBusinessPackDeliverable(mission, JSON.stringify(deliverable), captured);
  await recordBusinessPackClaims(new ClaimsService(store), actor, { operationId: attempt.operationId, attemptId: attempt.id }, mission, accepted.projection, captured);
  const recorded = await store.db.select({ id: claims.id }).from(claims).where(and(
    eq(claims.workspaceId, actor.workspaceId), eq(claims.operationId, attempt.operationId), eq(claims.attemptId, attempt.id),
  ));
  return { businessDeliverable: accepted.record, claimIds: recorded.map(row => row.id as ID) };
}
