import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Evidence,type StepAttempt } from '@qeynox/domain';
import { connectDatabase,QeyNoxStore,attempts,operations } from '@qeynox/persistence';
import { HermesAdapter,hermesCapabilities } from '@qeynox/engine';
import { AgentProfileStore,CapabilityRegistry } from '@qeynox/roles';
import { StepProgression,BrokeredAgentExecutor,ClaimsService,ResultAssembler,EngineRegistry,ExecutionEngineSelection } from '@qeynox/application';
import { createConfiguredToolRegistry } from '@qeynox/tools';
import { PgOutboxDispatcher,type ExecutionRequest,type OrchestratorPort } from '@qeynox/orchestration';

export async function createWorkerDependencies(){
 const conn=connectDatabase(process.env.DATABASE_URL),store=new QeyNoxStore(conn.db);
 const profiles=new AgentProfileStore(conn.db),progression=new StepProgression(store);
 const engine=new HermesAdapter({baseUrl:process.env.HERMES_API_BASE_URL,apiKey:process.env.HERMES_API_KEY,model:process.env.HERMES_MODEL??'hermes-agent',timeoutMs:Number(process.env.HERMES_REQUEST_TIMEOUT_MS??60000),nativeToolsIsolated:process.env.HERMES_NATIVE_TOOLS_ISOLATED==='true',egressAttested:process.env.QEYNOX_NETWORK_POLICY_ATTESTED==='true'});
 const tools=await createConfiguredToolRegistry(conn.db); // No provider is registered unless operator-configured.
 const executor=new BrokeredAgentExecutor(store,engine,tools);
 const registry=new EngineRegistry();
 registry.register({id:'hermes',version:'hermes-api-unverified',runtime:engine,capabilities:hermesCapabilities});
 const selections=new ExecutionEngineSelection(store,registry);
 const claims=new ClaimsService(store);
 const documents=new ResultAssembler(store);
 return {
  handler:async(request:ExecutionRequest,runtime:{workflowRunId:string})=>{
   const [row]=await conn.db.select().from(operations).where(and(eq(operations.id,request.operationId),eq(operations.workspaceId,request.workspaceId))).limit(1);
   if(!row||row.payload.currentRevisionId!==request.planRevisionId||row.status!=='RUNNING')throw new DomainError('INVALID_STATE','Inactive operation');
   const attempt=await store.getAttempt(request.stepAttemptId);
   if(!attempt||attempt.operationId!==request.operationId||attempt.planRevisionId!==request.planRevisionId||attempt.state!=='PENDING')throw new DomainError('INVALID_STATE','Invalid attempt');
   const step=(await store.getSteps(request.planRevisionId)).find(s=>s.id===attempt.workStepId);
   if(!step)throw new DomainError('NOT_FOUND','Missing step');
   const cap=new CapabilityRegistry(await store.getCapabilities()).get(step.capabilityId);
   const profile=await profiles.getActive('business:'+cap.slot);
   const start:StepAttempt={...attempt,state:'RUNNING',startedAt:new Date().toISOString(),version:attempt.version+1};
   const [claimed]=await conn.db.update(attempts).set({state:'RUNNING',payload:start}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'PENDING'))).returning({id:attempts.id});
   if(!claimed)throw new DomainError('CONFLICT','Attempt already claimed');
   try{
    const prior=await progression.priorOutputs(request.operationId,request.planRevisionId,step.id);
    const owner={userId:row.payload.createdBy,workspaceId:row.payload.workspaceId,roles:['system:worker']};
    await selections.select(owner,request.operationId,request.planRevisionId,attempt.id,profile,'hermes');
    const answer=await executor.run({
      workspaceId:row.workspaceId as ID,operationId:row.id as ID,stepAttemptId:attempt.id,
      profile,userMessage:step.description,context:{operationTitle:row.payload.title,stepTitle:step.title,capabilityPurpose:cap.purpose,priorOutputs:prior},
      correlationId:request.idempotencyKey,
    },cap);
    if(answer.status!=='COMPLETED')throw new DomainError('INVALID_STATE','Agent did not finish business step');
    const evidence:Evidence={id:newId(),operationId:row.id as ID,stepAttemptId:attempt.id,statement:answer.content,observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['AI summary requires evidence assessment']};
    await store.recordEvidence(evidence);
    await claims.register(owner,{operationId:request.operationId,attemptId:attempt.id,statement:answer.content,kind:'AGENT_FINDING',profileId:profile.id,profileVersion:profile.version});
    const state=await progression.complete(attempt.id,{text:answer.content,engine:answer.engine,engineRunId:answer.engineRunId,evidenceId:evidence.id},'UNVERIFIED');
    if(state==='AWAITING_REVIEW')await documents.assemble(owner,request.operationId,request.planRevisionId,row.payload.title,[],[]);
    return {outcome:'COMPLETED' as const,detail:state};
   }catch(error:unknown){
    const failed:StepAttempt={...start,state:'FAILED',finishedAt:new Date().toISOString(),version:start.version+1,errorCode:error instanceof DomainError?error.code:'ENGINE_OR_TOOL_ERROR'};
    await conn.db.update(attempts).set({state:'FAILED',payload:failed}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'RUNNING')));
    await store.writeEvent({workspaceId:row.workspaceId as ID,operationId:row.id as ID,kind:'STEP_FAILED',data:{attemptId:attempt.id,errorCode:failed.errorCode},occurredAt:new Date().toISOString()});
    throw error;
   }
  },
  startDispatcher:async(orchestrator:OrchestratorPort)=>{
    const dispatcher=new PgOutboxDispatcher(conn.pool,orchestrator);
    const deliver=async()=>{try{await dispatcher.dispatchOnce();}catch(error:unknown){console.error('Outbox dispatch error:',error instanceof Error?error.message:'unknown');}};
    await deliver();setInterval(()=>{void deliver();},5000);
  },
  close:async()=>{await conn.close();},
  toolRegistry:tools,
 };
}

