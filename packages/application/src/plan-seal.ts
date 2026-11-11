import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DomainError, validatePlan, type ID, type WorkStep } from '@qeynox/domain';
import { QeyNoxStore, planSeals } from '@qeynox/persistence';
export interface PlanSeal { revisionId:ID;operationId:ID;contentHash:string;sealedAt:string;capabilityVersions:Record<string,number> }
export class PlanSealer {
  constructor(private readonly store:QeyNoxStore){}
  async prepare(operationId:ID,revisionId:ID):Promise<PlanSeal>{
    const rev=await this.store.getRevision(revisionId);
    if(!rev||rev.operationId!==operationId||rev.status!=='ACTIVE')throw new DomainError('INVALID_STATE','Plan revision not active');
    const steps=await this.store.getSteps(revisionId);
    validatePlan(steps,revisionId);
    const versions:Record<string,number>={};
    for(const step of steps){
      const cap=await this.store.getCapability(step.capabilityId);
      if(!cap||cap.status!=='ACTIVE')throw new DomainError('NOT_CONFIGURED','Step capability is not active');
      if(step.intent==='EXTERNAL_ACTION'&&!cap.allowedTools.length)throw new DomainError('DENIED','External action has no approved tools');
      if(!Number.isFinite(cap.maximumSteps)||steps.length>cap.maximumSteps)throw new DomainError('DENIED','Capability execution limit exceeded');
      versions[cap.id]=cap.version;
    }
    const normalized=steps.map(s=>({id:s.id,ordinal:s.ordinal,capabilityId:s.capabilityId,version:versions[s.capabilityId],dependsOn:[...s.dependsOn].sort(),description:s.description,intent:s.intent})).sort((a,b)=>a.ordinal-b.ordinal);
    const contentHash=createHash('sha256').update(JSON.stringify({operationId,revisionId,normalized})).digest('hex');
    return {revisionId,operationId,contentHash,sealedAt:new Date().toISOString(),capabilityVersions:versions};
  }
  async read(revisionId:ID):Promise<PlanSeal|undefined>{
    const [row]=await this.store.db.select().from(planSeals).where(eq(planSeals.revisionId,revisionId)).limit(1);
    return row ? {revisionId:row.revisionId as ID,operationId:row.operationId as ID,contentHash:row.contentHash,sealedAt:row.sealedAt,capabilityVersions:row.capabilityVersions} : undefined;
  }
}
