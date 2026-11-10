import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type Principal,type Evidence,type StepAttempt } from '@qeynox/domain';
import { connectDatabase,QeyNoxStore,attempts,operations } from '@qeynox/persistence';
import { HermesAdapter } from '@qeynox/engine';
import { AgentProfileStore,CapabilityRegistry } from '@qeynox/roles';
import { ResultService } from '@qeynox/application';
import { PgOutboxDispatcher,type ExecutionRequest,type OrchestratorPort } from '@qeynox/orchestration';

export async function createWorkerDependencies() {
  const conn=connectDatabase(process.env.DATABASE_URL);
  const store=new QeyNoxStore(conn.db),profiles=new AgentProfileStore(conn.db);
  const engine=new HermesAdapter({
    baseUrl:process.env.HERMES_API_BASE_URL,apiKey:process.env.HERMES_API_KEY,model:process.env.HERMES_MODEL??'hermes-agent',
    timeoutMs:Number(process.env.HERMES_REQUEST_TIMEOUT_MS??60000),nativeToolsIsolated:process.env.HERMES_NATIVE_TOOLS_ISOLATED==='true',
  });
  const results=new ResultService(store);
  return {
    handler:async(request:ExecutionRequest,runtime:{workflowRunId:string})=>{
      const [opRow]=await conn.db.select().from(operations).where(and(eq(operations.id,request.operationId),eq(operations.workspaceId,request.workspaceId))).limit(1);
      if(!opRow)throw new DomainError('NOT_FOUND','Unknown operation');
      const op=opRow.payload;
      if(op.currentRevisionId!==request.planRevisionId||op.status!=='RUNNING')throw new DomainError('INVALID_STATE','Stale/inactive workflow run');
      const actor:Principal={workspaceId:request.workspaceId,userId:op.createdBy,roles:['system:worker']};
      const attempt=await store.getAttempt(request.stepAttemptId);
      if(!attempt||attempt.operationId!==request.operationId||attempt.planRevisionId!==request.planRevisionId)throw new DomainError('DENIED','Attempt mismatch');
      if(attempt.state!=='PENDING')throw new DomainError('CONFLICT','Attempt already underway or terminal');
      const currentSteps=await store.getSteps(request.planRevisionId),step=currentSteps.find(s=>s.id===attempt.workStepId);
      if(!step)throw new DomainError('NOT_FOUND','Planned step missing');
      const caps=new CapabilityRegistry(await store.getCapabilities());
      const cap=caps.get(step.capabilityId),profile=await profiles.getActive('business:'+cap.slot);
      const started:StepAttempt={...attempt,state:'RUNNING',startedAt:new Date().toISOString(),version:attempt.version+1};
      const [claimed]=await conn.db.update(attempts).set({state:'RUNNING',payload:started}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'PENDING'))).returning({id:attempts.id});
      if(!claimed)throw new DomainError('CONFLICT','Attempt claimed elsewhere');
      let completed=false;
      try{
        const response=await engine.invoke({workspaceId:actor.workspaceId,operationId:op.id,stepAttemptId:attempt.id,profile,userMessage:step.description,context:{operationTitle:op.title,stepTitle:step.title,capabilityPurpose:cap.purpose},correlationId:request.idempotencyKey});
        if(response.status!=='COMPLETED')throw new DomainError('INVALID_STATE','Agent did not finish successfully');
        if(response.proposedTools.length)throw new DomainError('NOT_CONFIGURED','Tool proposals await a reviewed ToolBroker approval flow');
        const evidence:Evidence={id:newId(),operationId:op.id,stepAttemptId:attempt.id,statement:response.content,observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['Agent output is not independently verified']};
        await store.recordEvidence(evidence);
        await results.prepareDraft(actor,op.id,request.planRevisionId,step.title,response.content,[evidence],[]);
        await store.writeEvent({workspaceId:op.workspaceId,operationId:op.id,kind:'RESULT_REQUIRES_VERIFICATION',data:{attemptId:attempt.id},occurredAt:new Date().toISOString()});
        completed=true;
        return {outcome:'FAILED' as const,detail:'Draft recorded; verification required'};
      }catch(error:unknown){
        await store.writeEvent({workspaceId:op.workspaceId,operationId:op.id,kind:'STEP_EXECUTION_BLOCKED',data:{attemptId:attempt.id,errorCode:error instanceof DomainError?error.code:'ENGINE_FAILED'},occurredAt:new Date().toISOString()});
        throw error;
      }finally{
        // FAILED means the RaaS deliverable did not pass verification, not that stored evidence was erased.
        const end:StepAttempt={...started,state:'FAILED',finishedAt:new Date().toISOString(),version:started.version+1,errorCode:completed?'NOT_VERIFIED':'ENGINE_OR_TOOL_ERROR'};
        await conn.db.update(attempts).set({state:end.state,payload:end}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'RUNNING')));
        const fresh=await store.getOperation(actor,op.id);
        if(fresh.status==='RUNNING')await store.transition(actor,op.id,'FAILED',fresh.version);
      }
    },
    startDispatcher:async(orchestrator:OrchestratorPort)=>{
      const dispatcher=new PgOutboxDispatcher(conn.pool,orchestrator);
      const deliver=async()=>{try{await dispatcher.dispatchOnce();}catch(e){console.error('Outbox dispatch error:',e instanceof Error?e.message:'unknown');}};
      await deliver();
      setInterval(()=>{void deliver();},5000); // intentional outbox delivery loop, not a workflow engine
    },
  };
}
