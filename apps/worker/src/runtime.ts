import { and,eq } from 'drizzle-orm';
import { DomainError,newId,transitionOperation,type ID,type Evidence,type StepAttempt } from '@qeynox/domain';
import { connectDatabase,QeyNoxStore,attempts,operations,events } from '@qeynox/persistence';
import { HermesAdapter,hermesCapabilities,hermesSettingsFromEnv,hermesFailureFacts } from '@qeynox/engine';
import { AgentProfileStore,CapabilityRegistry } from '@qeynox/roles';
import { StepProgression,BrokeredAgentExecutor,ClaimsService,ResultAssembler,EngineRegistry,ExecutionEngineSelection,NotificationService,createEmailTransportFromEnv,createRuntimeProbeMonitor,runtimeExecutionBlocker,recoverBusinessPackMission,businessPackStepRole,assertBusinessPackProfile,capturedPackSources,businessPackStepInstructions,acceptBusinessPackDeliverable,recordBusinessPackClaims,rawOutputDigest,DocumentVaultService,createS3ArtifactStoreFromEnv,documentMaintenanceConfiguration,storageFailureCode,embeddingsFromEnv,prepareMissionDocuments,recordMissionDocumentCitations,missionDocumentQuery } from '@qeynox/application';
import { NotificationStore } from '@qeynox/persistence';
import { createConfiguredToolRegistry } from '@qeynox/tools';
import { PgOutboxDispatcher,type ExecutionRequest,type OrchestratorPort } from '@qeynox/orchestration';
import { evaluateQaRuntimeBypass } from './qa-runtime-bypass';
import { SerialPoller } from './serial-poller';

