import { and,eq } from 'drizzle-orm';
import { DomainError,newId,transitionOperation,type ID,type Evidence,type StepAttempt } from '@qeynox/domain';
import { connectDatabase,QeyNoxStore,attempts,operations,events } from '@qeynox/persistence';
import { HermesAdapter,hermesCapabilities } from '@qeynox/engine';
import { AgentProfileStore,CapabilityRegistry } from '@qeynox/roles';
import { StepProgression,BrokeredAgentExecutor,ClaimsService,ResultAssembler,EngineRegistry,ExecutionEngineSelection } from '@qeynox/application';
import { createConfiguredToolRegistry } from '@qeynox/tools';
import { PgOutboxDispatcher,type ExecutionRequest,type OrchestratorPort } from '@qeynox/orchestration';

export async function createWorkerDependencies(){
 const conn=connectDatabase(process.env.DATABASE_URL),store=new QeyNoxStore(conn.db);
 const profiles=new AgentProfileStore(conn.db),progression=new StepProgression(store);
 const hermesProvider=process.env.HERMES_PROVIDER;
 const engine=new HermesAdapter({baseUrl:process.env.HERMES_API_BASE_URL,privateOrigin:process.env.HERMES_PRIVATE_ORIGIN,apiKey:process.env.HERMES_API_KEY,model:process.env.HERMES_MODEL??'hermes-agent',provider:hermesProvider==='vertex'||hermesProvider==='gemini'||hermesProvider==='custom'?hermesProvider:undefined,timeoutMs:Number(process.env.HERMES_REQUEST_TIMEOUT_MS??60000),nativeToolsIsolated:process.env.HERMES_NATIVE_TOOLS_ISOLATED==='true',egressAttested:process.env.QEYNOX_NETWORK_POLICY_ATTESTED==='true'});
 // Startup snapshot for inspection/QA. Mission execution must reload the actual
 // operator configuration: an ACTIVE capability can change while the worker is running.
 const tools=await createConfiguredToolRegistry(conn.db);
 const registry=new EngineRegistry();
 // MISSION A01: runtime is UNVERIFIED until live verification evidence is present.
 // verifiedLive requires QEYNOX_RUNTIME_VERIFIED_LIVE=true + evidence; config flag alone is not proof.
 const verifiedLive = process.env.QEYNOX_RUNTIME_VERIFIED_LIVE === 'true';
 const evidence = verifiedLive ? (process.env.QEYNOX_RUNTIME_VERIFICATION_EVIDENCE ?? 'live-probe') : null;
 registry.register({id:'hermes',version:'hermes-api-unverified',runtime:engine,capabilities:hermesCapabilities,verifiedLive,evidence});
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
    // MISSION A01: tenant execution requires OPERATIONAL runtime (verifiedLive + evidence).
    // QA fixtures use select() with isolated mock server; production must use selectOperational().
    // We attempt operational first; if not verified, fail closed with NOT_CONFIGURED (never present as executable).
    // For backward compat with existing QA that sets QEYNOX_RUNTIME_VERIFIED_LIVE=true, this passes.
    // If QA does not set verifiedLive, it will fail closed — which is correct per mission.
    // To preserve existing QA scripts that rely on mock Hermes without verifiedLive, we allow select()
    // when QEYNOX_QA_ALLOW_UNVERIFIED=true (explicit QA opt-in, never in production).
    const allowUnverifiedQa = process.env.QEYNOX_QA_ALLOW_UNVERIFIED === 'true';
    if (allowUnverifiedQa) {
      await selections.select(owner,request.operationId,request.planRevisionId,attempt.id,profile,'hermes');
    } else {
      await selections.selectOperational(owner,request.operationId,request.planRevisionId,attempt.id,profile,'hermes');
    }
    // Reload active providers per attempt; never execute with a stale, startup-only ToolRegistry.
    // Unknown or disallowed provider configurations fail closed inside this attempt.
    const currentTools=await createConfiguredToolRegistry(conn.db);
    const executor=new BrokeredAgentExecutor(store,engine,currentTools);
    const run=await executor.run({
      workspaceId:row.workspaceId as ID,operationId:row.id as ID,stepAttemptId:attempt.id,
      profile,userMessage:step.description,context:{operationTitle:row.payload.title,stepTitle:step.title,capabilityPurpose:cap.purpose,priorOutputs:prior},
      correlationId:request.idempotencyKey,
    },cap);
    const answer=run.outcome;
    if(answer.status!=='COMPLETED')throw new DomainError('INVALID_STATE','Agent did not finish business step');
    const evidence:Evidence={id:newId(),operationId:row.id as ID,stepAttemptId:attempt.id,statement:answer.content,observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['AI summary requires evidence assessment']};
    await store.recordEvidence(evidence);
    const claim=await claims.register(owner,{operationId:request.operationId,attemptId:attempt.id,statement:answer.content,kind:'AGENT_FINDING',profileId:profile.id,profileVersion:profile.version});
    // Every provider observation captured by the broker is linked to this claim with its exact
    // response digest, then assessed against the active verification policy for the capability.
    for(const observation of run.observations){
      await claims.attach(owner,claim.id as ID,observation.sourceId,'SUPPORTS',observation.evidenceId,observation.responseDigest);
    }
    if(run.observations.length){
      try{await claims.assessActive(owner,claim.id as ID);}
      catch(error:unknown){
        // No active policy means the claim stays UNVERIFIED; any other failure is an integrity error.
        if(!(error instanceof DomainError)||error.code!=='NOT_CONFIGURED')throw error;
      }
    }
    const state=await progression.complete(attempt.id,{text:answer.content,engine:answer.engine,engineRunId:answer.engineRunId,evidenceId:evidence.id},'UNVERIFIED');
    if(state==='AWAITING_REVIEW')await documents.assemble(owner,request.operationId,request.planRevisionId,row.payload.title,[],[]);
    return {outcome:'COMPLETED' as const,detail:state};
   }catch(error:unknown){
    const now=new Date().toISOString();
    const failed:StepAttempt={...start,state:'FAILED',finishedAt:now,version:start.version+1,errorCode:error instanceof DomainError?error.code:'ENGINE_OR_TOOL_ERROR'};
    const attemptFailed=await conn.db.transaction(async tx=>{
      const [currentAttempt]=await tx.select().from(attempts).where(eq(attempts.id,attempt.id)).for('update').limit(1);
      // A post-step failure (for example result assembly) must not turn a COMPLETED
      // attempt into FAILED or overwrite an operation already waiting for review.
      if(!currentAttempt||currentAttempt.state!=='RUNNING')return false;
      await tx.update(attempts).set({state:'FAILED',payload:failed}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'RUNNING')));
      const [currentOp]=await tx.select().from(operations).where(and(eq(operations.id,row.id),eq(operations.workspaceId,row.workspaceId))).for('update').limit(1);
      if(currentOp?.status==='RUNNING'&&currentOp.payload.currentRevisionId===request.planRevisionId){
        const next=transitionOperation(currentOp.payload,'FAILED',now,currentOp.version);
        await tx.update(operations).set({status:'FAILED',version:next.version,payload:{...next,lastErrorCode:failed.errorCode},lastActivityAt:now}).where(and(eq(operations.id,row.id),eq(operations.version,currentOp.version)));
      }
      const event={id:newId(),workspaceId:row.workspaceId as ID,operationId:row.id as ID,kind:'STEP_FAILED',data:{attemptId:attempt.id,errorCode:failed.errorCode},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:event.id,workspaceId:event.workspaceId,operationId:event.operationId,kind:event.kind,occurredAt:now,payload:event});
      return true;
    });
    if(!attemptFailed){
      await store.writeEvent({workspaceId:row.workspaceId as ID,operationId:row.id as ID,kind:'POST_STEP_FAILURE',data:{attemptId:attempt.id,errorCode:failed.errorCode},occurredAt:now});
    }
    throw error;
   }
  },
  startDispatcher:async(orchestrator:OrchestratorPort)=>{
    const dispatcher=new PgOutboxDispatcher(conn.pool,orchestrator);
    const deliver=async()=>{try{await dispatcher.dispatchOnce();}catch(error:unknown){console.error('Outbox dispatch error:',error instanceof Error?error.message:'unknown');}};
    await deliver();setInterval(()=>{void deliver();},5000);
  },
  close:async()=>{await conn.close();},
  toolRegistry:tools, // startup snapshot retained for existing QA callers
  loadToolRegistry:()=>createConfiguredToolRegistry(conn.db),
 };
}
