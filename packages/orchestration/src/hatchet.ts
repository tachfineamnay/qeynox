import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { DomainError } from '@qeynox/domain';
import type { ExecutionRequest,ExternalExecution,OrchestratorPort } from './port';
export type StepHandler=(request:ExecutionRequest,runtime:{workflowRunId:string})=>Promise<{outcome:'COMPLETED'|'WAITING_APPROVAL'|'FAILED';detail?:string}>;
export const WORKFLOW_NAME='qeynox-execute-step-v1';
export const WORKER_NAME='qeynox-worker-v1';

/**
 * Installed SDK contract (@hatchet-dev/typescript-sdk 1.46.1, v1):
 * - `HatchetClient.init()` → client
 * - `client.task({name,fn,retries})` → TaskWorkflowDeclaration with `runNoWait(): Promise<WorkflowRunRef>`
 * - `WorkflowRunRef.getWorkflowRunId(): Promise<string>` and `.cancel(): Promise<void>`
 * - `client.worker(name, opts): Promise<Worker>` with `worker.start(): Promise<void>`
 * - `client.runs.getDetails(runId): Promise<RunDetail>` / `client.runs.cancel({ids})`.
 */
export function createHatchetRuntime(handler:StepHandler) {
  if(!process.env.HATCHET_CLIENT_TOKEN)throw new DomainError('NOT_CONFIGURED','Hatchet token required');
  const client=HatchetClient.init();
  const task=client.task<ExecutionRequest,{outcome:string,detail?:string}>({
    name:WORKFLOW_NAME,retries:0,fn:async(input,ctx)=>handler(input,{workflowRunId:ctx.workflowRunId()}),
  });
  return {client,task};
}
type HatchetRuntime = ReturnType<typeof createHatchetRuntime>;
export class HatchetAdapter implements OrchestratorPort {
  constructor(private readonly runtime:HatchetRuntime){}
  async enqueue(input:ExecutionRequest):Promise<ExternalExecution> {
    const ref=await this.runtime.task.runNoWait(input,{additionalMetadata:{operationId:input.operationId,revisionId:input.planRevisionId,attemptId:input.stepAttemptId,idempotencyKey:input.idempotencyKey}});
    // The installed SDK returns `workflowRunId` as an eventual value on the ref; prefer the
    // typed async accessor and fail closed rather than guessing an unverified property.
    const workflowRunId=typeof ref.getWorkflowRunId==='function'?await ref.getWorkflowRunId():undefined;
    if(!workflowRunId||typeof workflowRunId!=='string')throw new DomainError('UNSUPPORTED','Hatchet run identity needs validated SDK mapping');
    return {provider:'HATCHET',workflowRunId,requestedAt:new Date().toISOString()};
  }
  async cancel(workflowRunId:string):Promise<'REQUESTED'> {
    if(!workflowRunId)throw new DomainError('INVALID_INPUT','Hatchet workflow run ID required');
    try {
      // Installed SDK: `runs.cancel({ids})`. Success here is only a cancellation REQUEST;
      // the business state must be reconciled from observed run state, never assumed.
      await this.runtime.client.runs.cancel({ids:[workflowRunId]});
      return 'REQUESTED';
    } catch(error:unknown) {
      throw new DomainError('UNKNOWN_OUTCOME','Hatchet cancellation was not confirmed: '+(error instanceof Error?error.message:'unknown error'));
    }
  }
}
export interface ObservedRun { state:'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'UNKNOWN'; observedAt:string; externalRunId:string }
/**
 * Run observation through the installed SDK's documented `runs.getDetails` API.
 * Network/API failures surface as UNKNOWN_OUTCOME so recovery never fabricates run state.
 */
export class HatchetRunInspector {
  constructor(private readonly client:HatchetClient){}
  async observe(runId:string):Promise<ObservedRun|'UNSUPPORTED'> {
    if(!runId)throw new DomainError('INVALID_INPUT','Hatchet workflow run ID required');
    try {
      const detail=await this.client.runs.getDetails(runId);
      const status=String(detail.status);
      const state=status==='COMPLETED'?'SUCCEEDED':status==='FAILED'?'FAILED':status==='CANCELLED'?'CANCELLED':status==='QUEUED'||status==='RUNNING'?'RUNNING':'UNKNOWN';
      if(state==='UNKNOWN')return 'UNSUPPORTED';
      return {state,observedAt:new Date().toISOString(),externalRunId:runId};
    } catch(error:unknown) {
      throw new DomainError('UNKNOWN_OUTCOME','Hatchet run observation failed: '+(error instanceof Error?error.message:'unknown error'));
    }
  }
}
/** Uses the configured Hatchet client when a token is present; otherwise recovery stays unsupported. */
export function createHatchetInspector(): HatchetRunInspector|undefined {
  if(!process.env.HATCHET_CLIENT_TOKEN)return undefined;
  try {return new HatchetRunInspector(HatchetClient.init());} catch {return undefined;}
}
export async function startQeyNoxWorker(deps:{handler:StepHandler;startDispatcher:(orchestrator:OrchestratorPort)=>Promise<void>}) {
  const runtime=createHatchetRuntime(deps.handler);
  const worker=await runtime.client.worker(WORKER_NAME,{workflows:[runtime.task],slots:10});
  // The dispatcher must poll committed outbox intent while the worker is long-running.
  await deps.startDispatcher(new HatchetAdapter(runtime));
  await worker.start();
}
