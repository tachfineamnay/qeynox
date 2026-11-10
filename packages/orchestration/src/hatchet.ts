import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { DomainError } from '@qeynox/domain';
import type { ExecutionRequest,ExternalExecution,OrchestratorPort } from './port';
export type StepHandler=(request:ExecutionRequest,runtime:{workflowRunId:string})=>Promise<{outcome:'COMPLETED'|'WAITING_APPROVAL'|'FAILED';detail?:string}>;
export const WORKFLOW_NAME='qeynox-execute-step-v1';

export function createHatchetRuntime(handler:StepHandler) {
  if(!process.env.HATCHET_CLIENT_TOKEN)throw new DomainError('NOT_CONFIGURED','Hatchet token required');
  const client=HatchetClient.init();
  const task=client.task<ExecutionRequest,{outcome:string,detail?:string}>({
    name:WORKFLOW_NAME,retries:0,fn:async(input,ctx)=>handler(input,{workflowRunId:ctx.workflowRunId()}),
  });
  return {client,task};
}
export class HatchetAdapter implements OrchestratorPort {
  constructor(private readonly runtime:ReturnType<typeof createHatchetRuntime>){}
  async enqueue(input:ExecutionRequest):Promise<ExternalExecution> {
    const ref=await this.runtime.task.runNoWait(input,{additionalMetadata:{operationId:input.operationId,revisionId:input.planRevisionId,attemptId:input.stepAttemptId,idempotencyKey:input.idempotencyKey}});
    const candidate=ref as unknown as {workflowRunId?:string;workflow_run_id?:string;runId?:string};
    const workflowRunId=candidate.workflowRunId??candidate.workflow_run_id??candidate.runId;
    if(!workflowRunId)throw new DomainError('UNSUPPORTED','Hatchet run identity needs validated SDK mapping');
    return {provider:'HATCHET',workflowRunId,requestedAt:new Date().toISOString()};
  }
  async cancel(_workflowRunId:string):Promise<'UNSUPPORTED'> {return 'UNSUPPORTED';}
}
export async function startQeyNoxWorker(deps:{handler:StepHandler;startDispatcher:(orchestrator:OrchestratorPort)=>Promise<void>}) {
  const runtime=createHatchetRuntime(deps.handler);
  const worker=await runtime.client.worker('qeynox-worker-v1',{workflows:[runtime.task],slots:10});
  const running=worker.start(); // may be long-lived: start dispatcher concurrently, not afterwards.
  await deps.startDispatcher(new HatchetAdapter(runtime));
  await running;
}
