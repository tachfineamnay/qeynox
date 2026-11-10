import { and,eq } from 'drizzle-orm';
import { DomainError, newId, validatePlan, type ID, type Principal, type OperationPlan, type PlanRevision, type WorkStep } from '@qeynox/domain';
import { QeyNoxStore, operations, plans, planRevisions, steps, events } from '@qeynox/persistence';

export interface PlanStepDraft {
  title:string; description:string; capabilityId:ID; dependsOnIndices:readonly number[];
  intent:'RESEARCH'|'ANALYZE'|'VERIFY'|'EXTERNAL_ACTION';
}
export class PlanningService {
  constructor(private readonly store:QeyNoxStore) {}
  async create(actor:Principal,operationId:ID,expectedVersion:number,drafts:readonly PlanStepDraft[]) {
    const op=await this.store.getOperation(actor,operationId);
    if(op.version!==expectedVersion)throw new DomainError('CONFLICT','Operation changed');
    if(op.currentRevisionId)throw new DomainError('INVALID_STATE','Use plan revision service for an existing plan');
    if(op.status!=='DRAFT')throw new DomainError('INVALID_STATE','Only draft operations can receive first plan');
    const now=new Date().toISOString();
    const plan:OperationPlan={id:newId(),operationId,latestRevision:1,createdAt:now};
    const revision:PlanRevision={id:newId(),operationId,planId:plan.id,revision:1,reason:'Initial plan',createdBy:actor.userId,createdAt:now,status:'ACTIVE'};
    const ids=drafts.map(()=>newId());
    const entries:WorkStep[]=drafts.map((d,i)=>({
      id:ids[i]!,operationId,planRevisionId:revision.id,ordinal:i,title:d.title,description:d.description,
      capabilityId:d.capabilityId,dependsOn:d.dependsOnIndices.map(n=>{
        if(!Number.isInteger(n)||n<0||n>=drafts.length)throw new DomainError('INVALID_INPUT','Dependency index outside plan');
        return ids[n]!;
      }),state:'PENDING',intent:d.intent,version:1,
    }));
    validatePlan(entries,revision.id);
    // Capability configuration must exist; a nonexistent slot must never be treated as a live agent.
    for(const entry of entries) {
      const c=await this.store.getCapability(entry.capabilityId);
      if(!c||c.status!=='ACTIVE')throw new DomainError('NOT_CONFIGURED','Business capability not configured: '+entry.capabilityId);
      if(entry.intent==='EXTERNAL_ACTION' && !c.allowedTools.length) throw new DomainError('DENIED','External action requires reviewed tools');
    }
    await this.store.db.transaction(async tx=>{
      const [existing]=await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId),eq(operations.version,expectedVersion))).limit(1);
      if(!existing)throw new DomainError('CONFLICT','Concurrent operation change');
      await tx.insert(plans).values({id:plan.id,operationId,payload:plan});
      await tx.insert(planRevisions).values({id:revision.id,operationId,planId:plan.id,revision:1,payload:revision});
      await tx.insert(steps).values(entries.map(s=>({id:s.id,operationId,revisionId:revision.id,payload:s})));
      const updated={...op,currentRevisionId:revision.id,status:'READY' as const,version:op.version+1,updatedAt:now,lastActivityAt:now};
      await tx.update(operations).set({currentRevisionId:revision.id,payload:updated,status:updated.status,version:updated.version,lastActivityAt:now}).where(and(eq(operations.id,operationId),eq(operations.version,expectedVersion)));
      const ev={id:newId(),workspaceId:actor.workspaceId,operationId,kind:'PLAN_CREATED',actorId:actor.userId,data:{revisionId:revision.id},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:ev.id,workspaceId:actor.workspaceId,operationId,kind:ev.kind,occurredAt:now,payload:ev});
    });
    return {plan,revision,steps:entries};
  }
}
