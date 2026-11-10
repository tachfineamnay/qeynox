import type { ID } from '@qeynox/domain';

export type ExecutionRequest = Readonly<{
  workspaceId: ID; operationId: ID; planRevisionId: ID; stepAttemptId: ID; idempotencyKey: string;
}>;
export type ExternalExecution = Readonly<{ provider: 'HATCHET'; workflowRunId: string; requestedAt: string }>;
export interface OrchestratorPort {
  enqueue(input: ExecutionRequest): Promise<ExternalExecution>;
  cancel(workflowRunId: string): Promise<'REQUESTED' | 'UNSUPPORTED'>;
}
