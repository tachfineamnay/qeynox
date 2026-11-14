import { createHash } from 'node:crypto';
import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal,type Evidence,type Source } from '@qeynox/domain';
import { QeyNoxStore,approvals,identityMemberships,sourceSnapshots } from '@qeynox/persistence';
import type { EnginePort,AgentProfile,EngineOutcome,EngineRequest } from '@qeynox/engine';
import { ToolBroker,ToolRegistry,PgToolLedger,configuredProviderRateLimiter,type ConnectorCall,type PermissionContext } from '@qeynox/tools';
import { BudgetService } from './budgets';
import type { CapabilityDefinition } from '@qeynox/domain';

/** One captured provider observation linked to its source, evidence row and response digest. */
export interface CapturedObservation {
 readonly sourceId:ID;readonly evidenceId:ID;readonly responseDigest:string;
 readonly provider:string;readonly uri?:string;readonly statement:string;
}
export interface BrokeredRunResult { readonly outcome:EngineOutcome; readonly observations:readonly CapturedObservation[] }

export class BrokeredAgentExecutor {
 private readonly broker:ToolBroker;
 constructor(private readonly store:QeyNoxStore,private readonly engine:EnginePort,registry:ToolRegistry){
   this.broker=new ToolBroker(registry,new PgToolLedger(store.db),configuredProviderRateLimiter());
 }
 async run(request:EngineRequest,capability:CapabilityDefinition):Promise<BrokeredRunResult>{
   const [operation,attempt]=await Promise.all([
     this.store.db.query.operations.findFirst({where:(t,{and,eq})=>and(eq(t.id,request.operationId),eq(t.workspaceId,request.workspaceId))}),
     this.store.getAttempt(request.stepAttemptId),
   ]);
   if(!operation||operation.payload.currentRevisionId!==attempt?.planRevisionId||!attempt||attempt.operationId!==request.operationId||attempt.state!=='RUNNING')throw new DomainError('DENIED','Agent has no active operation scope');
   if(capability.id!==(await this.store.getSteps(attempt.planRevisionId)).find(s=>s.id===attempt.workStepId)?.capabilityId)throw new DomainError('DENIED','Capability mismatch');
   if(!request.profile.id||!request.profile.version)throw new DomainError('DENIED','Agent profile not versioned');
   const [member]=await this.store.db.select().from(identityMemberships).where(and(eq(identityMemberships.userId,operation.payload.createdBy),eq(identityMemberships.workspaceId,request.workspaceId),eq(identityMemberships.status,'ACTIVE'))).limit(1);
   if(!member)throw new DomainError('DENIED','Operation owner membership no longer active');
   const principal:Principal={userId:member.userId as ID,workspaceId:member.workspaceId as ID,roles:[member.role]};
   const approved=(await this.store.db.select().from(approvals).where(and(eq(approvals.operationId,request.operationId),eq(approvals.workspaceId,request.workspaceId)))).map(r=>r.payload);
   const consent=await this.store.getConsents(principal.workspaceId,principal.userId);
   const consentScopes=consent.filter(c=>!c.revokedAt&&(!c.expiresAt||c.expiresAt>new Date().toISOString())).flatMap(c=>c.scopes);
   const allowed=capability.allowedTools.filter(t=>request.profile.allowedTools.includes(t));
   const history: Array<{role:'user'|'assistant';content:string}>=[...(request.priorMessages??[])];
   const captured:CapturedObservation[]=[];
   let callsUsed=0;
   const remainingCalls=capability.maximumToolCalls;
   for(let i=0;i<Math.max(1,Math.min(request.profile.maxIterations,capability.maximumSteps));i++){
     const budget=new BudgetService(this.store);
     const engineReservation=await budget.reserve(principal,request.operationId,attempt.id,'ENGINE','hermes',request.correlationId+':turn:'+i);
     let answer:EngineOutcome;
     try {
       answer=await this.engine.invoke({...request,priorMessages:history});
       await budget.settle(principal,engineReservation.reservationId as ID,{origin:'ESTIMATED',costMinor:engineReservation.maximumCostMinor,tokensIn:answer.usage?.inputTokens,tokensOut:answer.usage?.outputTokens});
     } catch(error:unknown) {
       await budget.settle(principal,engineReservation.reservationId as ID,{origin:'UNKNOWN'});
       throw error;
     }
     if(answer.status!=='COMPLETED')return {outcome:answer,observations:captured};
     if(!answer.proposedTools.length)return {outcome:answer,observations:captured};
     if(answer.proposedTools.length>remainingCalls-callsUsed)throw new DomainError('DENIED','Agent requested more tools than its budget');
     const observations:unknown[]=[];
     for(let j=0;j<answer.proposedTools.length;j++){
       const proposal=answer.proposedTools[j]!;
       const permission:PermissionContext={principal,operationId:request.operationId,planRevisionId:attempt.planRevisionId,stepAttemptId:attempt.id,capabilityId:capability.id,profileId:request.profile.id,profileVersion:request.profile.version,allowedConnectorTools:allowed,consentScopes,approvedRequests:approved,remainingCostUnits:0,remainingToolCalls:remainingCalls-callsUsed};
       // Tool actions are proposals, never authority. WRITE requires a pre-approved intentId tied to the exact payload; no auto-approved writes.
       const serialized=JSON.stringify({proposal,attemptId:attempt.id,iteration:i,position:j});
       const hash=createHash('sha256').update(serialized).digest('hex');
       const call:ConnectorCall={operationId:request.operationId,planRevisionId:attempt.planRevisionId,stepAttemptId:attempt.id,capabilityId:capability.id,connectorId:proposal.connectorId,toolName:proposal.toolName,version:proposal.version,input:proposal.input,intentId:newId(),idempotencyKey:hash};
       const budget=new BudgetService(this.store);
       const reserved=await budget.reserve(principal,request.operationId,attempt.id,'TOOL',call.connectorId+':'+call.toolName+'@'+call.version,call.idempotencyKey);
       permission.remainingCostUnits=reserved.maximumCostMinor;
       let result;
       try { result=await this.broker.invoke(call,permission);
         await budget.settle(principal,reserved.reservationId as ID,{origin:'ESTIMATED',costMinor:reserved.maximumCostMinor});
       } catch (error) {
         await budget.settle(principal,reserved.reservationId as ID,{origin:'UNKNOWN'});
         throw error;
       }
       callsUsed++;
       const source:Source={id:newId(),workspaceId:principal.workspaceId,operationId:request.operationId,provider:result.provenance.provider,title:proposal.toolName,uri:result.provenance.sourceUri,retrievedAt:result.provenance.retrievedAt,sourcePublishedAt:result.provenance.publishedAt,fingerprint:result.provenance.responseDigest};
       await this.store.recordSource(source);
       await this.store.db.insert(sourceSnapshots).values({id:newId(),workspaceId:principal.workspaceId,operationId:request.operationId,sourceId:source.id,provider:result.provenance.provider,retrievedAt:result.provenance.retrievedAt,publishedAt:result.provenance.publishedAt,sha256:result.provenance.responseDigest,citationUri:result.provenance.sourceUri,createdAt:new Date().toISOString()});
       const evidence:Evidence={id:newId(),operationId:request.operationId,stepAttemptId:attempt.id,sourceId:source.id,statement:'Provider observation from '+proposal.toolName,observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['Provider response has not been independently assessed']};
       await this.store.recordEvidence(evidence);
       observations.push({tool:proposal.toolName,sourceId:source.id,evidenceId:evidence.id,observation:sanitize(result.value),provenance:result.provenance});
       captured.push({sourceId:source.id,evidenceId:evidence.id,responseDigest:result.provenance.responseDigest,provider:result.provenance.provider,uri:result.provenance.sourceUri,statement:'Provider observation from '+proposal.toolName});
     }
     await new BudgetService(this.store).progress(principal,request.operationId,'agent:'+attempt.id,createHash('sha256').update(JSON.stringify(observations)).digest('hex'));
     history.push({role:'assistant',content:answer.content.slice(0,3000)},{role:'user',content:JSON.stringify({kind:'brokered_tool_observations',observations})});
   }
   return {outcome:{status:'INCOMPLETE',engine:'hermes',content:'Bounded execution reached maximum iterations',proposedTools:[],reason:'ITERATION_LIMIT',receivedAt:new Date().toISOString()},observations:captured};
 }
}
function sanitize(value:unknown,depth=0):unknown{
 if(depth>5)return '[TRUNCATED]';
 if(typeof value==='string')return value.slice(0,1200);
 if(Array.isArray(value))return value.slice(0,20).map(x=>sanitize(x,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/password|secret|token|authorization|privateKey/i.test(key)).slice(0,30).map(([key,v])=>[key,sanitize(v,depth+1)]));
 return value;
}

