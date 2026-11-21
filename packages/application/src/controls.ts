import { and,eq,desc } from 'drizzle-orm';
import { DomainError,newId,redoStep,descendants,type ID,type Principal,type StepAttempt,type Operation } from '@qeynox/domain';
import { QeyNoxStore,BetaAccessStore,attempts,commandIds,operations,outbox,approvals,events } from '@qeynox/persistence';
import { withBetaDenialLedger } from './beta-access';

export class OperationControlService {
  private readonly beta:BetaAccessStore;
  constructor(private readonly store:QeyNoxStore){this.beta=new BetaAccessStore(store.db);}
  async interrupt(actor:Principal,operationId:ID,version:number) {
    const op=await this.store.getOperation(actor,operationId);
    if(!['RUNNING','WAITING_APPROVAL'].includes(op.status))throw new DomainError('INVALID_STATE','Operation is not active');
    // Cancellation is a REQUEST only. Observed engine state must later reconcile the final status.
    return this.store.transition(actor,operationId,'INTERRUPT_REQUESTED',version);
  }

  async requestRedo(actor:Principal,operationId:ID,priorAttemptId:ID,expectedVersion:number,commandKey:string) {
    const op=await this.store.getOperation(actor,operationId);
    if(op.version!==expectedVersion)throw new DomainError('CONFLICT','Operation version changed');
    if(!['INTERRUPTED','FAILED','COMPLETED','READY'].includes(op.status))throw new DomainError('INVALID_STATE','Stop active work before redo');
    const prior=await this.store.getAttempt(priorAttemptId);
    if(!prior||prior.operationId!==operationId||!op.currentRevisionId||prior.planRevisionId!==op.currentRevisionId)throw new DomainError('NOT_FOUND','Previous attempt not in current revision');
    const planSteps=await this.store.getSteps(prior.planRevisionId);
    if(!planSteps.some(s=>s.id===prior.workStepId))throw new DomainError('NOT_FOUND','Prior step missing');
    const existing=await this.store.db.select().from(attempts).where(eq(attempts.stepId,prior.workStepId)).orderBy(desc(attempts.sequence)).limit(1);
    const sequence=Math.max(prior.sequence,(existing[0]?.sequence??0))+1;
    const now=new Date().toISOString(),next=redoStep(prior,now,sequence);
    const affected=[...descendants(planSteps,prior.workStepId)];
    // A21.02: a redo re-launches work, so it passes the same beta gate as a start (inside the transaction).
    return withBetaDenialLedger(this.beta,{workspaceId:actor.workspaceId,actorUserId:actor.userId,operationId,kind:'LAUNCH_DENIED'},()=>this.store.db.transaction(async tx=>{
      const [duplicate]=await tx.select().from(commandIds).where(and(eq(commandIds.workspaceId,actor.workspaceId),eq(commandIds.commandKey,commandKey))).limit(1);
      if(duplicate) {
        if(duplicate.operationId!==operationId)throw new DomainError('CONFLICT','Idempotency key already used');
        return {...duplicate.outcome,alreadyAccepted:true};
      }
      const [current]=await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId),eq(operations.version,expectedVersion))).limit(1);
      if(!current)throw new DomainError('CONFLICT','Concurrent operation change');
      await this.beta.admitMission(tx,{workspaceId:actor.workspaceId,operationId,actorUserId:actor.userId,at:new Date(),trigger:'REDO'});
      const updated:Operation={...op,status:'RUNNING',version:expectedVersion+1,updatedAt:now,lastActivityAt:now};
      const [modified]=await tx.update(operations).set({payload:updated,status:'RUNNING',version:updated.version,lastActivityAt:now}).where(and(eq(operations.id,operationId),eq(operations.version,expectedVersion))).returning({id:operations.id});
      if(!modified)throw new DomainError('CONFLICT','Concurrent change');
      await tx.insert(attempts).values({id:next.id,operationId,stepId:next.workStepId,revisionId:next.planRevisionId,sequence:next.sequence,state:next.state,payload:next});
      const outcome={attemptId:next.id,downstreamAffected:affected,operationId};
      await tx.insert(commandIds).values({id:newId(),workspaceId:actor.workspaceId,operationId,commandKey,outcome,createdAt:now});
      await tx.insert(outbox).values({id:newId(),workspaceId:actor.workspaceId,operationId,topic:'EXECUTE_STEP',idempotencyKey:commandKey,payload:{operationId,planRevisionId:prior.planRevisionId,stepAttemptId:next.id,idempotencyKey:commandKey},createdAt:now,nextAttemptAt:now});
      const ev={id:newId(),workspaceId:actor.workspaceId,operationId,kind:'STEP_REDO_REQUESTED',actorId:actor.userId,data:{priorAttemptId,newAttemptId:next.id,affected},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:ev.id,workspaceId:actor.workspaceId,operationId,kind:ev.kind,occurredAt:now,payload:ev});
      return {...outcome,alreadyAccepted:false};
    }));
  }

  /**
   * A06: approval accuracy.
   *
   * An approval binds to one plan revision. If the operation moved to a newer revision, the approval
   * no longer authorises anything and must be refused as STALE rather than as a generic invalid
   * state, so the customer is told to re-review instead of guessing why the button failed. A
   * concurrent double-decision is a CONFLICT, and only one of the two can win.
   */
  async decideApproval(actor:Principal,approvalId:ID,decision:'APPROVED'|'REJECTED',operationId?:ID){
    const approval=await this.store.getApproval(actor,approvalId),op=await this.store.getOperation(actor,approval.operationId);
    if(operationId&&approval.operationId!==operationId)throw new DomainError('DENIED','Approval does not belong to requested operation');
    if(op.currentRevisionId!==approval.planRevisionId)throw new DomainError('INVALID_STATE','STALE_APPROVAL: the plan was revised after this approval was requested');
    if(op.status!=='WAITING_APPROVAL')throw new DomainError('INVALID_STATE','Approval is stale or operation is not waiting');
    const decided=await this.store.decideApproval(actor,approvalId,decision);
    // A decision is not proof the operation moved; record the observed transition attempt.
    await this.store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'APPROVAL_'+decision,actorId:actor.userId,data:{approvalId,planRevisionId:approval.planRevisionId,purpose:approval.purpose},occurredAt:new Date().toISOString()});
    return decided;
  }
}
