import { and, desc, eq } from 'drizzle-orm';
import { DomainError, newId, transitionOperation, type ID, type Operation, type OperationStatus, type Goal, type Principal, type EventRecord, type OperationPlan, type SoulOnboardingRecord, type SoulOnboardingStep, type SoulOnboardingStatus, type PlanRevision, type WorkStep, type StepAttempt, type ApprovalRequest, type Source, type Evidence, type Artifact, type ResultVersion, type Consent, type UserContext, type CapabilityDefinition, type ExecutionLink } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { operations, goals, events, outbox, plans, planRevisions, steps, attempts, approvals, sources, evidences, artifacts, results, consents, contexts, capabilities, executions, soulOnboarding } from './schema';

function authorize(principal: Principal, workspace: string) {
  if (!principal.workspaceId || principal.workspaceId !== workspace || !principal.userId) throw new DomainError('DENIED','Workspace mismatch');
}
export interface NewOutbox { topic: string; key: string; payload: Record<string, unknown> }
export class QeyNoxStore {
  constructor(readonly db: QeyNoxDatabase) {}

  async createOperation(principal: Principal, title: string, statement: string, constraints: readonly string[]) {
    if (!title.trim() || !statement.trim()) throw new DomainError('INVALID_INPUT', 'Missing objective');
    const now = new Date().toISOString();
    const goal: Goal = { id: newId(), operationId: newId(), statement, constraints, createdAt: now };
    const operation: Operation = {
      id: goal.operationId, workspaceId: principal.workspaceId, createdBy: principal.userId,
      goalId: goal.id, title, status: 'DRAFT', version: 1, createdAt: now, updatedAt: now, lastActivityAt: now,
    };
    await this.db.transaction(async tx => {
      await tx.insert(goals).values({ id: goal.id, operationId: operation.id, payload: goal });
      await tx.insert(operations).values({ id: operation.id, workspaceId: operation.workspaceId, createdBy: operation.createdBy, goalId: goal.id, status: operation.status, version: operation.version, lastActivityAt: now, payload: operation });
      await tx.insert(events).values(this.eventRow({ workspaceId: operation.workspaceId, operationId: operation.id, kind: 'OPERATION_CREATED', actorId: principal.userId, data: { goalId: goal.id }, occurredAt: now }));
    });
    return operation;
  }

  async getOperation(principal: Principal, id: ID): Promise<Operation> {
    const [row] = await this.db.select().from(operations).where(and(eq(operations.id, id), eq(operations.workspaceId, principal.workspaceId))).limit(1);
    if (!row) throw new DomainError('NOT_FOUND', 'Operation not found');
    authorize(principal, row.workspaceId);
    return row.payload;
  }

  async listOperations(principal: Principal, limit = 30): Promise<Operation[]> {
    if (!principal.workspaceId) throw new DomainError('DENIED','Workspace required');
    const rows = await this.db.select().from(operations).where(eq(operations.workspaceId, principal.workspaceId)).orderBy(desc(operations.lastActivityAt)).limit(Math.min(100, Math.max(1, limit)));
    return rows.map(row => row.payload);
  }

  async transition(principal: Principal, id: ID, next: OperationStatus, expectedVersion: number, outboxMessage?: NewOutbox): Promise<Operation> {
    return this.db.transaction(async tx => {
      const [current] = await tx.select().from(operations).where(and(eq(operations.id,id), eq(operations.workspaceId,principal.workspaceId))).limit(1);
      if (!current) throw new DomainError('NOT_FOUND','Operation not found');
      authorize(principal, current.workspaceId);
      const now = new Date().toISOString();
      const nextOperation = transitionOperation(current.payload, next, now, expectedVersion);
      const [updated] = await tx.update(operations).set({ payload: nextOperation, status: next, version: nextOperation.version, lastActivityAt: now })
        .where(and(eq(operations.id,id), eq(operations.workspaceId,principal.workspaceId), eq(operations.version,expectedVersion))).returning({id:operations.id});
      if (!updated) throw new DomainError('CONFLICT', 'Concurrent operation update');
      await tx.insert(events).values(this.eventRow({ workspaceId: principal.workspaceId, operationId: id, kind: 'OPERATION_' + next, actorId: principal.userId, data: { version: nextOperation.version }, occurredAt: now }));
      if (outboxMessage) await tx.insert(outbox).values({ id:newId(), workspaceId:principal.workspaceId, operationId:id, idempotencyKey:outboxMessage.key, topic:outboxMessage.topic, payload:outboxMessage.payload, createdAt:now, nextAttemptAt:now }).onConflictDoNothing();
      return nextOperation;
    });
  }

  async writeEvent(input: Omit<EventRecord,'id'|'eventVersion'>): Promise<void> {
    await this.db.insert(events).values(this.eventRow(input));
  }
  async timeline(principal: Principal, operationId: ID): Promise<EventRecord[]> {
    await this.getOperation(principal, operationId);
    const rows = await this.db.select().from(events).where(and(eq(events.workspaceId,principal.workspaceId),eq(events.operationId,operationId))).orderBy(events.occurredAt);
    return rows.map(r=>r.payload);
  }

