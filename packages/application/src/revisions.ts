import { and,eq } from 'drizzle-orm';
import { DomainError,forkRevision,newId,validatePlan,type ID,type Principal,type WorkStep,type Operation,type OperationPlan } from '@qeynox/domain';
import { QeyNoxStore,operations,planRevisions,plans,steps,events } from '@qeynox/persistence';
import type { PlanStepDraft } from './planning';

export class PlanRevisionService {
  constructor(private readonly store:QeyNoxStore){}
  async revise(actor:Principal,operationId:ID,revisionId:ID,expectedVersion:number,reason:string,drafts:readonly PlanStepDraft[]) {
    const op=await this.store.getOperation(actor,operationId);
    if(op.version!==expectedVersion)throw new DomainError('CONFLICT','Operation version changed');
    if(!['READY','INTERRUPTED','FAILED','COMPLETED'].includes(op.status))throw new DomainError('INVALID_STATE','Interrupt current work before revising');
    if(op.currentRevisionId!==revisionId)throw new DomainError('CONFLICT','Not current revision');
    const prior=await this.store.getRevision(revisionId);
    if(!prior||prior.operationId!==operationId)throw new DomainError('NOT_FOUND','Prior plan revision not found');
    const now=new Date().toISOString(),revision=forkRevision(prior,actor.userId,reason,now);
    const ids=drafts.map(()=>newId());
    const rewritten:WorkStep[]=drafts.map((d,i)=>({
      id:ids[i]!,operationId,planRevisionId:revision.id,ordinal:i,title:d.title,description:d.description,
      capabilityId:d.capabilityId,dependsOn:d.dependsOnIndices.map(index=>{
        if(!Number.isInteger(index)||index<0||index>=ids.length)throw new DomainError('INVALID_INPUT','Invalid dependency index');
        return ids[index]!;
      }),state:'PENDING',version:1,intent:d.intent,
    }));
    validatePlan(rewritten,revision.id);
    for(const step of rewritten) {
      const capability=await this.store.getCapability(step.capabilityId);
      if(!capability||capability.status!=='ACTIVE')throw new DomainError('NOT_CONFIGURED','Business capability is not active');
    }
    await this.store.db.transaction(async tx=>{
      const [current]=await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId),eq(operations.version,expectedVersion))).limit(1);
      if(!current)throw new DomainError('CONFLICT','Concurrent revision');
      const [planRow]=await tx.select().from(plans).where(eq(plans.id,prior.planId)).limit(1);
      if(!planRow)throw new DomainError('NOT_FOUND','Plan not found');
      const updatedPlan:OperationPlan={...planRow.payload,latestRevision:revision.revision};
      await tx.update(plans).set({payload:updatedPlan}).where(eq(plans.id,prior.planId));
      await tx.update(planRevisions).set({payload:{...prior,status:'SUPERSEDED'}}).where(eq(planRevisions.id,prior.id));
      await tx.insert(planRevisions).values({id:revision.id,operationId,planId:revision.planId,revision:revision.revision,payload:revision});
      await tx.insert(steps).values(rewritten.map(s=>({id:s.id,operationId,revisionId:revision.id,payload:s})));
      const updated:Operation={...op,currentRevisionId:revision.id,version:expectedVersion+1,status:'READY',updatedAt:now,lastActivityAt:now};
      const [modified]=await tx.update(operations).set({currentRevisionId:revision.id,version:updated.version,status:'READY',lastActivityAt:now,payload:updated}).where(and(eq(operations.id,operationId),eq(operations.version,expectedVersion))).returning({id:operations.id});
      if(!modified)throw new DomainError('CONFLICT','Concurrent revision');
      const ev={id:newId(),workspaceId:actor.workspaceId,operationId,kind:'PLAN_REVISED',actorId:actor.userId,data:{priorRevisionId:prior.id,revisionId:revision.id},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:ev.id,workspaceId:actor.workspaceId,operationId,kind:ev.kind,occurredAt:now,payload:ev});
    });
    return {revision,steps:rewritten};
  }
}
