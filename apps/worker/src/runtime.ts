import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type Principal,type Evidence,type StepAttempt } from '@qeynox/domain';
import { connectDatabase,QeyNoxStore,attempts,operations } from '@qeynox/persistence';
import { HermesAdapter } from '@qeynox/engine';
import { AgentProfileStore,CapabilityRegistry } from '@qeynox/roles';
import { StepProgression,ResultService } from '@qeynox/application';
import { PgOutboxDispatcher,type ExecutionRequest,type OrchestratorPort } from '@qeynox/orchestration';
export async function createWorkerDependencies(){
  const conn=connectDatabase(process.env.DATABASE_URL);
  const store=new QeyNoxStore(conn.db), profiles=new AgentProfileStore(conn.db), progression=new StepProgression(store);
  const engine=new HermesAdapter({baseUrl:process.env.HERMES_API_BASE_URL,apiKey:process.env.HERMES_API_KEY,model:process.env.HERMES_MODEL??'hermes-agent',timeoutMs:Number(process.env.HERMES_REQUEST_TIMEOUT_MS??60000),nativeToolsIsolated:process.env.HERMES_NATIVE_TOOLS_ISOLATED==='true'});
  return {
    handler:async(request:ExecutionRequest,runtime:{workflowRunId:string})=>{
      const [row]=await conn.db.select().from(operations).where(and(eq(operations.id,request.operationId),eq(operations.workspaceId,request.workspaceId))).limit(1);
      if(!row||row.payload.currentRevisionId!==request.planRevisionId||row.status!=='RUNNING')throw new DomainError('INVALID_STATE','Inactive operation');
      const attempt=await store.getAttempt(request.stepAttemptId);
      if(!attempt||attempt.operationId!==request.operationId||attempt.planRevisionId!==request.planRevisionId||attempt.state!=='PENDING')throw new DomainError('INVALID_STATE','Invalid attempt');
      const step=(await store.getSteps(request.planRevisionId)).find(s=>s.id===attempt.workStepId);
      if(!step)throw new DomainError('NOT_FOUND','Step missing');
      const cap=new CapabilityRegistry(await store.getCapabilities()).get(step.capabilityId);
      const profile=await profiles.getActive('business:'+cap.slot);
      const start:StepAttempt={...attempt,state:'RUNNING',startedAt:new Date().toISOString(),version:attempt.version+1};
      const [claimed]=await conn.db.update(attempts).set({state:'RUNNING',payload:start}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'PENDING'))).returning({id:attempts.id});
      if(!claimed)throw new DomainError('CONFLICT','Concurrent attempt execution');
      try {
        const previous=await progression.priorOutputs(request.operationId,request.planRevisionId,step.id);
        const response=await engine.invoke({workspaceId:row.workspaceId as any,operationId:row.id as any,stepAttemptId:attempt.id,profile,userMessage:step.description,context:{operationTitle:row.payload.title,stepTitle:step.title,capabilityPurpose:cap.purpose,priorOutputs:previous},correlationId:request.idempotencyKey});
        if(response.status!=='COMPLETED'||response.proposedTools.length)throw new DomainError('NOT_CONFIGURED','Agent not complete or requires a governed tool call');
        const evidence:Evidence={id:newId(),operationId:row.id as any,stepAttemptId:attempt.id,statement:response.content,observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['Model text requires independent source verification']};
        await store.recordEvidence(evidence);
        const state=await progression.complete(attempt.id,{text:response.content,engine:response.engine,engineRunId:response.engineRunId,evidenceId:evidence.id},'UNVERIFIED');
        return {outcome:'COMPLETED' as const,detail:state};
      } catch(error:unknown) {
        const end:StepAttempt={...start,state:'FAILED',version:start.version+1,finishedAt:new Date().toISOString(),errorCode:error instanceof DomainError?error.code:'ENGINE_FAILED'};
        await conn.db.update(attempts).set({state:'FAILED',payload:end}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'RUNNING')));
        await store.writeEvent({workspaceId:row.workspaceId as any,operationId:row.id as any,kind:'STEP_FAILED',data:{stepAttemptId:attempt.id,errorCode:end.errorCode},occurredAt:new Date().toISOString()});
        throw error;
      }
    },
    startDispatcher:async(orchestrator:OrchestratorPort)=>{
      const dispatcher=new PgOutboxDispatcher(conn.pool,orchestrator);
      const deliver=async()=>{try{await dispatcher.dispatchOnce();}catch(e){console.error('Outbox dispatch error:',e instanceof Error?e.message:'unknown');}};
      await deliver();setInterval(()=>{void deliver();},5000);
    },
  };
}