  async getRevision(revisionId: ID): Promise<PlanRevision | undefined> {
    const [row] = await this.db.select().from(planRevisions).where(eq(planRevisions.id,revisionId)).limit(1);
    return row?.payload;
  }
  async savePlan(principal: Principal, operationId: ID, plan: OperationPlan, revision: PlanRevision, planSteps: readonly WorkStep[]): Promise<void> {
    await this.getOperation(principal, operationId);
    if (plan.operationId !== operationId || revision.operationId !== operationId || planSteps.some(s=>s.operationId!==operationId)) throw new DomainError('INVALID_INPUT','Plan identity mismatch');
    await this.db.transaction(async tx => {
      await tx.insert(plans).values({ id:plan.id, operationId, payload:plan }).onConflictDoNothing();
      await tx.insert(planRevisions).values({id:revision.id,operationId,planId:plan.id,revision:revision.revision,payload:revision});
      if (planSteps.length) await tx.insert(steps).values(planSteps.map(s=>({id:s.id,operationId,revisionId:revision.id,payload:s})));
      await tx.update(operations).set({currentRevisionId:revision.id}).where(and(eq(operations.id,operationId),eq(operations.workspaceId,principal.workspaceId)));
    });
  }
  async getSteps(revisionId: ID): Promise<WorkStep[]> {
    return (await this.db.select().from(steps).where(eq(steps.revisionId,revisionId))).map(s=>s.payload);
  }
  async putStepAttempt(attempt: StepAttempt): Promise<void> {
    await this.db.insert(attempts).values({id:attempt.id,operationId:attempt.operationId,stepId:attempt.workStepId,revisionId:attempt.planRevisionId,sequence:attempt.sequence,state:attempt.state,payload:attempt});
  }
  async getAttempt(id: ID): Promise<StepAttempt | undefined> {
    return (await this.db.select().from(attempts).where(eq(attempts.id,id)).limit(1))[0]?.payload;
  }
  async updateAttempt(attempt: StepAttempt, expectedVersion: number): Promise<void> {
    const changed = await this.db.update(attempts).set({payload:attempt,state:attempt.state}).where(eq(attempts.id,attempt.id)).returning({id:attempts.id});
    if (!changed.length) throw new DomainError('NOT_FOUND','Attempt not found');
  }
  async putApproval(approval: ApprovalRequest): Promise<void> {
    await this.db.insert(approvals).values({id:approval.id,workspaceId:approval.workspaceId,operationId:approval.operationId,status:approval.status,payload:approval});
  }
  async getApproval(principal: Principal, id: ID): Promise<ApprovalRequest> {
    const [row] = await this.db.select().from(approvals).where(and(eq(approvals.id,id),eq(approvals.workspaceId,principal.workspaceId))).limit(1);
    if (!row) throw new DomainError('NOT_FOUND','Approval not found'); return row.payload;
  }
  async decideApproval(principal: Principal, id: ID, status: 'APPROVED'|'REJECTED'): Promise<ApprovalRequest> {
    return this.db.transaction(async tx => {
      const [row]=await tx.select().from(approvals).where(and(eq(approvals.id,id),eq(approvals.workspaceId,principal.workspaceId))).limit(1);
      if (!row) throw new DomainError('NOT_FOUND','Approval not found');
      if (row.payload.status !== 'PENDING') throw new DomainError('CONFLICT','Approval already decided');
      const now = new Date().toISOString();
      if (row.payload.expiresAt<=now) throw new DomainError('INVALID_STATE','Approval expired');
      const decision: ApprovalRequest = {...row.payload,status,decidedAt:now,decidedBy:principal.userId};
      const changed=await tx.update(approvals).set({status,payload:decision}).where(and(eq(approvals.id,id),eq(approvals.status,'PENDING'))).returning({id:approvals.id});
      if (!changed.length) throw new DomainError('CONFLICT','Concurrent approval decision');
      return decision;
    });
  }
  async recordSource(value: Source): Promise<void> { await this.db.insert(sources).values({id:value.id,workspaceId:value.workspaceId,operationId:value.operationId,payload:value}); }
  async recordEvidence(value: Evidence): Promise<void> { await this.db.insert(evidences).values({id:value.id,operationId:value.operationId,attemptId:value.stepAttemptId,payload:value}); }
  async recordArtifact(value: Artifact): Promise<void> { await this.db.insert(artifacts).values({id:value.id,workspaceId:value.workspaceId,operationId:value.operationId,payload:value}); }
  async recordResult(value: ResultVersion): Promise<void> { await this.db.insert(results).values({id:value.id,workspaceId:value.workspaceId,operationId:value.operationId,version:value.version,payload:value}); }
  async getResult(principal: Principal, operationId: ID): Promise<ResultVersion[]> {
    await this.getOperation(principal, operationId);
    return (await this.db.select().from(results).where(and(eq(results.workspaceId,principal.workspaceId),eq(results.operationId,operationId))).orderBy(desc(results.version))).map(r=>r.payload);
  }
  async getEvidence(operationId: ID): Promise<Evidence[]> { return (await this.db.select().from(evidences).where(eq(evidences.operationId,operationId))).map(r=>r.payload); }
  async getArtifacts(operationId: ID): Promise<Artifact[]> { return (await this.db.select().from(artifacts).where(eq(artifacts.operationId,operationId))).map(r=>r.payload); }
  async putConsent(value: Consent): Promise<void> { await this.db.insert(consents).values({id:value.id,workspaceId:value.workspaceId,userId:value.userId,payload:value}); }
  async getConsents(workspaceId: ID, userId: ID): Promise<Consent[]> { return (await this.db.select().from(consents).where(and(eq(consents.workspaceId,workspaceId),eq(consents.userId,userId)))).map(r=>r.payload); }
  async saveContext(value: UserContext): Promise<void> { await this.db.insert(contexts).values({id:value.id,workspaceId:value.workspaceId,ownerUserId:value.ownerUserId,payload:value}).onConflictDoUpdate({target:contexts.id,set:{payload:value}}); }
  async getContext(workspaceId: ID, userId: ID): Promise<UserContext[]> { return (await this.db.select().from(contexts).where(and(eq(contexts.workspaceId,workspaceId),eq(contexts.ownerUserId,userId)))).map(r=>r.payload); }

