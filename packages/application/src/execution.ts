import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal,type StepAttempt,type Operation } from '@qeynox/domain';
import { QeyNoxStore,attempts,outbox,events,operations,commandIds,planSeals } from '@qeynox/persistence';
import { PlanSealer } from './plan-seal';
import { CommerceService } from './commerce';
export class OperationExecutionService {
 private readonly sealer:PlanSealer;
 private readonly commerce:CommerceService;
 constructor(private readonly store:QeyNoxStore){this.sealer=new PlanSealer(store);this.commerce=new CommerceService(store);}
 async start(actor:Principal,operationId:ID,expectedVersion:number,commandKey:string){
  const [accepted]=await this.store.db.select().from(commandIds).where(and(eq(commandIds.workspaceId,actor.workspaceId),eq(commandIds.commandKey,commandKey))).limit(1);
  if(accepted){if(accepted.operationId!==operationId)throw new DomainError('CONFLICT','Idempotency key reused');return {...accepted.outcome,alreadyAccepted:true};}
  const op=await this.store.getOperation(actor,operationId);
  if(op.version!==expectedVersion)throw new DomainError('CONFLICT','Operation version mismatch');
  if(!op.currentRevisionId||!['READY','INTERRUPTED','FAILED'].includes(op.status))throw new DomainError('INVALID_STATE','Plan not ready');
  await this.commerce.assertExecutionAllowed(actor,operationId,op.currentRevisionId);
  const planSeal=await this.sealer.prepare(operationId,op.currentRevisionId);
  const planSteps=await this.store.getSteps(op.currentRevisionId);
  const first=planSteps.filter(s=>s.dependsOn.length===0).sort((a,b)=>a.ordinal-b.ordinal)[0];
  if(!first)throw new DomainError('INVALID_STATE','Plan has no entry step');
  const previous=await this.store.db.select().from(attempts).where(eq(attempts.stepId,first.id));
  const now=new Date().toISOString();
  const attempt:StepAttempt={id:newId(),operationId,planRevisionId:first.planRevisionId,workStepId:first.id,sequence:previous.length+1,state:'PENDING',version:1,createdAt:now};
  return this.store.db.transaction(async tx=>{
   const [current]=await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId),eq(operations.version,expectedVersion))).for('update').limit(1);
   if(!current)throw new DomainError('CONFLICT','Concurrent operation start');
   const [sealed]=await tx.select().from(planSeals).where(eq(planSeals.revisionId,planSeal.revisionId)).limit(1);
   if(sealed&&sealed.contentHash!==planSeal.contentHash)throw new DomainError('CONFLICT','Plan changed after sealing');
   if(!sealed)await tx.insert(planSeals).values(planSeal);
   const updated:Operation={...op,status:'RUNNING',version:expectedVersion+1,updatedAt:now,lastActivityAt:now};
   await tx.insert(attempts).values({id:attempt.id,operationId,stepId:first.id,revisionId:attempt.planRevisionId,sequence:attempt.sequence,state:'PENDING',payload:attempt});
   await tx.insert(outbox).values({id:newId(),workspaceId:actor.workspaceId,operationId,topic:'EXECUTE_STEP',idempotencyKey:commandKey,payload:{operationId,planRevisionId:attempt.planRevisionId,stepAttemptId:attempt.id,idempotencyKey:commandKey},createdAt:now,nextAttemptAt:now});
   await tx.insert(commandIds).values({id:newId(),workspaceId:actor.workspaceId,operationId,commandKey,outcome:{operationId,attemptId:attempt.id},createdAt:now});
   await tx.update(operations).set({status:updated.status,version:updated.version,lastActivityAt:now,payload:updated}).where(and(eq(operations.id,operationId),eq(operations.version,expectedVersion)));
   const ev={id:newId(),workspaceId:actor.workspaceId,operationId,kind:'EXECUTION_REQUESTED',actorId:actor.userId,data:{attemptId:attempt.id,revisionId:attempt.planRevisionId},occurredAt:now,eventVersion:1};
   await tx.insert(events).values({id:ev.id,workspaceId:ev.workspaceId,operationId,kind:ev.kind,occurredAt:now,payload:ev});
   return {operationId,attemptId:attempt.id,alreadyAccepted:false};
  });
 }
}
