import { and, eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type WorkStep,type StepAttempt,type Evidence,type ApprovalRequest,type Operation } from '@qeynox/domain';
import { QeyNoxStore,operations,steps,attempts,stepOutputs,outbox,events,approvals,planSeals } from '@qeynox/persistence';

export class StepProgression {
  constructor(private readonly store:QeyNoxStore){}
  async priorOutputs(operationId:ID,revisionId:ID,stepId:ID):Promise<readonly {stepId:string;attemptId:string;content:unknown;quality:string}[]>{
    const plan=await this.store.getSteps(revisionId);
    const step=plan.find(s=>s.id===stepId);
    if(!step||step.operationId!==operationId)throw new DomainError('NOT_FOUND','Step not in operation');
    if(!step.dependsOn.length)return [];
    const outputRows=await this.store.db.select().from(stepOutputs).where(and(eq(stepOutputs.revisionId,revisionId),eq(stepOutputs.operationId,operationId)));
    return step.dependsOn.map(dep=>{
      const out=outputRows.filter(r=>r.stepId===dep).at(-1);
      if(!out)throw new DomainError('INVALID_STATE','Dependency output unavailable');
      return {stepId:out.stepId,attemptId:out.attemptId,content:out.content,quality:out.quality};
    });
  }
  async complete(attemptId:ID, content:unknown, quality:'UNVERIFIED'|'SUPPORTED'):Promise<'NEXT_QUEUED'|'AWAITING_REVIEW'>{
    const original=await this.store.getAttempt(attemptId);
    if(!original||original.state!=='RUNNING')throw new DomainError('INVALID_STATE','Attempt not running');
    const now=new Date().toISOString();
    return this.store.db.transaction(async tx=>{
      const [opRow]=await tx.select().from(operations).where(eq(operations.id,original.operationId)).for('update').limit(1);
      if(!opRow||opRow.payload.currentRevisionId!==original.planRevisionId||opRow.status!=='RUNNING')throw new DomainError('INVALID_STATE','Operation changed');
      const [seal]=await tx.select().from(planSeals).where(eq(planSeals.revisionId,original.planRevisionId)).limit(1);
      if(!seal)throw new DomainError('INVALID_STATE','Plan is not sealed');
      const [at]=await tx.select().from(attempts).where(and(eq(attempts.id,attemptId),eq(attempts.state,'RUNNING'))).limit(1);
      if(!at)throw new DomainError('CONFLICT','Attempt already processed');
      const finished:StepAttempt={...at.payload,state:'COMPLETED',version:at.payload.version+1,finishedAt:now};
      await tx.update(attempts).set({state:'COMPLETED',payload:finished}).where(eq(attempts.id,attemptId));
      await tx.insert(stepOutputs).values({id:newId(),operationId:original.operationId,revisionId:original.planRevisionId,stepId:original.workStepId,attemptId:original.id,content,quality,createdAt:now});
      const allSteps=(await tx.select().from(steps).where(eq(steps.revisionId,original.planRevisionId))).map(s=>s.payload).sort((a,b)=>a.ordinal-b.ordinal);
      const allAttempts=(await tx.select().from(attempts).where(eq(attempts.revisionId,original.planRevisionId))).map(a=>a.payload);
      const done=new Set(allAttempts.filter(a=>a.state==='COMPLETED').map(a=>a.workStepId));
      done.add(original.workStepId);
      const next=allSteps.find(s=>!done.has(s.id)&&s.dependsOn.every(dep=>done.has(dep))&&!allAttempts.some(a=>a.workStepId===s.id&&['PENDING','RUNNING','WAITING_APPROVAL'].includes(a.state)));
      if(next){
        const latest=allAttempts.filter(a=>a.workStepId===next.id).reduce((n,a)=>Math.max(n,a.sequence),0);
        const upcoming:StepAttempt={id:newId(),operationId:original.operationId,planRevisionId:original.planRevisionId,workStepId:next.id,sequence:latest+1,state:'PENDING',createdAt:now,version:1};
        await tx.insert(attempts).values({id:upcoming.id,operationId:original.operationId,revisionId:original.planRevisionId,stepId:next.id,sequence:upcoming.sequence,state:'PENDING',payload:upcoming});
        const key='step:'+upcoming.id;
        await tx.insert(outbox).values({id:newId(),workspaceId:opRow.workspaceId,operationId:original.operationId,idempotencyKey:key,topic:'EXECUTE_STEP',payload:{operationId:original.operationId,planRevisionId:original.planRevisionId,stepAttemptId:upcoming.id,idempotencyKey:key},createdAt:now,nextAttemptAt:now});
      } else if(done.size>=allSteps.length){
        const approval:ApprovalRequest={id:newId(),workspaceId:opRow.workspaceId,operationId:original.operationId,planRevisionId:original.planRevisionId,stepAttemptId:original.id,purpose:'RESULT_REVIEW',status:'PENDING',requestedAt:now,expiresAt:new Date(Date.now()+30*86400000).toISOString()};
        await tx.insert(approvals).values({id:approval.id,workspaceId:approval.workspaceId,operationId:approval.operationId,status:approval.status,payload:approval});
        const updated:Operation={...opRow.payload,status:'WAITING_APPROVAL',version:opRow.version+1,updatedAt:now,lastActivityAt:now};
        await tx.update(operations).set({status:updated.status,version:updated.version,payload:updated,lastActivityAt:now}).where(eq(operations.id,original.operationId));
      } else {
        throw new DomainError('INVALID_STATE','No eligible next step; dependency or state conflict');
      }
      const ev={id:newId(),workspaceId:opRow.workspaceId,operationId:original.operationId,kind:next?'STEP_COMPLETED_NEXT_QUEUED':'STEPS_COMPLETED_REVIEW_REQUIRED',data:{completedAttempt:original.id,nextStepId:next?.id,quality},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:ev.id,workspaceId:ev.workspaceId,operationId:ev.operationId,kind:ev.kind,occurredAt:now,payload:ev});
      return next?'NEXT_QUEUED':'AWAITING_REVIEW';
    });
  }
}