export async function createWorkerDependencies(){
 // P08: the URLs this worker is actually wired to; the QA bypass is judged against these, not later env.
 const connectedDatabaseUrl=process.env.DATABASE_URL,connectedHermesBaseUrl=process.env.HERMES_API_BASE_URL;
 const conn=connectDatabase(connectedDatabaseUrl),store=new QeyNoxStore(conn.db);
 try {
 const profiles=new AgentProfileStore(conn.db),progression=new StepProgression(store);
 const engine=new HermesAdapter({...hermesSettingsFromEnv(process.env),onDiagnostic:event=>{
   // Structured allowlisted facts only: no prompt, answer, provider body or credential in logs.
   console.info('QEYNOX_ENGINE',JSON.stringify({phase:event.phase,correlationId:event.correlationId,model:event.model,provider:event.provider,httpStatus:event.httpStatus,finishReason:event.finishReason,usageReported:event.usageReported,durationMs:event.durationMs,errorCode:event.errorCode}));
 }});
 // Startup snapshot for inspection/QA. Mission execution must reload the actual
 // operator configuration: an ACTIVE capability can change while the worker is running.
 const tools=await createConfiguredToolRegistry(conn.db);
 const registry=new EngineRegistry();
 // MISSION A21.07: the worker verifies the runtime with its OWN bounded live probes (Hermes and Hatchet,
 // separately). No environment boolean and no default evidence string can mark it verified; a restarted
 // worker holds no evidence until it has probed again.
 const runtimeMonitor=createRuntimeProbeMonitor(process.env);
 // The registration reads the latest Hermes verification at selection time (getters, not a snapshot).
 registry.register({id:'hermes',version:'hermes-api-unverified',runtime:engine,capabilities:hermesCapabilities,
  get verifiedLive(){return runtimeMonitor.readiness().engine.verifiedLive;},
  get evidence(){return runtimeMonitor.readiness().engine.evidence;}});
 const selections=new ExecutionEngineSelection(store,registry);
 const claims=new ClaimsService(store);
 const documents=new ResultAssembler(store);
 // MISSION P10: attached-document retrieval for agent steps. No object store is passed: this path reads
 // indexed chunks under workspace/mission/consent rules only and can never fetch or sign storage objects.
 const vault=new DocumentVaultService(store,undefined,embeddingsFromEnv());
 let dispatcherPoller:SerialPoller|undefined;
 let documentPoller:SerialPoller|undefined;
 let closeStorage:(()=>void)|undefined;
 let closing=false;
 let backgroundStarted=false;
 let closePromise:Promise<void>|undefined;
 const stopBackground=async()=>{
   closing=true;
   runtimeMonitor.stop();
   try{await Promise.all([dispatcherPoller?.stop(),documentPoller?.stop()]);}
   finally{closeStorage?.();closeStorage=undefined;}
 };
 return {
  handler:async(request:ExecutionRequest,runtime:{workflowRunId:string})=>{
   const [row]=await conn.db.select().from(operations).where(and(eq(operations.id,request.operationId),eq(operations.workspaceId,request.workspaceId))).limit(1);
   if(!row||row.payload.currentRevisionId!==request.planRevisionId||row.status!=='RUNNING')throw new DomainError('INVALID_STATE','Inactive operation');
   const attempt=await store.getAttempt(request.stepAttemptId);
   if(!attempt||attempt.operationId!==request.operationId||attempt.planRevisionId!==request.planRevisionId||attempt.state!=='PENDING')throw new DomainError('INVALID_STATE','Invalid attempt');
   const planSteps=await store.getSteps(request.planRevisionId);
   const step=planSteps.find(s=>s.id===attempt.workStepId);
   if(!step)throw new DomainError('NOT_FOUND','Missing step');
   const cap=new CapabilityRegistry(await store.getCapabilities()).get(step.capabilityId);
   const profile=await profiles.getActive('business:'+cap.slot);
   const start:StepAttempt={...attempt,state:'RUNNING',startedAt:new Date().toISOString(),version:attempt.version+1};
   const [claimed]=await conn.db.update(attempts).set({state:'RUNNING',payload:start}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'PENDING'))).returning({id:attempts.id});
   if(!claimed)throw new DomainError('CONFLICT','Attempt already claimed');
   try{
    const prior=await progression.priorOutputs(request.operationId,request.planRevisionId,step.id);
    const owner={userId:row.payload.createdBy,workspaceId:row.payload.workspaceId,roles:['system:worker']};
    // MISSION P09: a business-pack mission recovers its fingerprint-verified request and pack identity
    // BEFORE any engine selection or budget use; an unrecoverable pack mission fails closed here and is
    // never executed as a generic one. Generic missions get null and keep the path below unchanged.
    const packMission=recoverBusinessPackMission(await store.getGoal(owner,request.operationId));
    const packRole=packMission?businessPackStepRole(packMission,planSteps,step):null;
    if(packMission)assertBusinessPackProfile(profile);
    // MISSION A01 / A21.07: tenant execution requires an OPERATIONAL runtime proven by this worker's own
    // fresh probes (selectOperational). P08: QEYNOX_QA_ALLOW_UNVERIFIED=true is honoured ONLY in an
    // explicitly isolated QA run (marker + non-deployed env + loopback qeynox_qa_* database + loopback
    // Hermes double + no Hatchet token); otherwise it is refused and the gate below applies.
    const qaBypass = evaluateQaRuntimeBypass(process.env,{databaseUrl:connectedDatabaseUrl,hermesBaseUrl:connectedHermesBaseUrl});
    if (qaBypass.requested && !qaBypass.allowed) warnRefusedQaBypass(qaBypass.refusedBecause);
    if (qaBypass.allowed) {
      await selections.select(owner,request.operationId,request.planRevisionId,attempt.id,profile,'hermes');
    } else {
      // A21.07: BOTH components must be verified by fresh probe evidence; anything not VERIFIED is
      // re-probed once (bounded) right here, then the step is refused if either is still unproven.
      const runtimeBlock=runtimeExecutionBlocker(await runtimeMonitor.freshReadiness());
      if(runtimeBlock)throw new DomainError(runtimeBlock.code,runtimeBlock.message);
      await selections.selectOperational(owner,request.operationId,request.planRevisionId,attempt.id,profile,'hermes');
    }
    // Reload active providers per attempt; never execute with a stale, startup-only ToolRegistry.
    // Unknown or disallowed provider configurations fail closed inside this attempt.
    const currentTools=await createConfiguredToolRegistry(conn.db);
    const executor=new BrokeredAgentExecutor(store,engine,currentTools);
    const genericContext={operationTitle:row.payload.title,stepTitle:step.title,capabilityPurpose:cap.purpose,priorOutputs:prior};
    // P09: pack steps carry the pack's business instructions; the final step gets the <pack>@1 output
    // contract and the exact URIs ToolBroker captured so far in this revision.
    const packInstructions=packMission&&packRole
      ?businessPackStepInstructions(packMission,step,packRole,packRole==='DELIVERABLE'?await capturedPackSources(store,row.workspaceId as ID,row.id as ID,request.planRevisionId):[],prior)
      :null;
    // MISSION P10: bounded excerpts from AVAILABLE documents attached to THIS mission (workspace, consent,
    // retention, revocation and profile rules enforced by the vault); null when nothing is attached.
    const missionDocuments=await prepareMissionDocuments(vault,store,owner,{operationId:row.id as ID,query:missionDocumentQuery([row.payload.title,step.title,step.description]),profile});
    const run=await executor.run({
      workspaceId:row.workspaceId as ID,operationId:row.id as ID,stepAttemptId:attempt.id,
      profile,userMessage:packInstructions?.userMessage??step.description,context:{...genericContext,...(packInstructions?.context??{}),...(missionDocuments?.context??{})},
      correlationId:request.idempotencyKey,
    },cap);
    const answer=run.outcome;
    if(answer.status!=='COMPLETED')throw new DomainError('INVALID_STATE','Agent did not finish business step');
    // P10: grounded document citations (re-checked after the run) are recorded only for an ACCEPTED output.
    const groundDocuments=async()=>missionDocuments?{documentGrounding:await recordMissionDocumentCitations(vault,store,owner,{operationId:row.id as ID,stepAttemptId:attempt.id,grounding:missionDocuments.grounding,agentOutput:answer.content})}:{};
    if(packMission&&packRole==='DELIVERABLE'){
      // Validate the ACTUAL Hermes output first (existing A16 validator, context rebuilt from the
      // recovered request and this revision's captures). A rejected deliverable throws
      // INVALID_AGENT_OUTPUT: no evidence, claim, output or document is written for it.
      const captured=await capturedPackSources(store,row.workspaceId as ID,row.id as ID,request.planRevisionId);
      const accepted=acceptBusinessPackDeliverable(packMission,answer.content,captured);
      const documentGrounding=await groundDocuments();
      const evidence:Evidence={id:newId(),operationId:row.id as ID,stepAttemptId:attempt.id,statement:'Validated '+packMission.contractKey+' structured deliverable (agent output sha256 '+rawOutputDigest(answer.content)+')',observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['Structured deliverable passed its pack schema and integrity rules; each claim still requires evidence assessment and human review']};
      await store.recordEvidence(evidence);
      await recordBusinessPackClaims(claims,owner,{operationId:request.operationId,attemptId:attempt.id,profileId:profile.id,profileVersion:profile.version},packMission,accepted.projection,captured);
      const state=await progression.complete(attempt.id,{text:answer.content,engine:answer.engine,engineRunId:answer.engineRunId,evidenceId:evidence.id,businessDeliverable:accepted.record,...documentGrounding},'UNVERIFIED');
      // The ResultAssembler derives the pack document from the recorded deliverable; human review stays mandatory.
      if(state==='AWAITING_REVIEW')await documents.assemble(owner,request.operationId,request.planRevisionId,row.payload.title,[],[]);
      return {outcome:'COMPLETED' as const,detail:state};
    }
    if(packMission){
      // Supporting pack step: its output and ToolBroker captures feed the final deliverable. It does not
      // register a generic AGENT_FINDING; the domain claims come only from the validated deliverable.
      const evidence:Evidence={id:newId(),operationId:row.id as ID,stepAttemptId:attempt.id,statement:answer.content,observedAt:new Date().toISOString(),status:'UNVERIFIED',limitations:['Supporting step output for a business-pack deliverable; not a finding']};
      await store.recordEvidence(evidence);
      const state=await progression.complete(attempt.id,{text:answer.content,engine:answer.engine,engineRunId:answer.engineRunId,evidenceId:evidence.id,...await groundDocuments()},'UNVERIFIED');
      return {outcome:'COMPLETED' as const,detail:state};
    }
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
    const state=await progression.complete(attempt.id,{text:answer.content,engine:answer.engine,engineRunId:answer.engineRunId,evidenceId:evidence.id,...await groundDocuments()},'UNVERIFIED');
    if(state==='AWAITING_REVIEW')await documents.assemble(owner,request.operationId,request.planRevisionId,row.payload.title,[],[]);
    return {outcome:'COMPLETED' as const,detail:state};
   }catch(error:unknown){
    const now=new Date().toISOString();
    // A06: propagate the REAL failure. Before this, every non-DomainError collapsed into
    // ENGINE_OR_TOOL_ERROR, so an unknown external write and a broken JSON parse looked identical
    // to the customer, the operator and any later retry decision. An unknown outcome is now its own
    // code, and the attempt is not marked as a clean failure because we cannot prove it failed.
    const errorCode=error instanceof DomainError?error.code:'UNEXPECTED_EXECUTION_ERROR';
    const unknownOutcome=errorCode==='UNKNOWN_OUTCOME';
    const engineFailure=hermesFailureFacts(error);
    const failed:StepAttempt={...start,state:'FAILED',finishedAt:now,version:start.version+1,errorCode};
    const attemptFailed=await conn.db.transaction(async tx=>{
      const [currentAttempt]=await tx.select().from(attempts).where(eq(attempts.id,attempt.id)).for('update').limit(1);
      // A post-step failure (for example result assembly) must not turn a COMPLETED
      // attempt into FAILED or overwrite an operation already waiting for review.
      if(!currentAttempt||currentAttempt.state!=='RUNNING')return false;
      await tx.update(attempts).set({state:'FAILED',payload:failed}).where(and(eq(attempts.id,attempt.id),eq(attempts.state,'RUNNING')));
      const [currentOp]=await tx.select().from(operations).where(and(eq(operations.id,row.id),eq(operations.workspaceId,row.workspaceId))).for('update').limit(1);
      if(currentOp?.status==='RUNNING'&&currentOp.payload.currentRevisionId===request.planRevisionId){
        // An exhausted budget is a policy stop, not a business failure, but the lifecycle only
        // allows RUNNING -> FAILED (there is no direct RUNNING -> INTERRUPTED edge). The status is
        // therefore FAILED with an explicit policy code, so the customer sees a stop rather than a
        // claim that the business step itself was defective. Retrying is permitted once the operator
        // raises the budget; the recorded code says exactly why it stopped.
        const next=transitionOperation(currentOp.payload,'FAILED',now,currentOp.version);
        await tx.update(operations).set({status:'FAILED',version:next.version,payload:{...next,lastErrorCode:errorCode},lastActivityAt:now}).where(and(eq(operations.id,row.id),eq(operations.version,currentOp.version)));
      }
      const event={id:newId(),workspaceId:row.workspaceId as ID,operationId:row.id as ID,kind:unknownOutcome?'STEP_OUTCOME_UNKNOWN':'STEP_FAILED',data:{attemptId:attempt.id,errorCode,...engineFailure},occurredAt:now,eventVersion:1};
      await tx.insert(events).values({id:event.id,workspaceId:event.workspaceId,operationId:event.operationId,kind:event.kind,occurredAt:now,payload:event});
      return true;
    });
    if(!attemptFailed){
      await store.writeEvent({workspaceId:row.workspaceId as ID,operationId:row.id as ID,kind:'POST_STEP_FAILURE',data:{attemptId:attempt.id,errorCode,...engineFailure},occurredAt:now});
    }
    throw error;
   }
  },
  startDispatcher:async(orchestrator:OrchestratorPort)=>{
    if(closing||backgroundStarted)throw new DomainError('CONFLICT','Dispatcher already started or worker closing');
    backgroundStarted=true;
    const maintenance=documentMaintenanceConfiguration();
    const interval=maintenance.intervalMs;
    const objects=createS3ArtifactStoreFromEnv();
    if(interval>0&&objects){
      closeStorage=()=>objects.close();
      const documentVault=new DocumentVaultService(store,objects,embeddingsFromEnv());
      const report=(phase:string,error:unknown)=>console.error('QEYNOX_STORAGE',JSON.stringify({phase,failure:storageFailureCode(error),operatorAttention:true}));
      documentPoller=new SerialPoller(async()=>{
        try{const result=await documentVault.drainIngestPending({limit:maintenance.ingestBatch});if(result.failed)console.error('QEYNOX_STORAGE',JSON.stringify({phase:'INGEST',...result,operatorAttention:true}));}catch(error:unknown){report('ingest drain failed',error);}
        try{await documentVault.purgeExpired({limit:maintenance.retentionBatch});}catch(error:unknown){report('retention purge failed',error);}
        try{
          const result=await documentVault.drainStorageDeletions({limit:maintenance.deletionBatch});
          if(result.failed||result.retrying)console.error('QEYNOX_STORAGE',JSON.stringify({phase:'DELETION',...result,operatorAttention:result.failed>0}));
        }catch(error:unknown){report('deletion sweep failed',error);}
      },interval,error=>report('poller failed',error));
      await documentPoller.start();
    }else {
      objects?.close();
      if(process.env.NODE_ENV==='production')throw new DomainError('NOT_CONFIGURED','Document maintenance requires private storage and an enabled poller');
      console.log('[documents] poller disabled or storage not configured; ingestion stays fail-closed');
    }
    const dispatcher=new PgOutboxDispatcher(conn.pool,orchestrator);
    // MISSION A19: the same loop that drains the execution outbox also materializes notification
    // events (approval required / execution failed / result delivered) and sends what is due.
    // Idempotent by deduplication key; a failure here never blocks step execution.
    const notifications=new NotificationService(new NotificationStore(conn.db),createEmailTransportFromEnv(),{publicBaseUrl:process.env.QEYNOX_PUBLIC_URL??null});
    const deliver=async()=>{
      try{await dispatcher.dispatchOnce();}catch(error:unknown){console.error('Outbox dispatch error:',error instanceof Error?error.message:'unknown');}
      try{await notifications.drain(25);}catch(error:unknown){console.error('Notification drain error:',error instanceof Error?error.message:'unknown');}
    };
    dispatcherPoller=new SerialPoller(deliver,5000,error=>console.error('Dispatcher polling error:',error instanceof Error?error.message:'unknown'));
    await dispatcherPoller.start();
  },
  runtimeMonitor,
  stopBackground,
  close:()=>{closePromise??=(async()=>{try{await stopBackground();}finally{await conn.close();}})();return closePromise;},
  toolRegistry:tools, // startup snapshot retained for existing QA callers
  loadToolRegistry:()=>createConfiguredToolRegistry(conn.db),
 };
 } catch(error:unknown) { await conn.close(); throw error; }
}

let refusedQaBypassWarned=false;
/** P08: a requested-but-refused QA bypass is reported once per process, by condition NAME only. */
function warnRefusedQaBypass(reasons:readonly string[]):void{
 if(refusedQaBypassWarned)return;
 refusedQaBypassWarned=true;
 console.warn('QEYNOX_QA_ALLOW_UNVERIFIED refused (runtime gate enforced): '+reasons.join('; '));
}
