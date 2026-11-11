import { and,eq } from 'drizzle-orm';
import { DomainError,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,engineSelections } from '@qeynox/persistence';
import type { AgentProfile,EnginePort,RuntimeCapabilities } from '@qeynox/engine';
export interface EngineRegistration {id:string;version:string;runtime:EnginePort;capabilities:RuntimeCapabilities}
export class EngineRegistry {
 private readonly registrations=new Map<string,EngineRegistration>();
 register(reg:EngineRegistration):void{
  if(reg.id!==reg.capabilities.id||this.registrations.has(reg.id))throw new DomainError('CONFLICT','Duplicate or inconsistent engine runtime');
  this.registrations.set(reg.id,reg);
 }
 get(id:string):EngineRegistration{
  const registered=this.registrations.get(id);
  if(!registered)throw new DomainError('NOT_CONFIGURED','Agent runtime is not registered');
  return registered;
 }
}
export class ExecutionEngineSelection {
 constructor(private readonly store:QeyNoxStore,private readonly registry:EngineRegistry){}
 async select(actor:Principal,operationId:ID,revisionId:ID,attemptId:ID,profile:AgentProfile,engineId:string):Promise<EngineRegistration>{
  const op=await this.store.getOperation(actor,operationId);
  if(op.currentRevisionId!==revisionId)throw new DomainError('CONFLICT','Engine selection requires current revision');
  const attempt=await this.store.getAttempt(attemptId);
  if(!attempt||attempt.operationId!==operationId||attempt.planRevisionId!==revisionId)throw new DomainError('DENIED','Attempt identity mismatch');
  const reg=this.registry.get(engineId);
  if(reg.capabilities.invocation==='UNSUPPORTED'||reg.capabilities.invocation==='NOT_VERIFIED')throw new DomainError('UNSUPPORTED','Runtime invocation is not supported by code');
  const chosen={attemptId,workspaceId:actor.workspaceId,operationId,revisionId,engineId:reg.id,engineVersion:reg.version,profileId:profile.id,profileVersion:profile.version,selectedAt:new Date().toISOString(),selectionPolicy:{configured:true}};
  const inserted=await this.store.db.insert(engineSelections).values(chosen).onConflictDoNothing().returning({attemptId:engineSelections.attemptId});
  if(!inserted.length){
   const [existing]=await this.store.db.select().from(engineSelections).where(and(eq(engineSelections.attemptId,attemptId),eq(engineSelections.workspaceId,actor.workspaceId))).limit(1);
   if(!existing||existing.engineId!==reg.id||existing.engineVersion!==reg.version||existing.profileId!==profile.id||existing.profileVersion!==profile.version)throw new DomainError('CONFLICT','An attempt cannot change its engine or profile after selection');
  }
  return reg;
 }
}
