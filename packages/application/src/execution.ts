import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal,type StepAttempt,type Operation } from '@qeynox/domain';
import { QeyNoxStore,attempts,outbox,events,operations,commandIds } from '@qeynox/persistence';

export class OperationExecutionService {
  constructor(private readonly store:QeyNoxStore) {}
  async start(actor:Principal,operationId:ID,expectedVersion:number,commandKey:string) {
    const [accepted]=await this.store.db.select().from(commandIds).where(and(eq(commandIds.workspaceId,actor.workspaceId),eq(commandIds.commandKey,commandKey))).limit(1);
    if(accepted) {
      if(accepted.operationId!==operationId)throw new DomainError('CONFLICT','Idempotency key already used for a different operation');
      return {alreadyAccepted:true,...accepted.outcome};
    }
    const op=await this.store.getOperation(actor,operationId);
    if(op.version!==expectedVersion)throw new DomainError('CONFLICT','Operation version mismatch');
    if(!op.currentRevisionId||!['READY','INTERRUPTED','FAILED'].includes(op.status))throw new DomainError('INVALID_STATE','Operation has no eligible active plan');
    const all=await this.store.getSteps(op.currentRevisionId);
    if(!all.length)throw new DomainError('INVALID_STATE','No plan steps');
    const first=all.find(s=>s.dependsOn.length===0);
    if(!first)throw new DomainError('INVALID_STATE','No first executable step');
    const other=await this.store.db.select().from(attempts).where(eq(attempts.stepId,first.id));
    const now=new Date().toISOString();
    const attempt:StepAttempt={id:newId(),operationId,planRevisionId:first.planRevisionId,workStepId:first.id,sequence:other.length+1,state:'PENDING',version:1,createdAt:now};
    return this.store.db.transaction(async tx=>{
      const [row]=await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId),eq(operations.version,expectedVersion))).limit(1);
      if(!row)throw new DomainError('CONFLICT','Concurrent start');
      const updated:Operation={...op,status:'RUNNING',version:expectedVersion+1,updatedAt:now,lastActivityAt:now};
      await tx.insert(attempts).values({id:attempt.id,operationId,stepId:first.id,revisionId:attempt.planRevisionId,sequence:attempt.sequence,state:attempt.state,payload:attempt});
      await tx.insert(outbox).values({id:newId(),workspaceId:actor.workspaceId,operationId,topic:'EXECUTE_STEP',idempotencyKey:commandKey,payload:{operationId,planRevisionId:attempt.planRevisionId,stepAttemptId:attempt.id,idempotencyKey:commandKey},createdAt:now,nextAttemptAt:now});
      await tx.insert(commandIds).values({id:newId(),workspaceId:actor.workspaceId,operationId,commandKey,outcome:{operationId,attemptId:attempt.id},createdAt:now});
      const [changed]=await tx.update(operations).set({status:'RUNNING',version:updated.version,lastActivityAt:now,payload:updated}).where(and(eq(operations.id,operationId),eq(operations.version,expectedVersion))).returning({id:operations.id});
      if(!changed)throw new DomainError('CONFLICT','Concurrent start');
      const ev={id:newId(),workspaceId:actor.workspaceId,operationId,kind:'EXECUTION_REQUESTED',actorId:actor.userId,data:{stepAttemptId:attempt.id,revisionId:attempt.planRevisionId},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:ev.id,workspaceId:actor.workspaceId,operationId,kind:ev.kind,occurredAt:now,payload:ev});
      return {operationId,attemptId:attempt.id,alreadyAccepted:false};
    });
  }
}