  async getOnboarding(workspaceId: ID, userId: ID): Promise<SoulOnboardingRecord | undefined> {
    const [row] = await this.db.select().from(soulOnboarding)
      .where(and(eq(soulOnboarding.workspaceId, workspaceId), eq(soulOnboarding.userId, userId))).limit(1);
    return row === undefined ? undefined : onboardingFromRow(row);
  }

  async putOnboarding(value: SoulOnboardingRecord): Promise<void> {
    await this.db.insert(soulOnboarding).values({
      id: value.id, userId: value.userId, workspaceId: value.workspaceId, status: value.status,
      step: value.step, locale: value.locale, consentId: value.consentId ?? null,
      skippedSteps: [...value.skippedSteps], startedAt: new Date(value.startedAt), updatedAt: new Date(value.updatedAt),
      completedAt: value.completedAt === undefined ? null : new Date(value.completedAt),
      dismissedAt: value.dismissedAt === undefined ? null : new Date(value.dismissedAt),
    }).onConflictDoUpdate({
      target: [soulOnboarding.userId, soulOnboarding.workspaceId],
      set: {
        status: value.status, step: value.step, locale: value.locale, consentId: value.consentId ?? null,
        skippedSteps: [...value.skippedSteps], updatedAt: new Date(value.updatedAt),
        completedAt: value.completedAt === undefined ? null : new Date(value.completedAt),
        dismissedAt: value.dismissedAt === undefined ? null : new Date(value.dismissedAt),
      },
    });
  }

  async listOnboardingForUser(userId: ID): Promise<readonly SoulOnboardingRecord[]> {
    const rows = await this.db.select().from(soulOnboarding).where(eq(soulOnboarding.userId, userId));
    return rows.map(onboardingFromRow);
  }

  async getCapabilities(): Promise<CapabilityDefinition[]> { return (await this.db.select().from(capabilities)).map(r=>r.payload); }
  async getCapability(id: ID): Promise<CapabilityDefinition | undefined> { return (await this.db.select().from(capabilities).where(eq(capabilities.id,id)).limit(1))[0]?.payload; }
  async recordExecution(value: ExecutionLink): Promise<void> { await this.db.insert(executions).values({id:value.id,operationId:value.operationId,attemptId:value.stepAttemptId,provider:value.provider,workflowRunId:value.workflowRunId,payload:value}); }

  private eventRow(event: Omit<EventRecord,'id'|'eventVersion'>) {
    const payload: EventRecord = {...event, id:newId(),eventVersion:1};
    return {id:payload.id,workspaceId:payload.workspaceId,operationId:payload.operationId,kind:payload.kind,occurredAt:payload.occurredAt,payload};
  }
}

function onboardingFromRow(row: typeof soulOnboarding.$inferSelect): SoulOnboardingRecord {
  return {
    id: row.id, userId: row.userId, workspaceId: row.workspaceId,
    status: row.status as SoulOnboardingStatus, step: row.step as SoulOnboardingStep,
    locale: row.locale === 'fr' ? 'fr' : 'en',
    consentId: row.consentId ?? undefined,
    skippedSteps: (row.skippedSteps ?? []) as SoulOnboardingStep[],
    startedAt: row.startedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(), dismissedAt: row.dismissedAt?.toISOString(),
  };
}
