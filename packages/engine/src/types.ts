import type { ID } from '@qeynox/domain';

export interface AgentProfile {
  id: ID; role: 'soul'|'pilot'|'business'; version: number;
  title: string; systemInstructions: string; skillRefs: readonly string[];
  allowedTools: readonly string[]; permittedContextKeys: readonly string[];
  maxOutputTokens: number; maxIterations: number;
}
export interface EngineRequest {
  workspaceId: ID; operationId: ID; stepAttemptId: ID; profile: AgentProfile;
  userMessage: string; context: Readonly<Record<string,unknown>>;
  correlationId: string; priorMessages?: readonly {role:'user'|'assistant',content:string}[];
}
export interface ProposedToolAction { connectorId:string; toolName:string; version:string; input:unknown; reason:string; }
export interface EngineOutcome {
  status: 'COMPLETED'|'INCOMPLETE'|'FAILED';
  engine: string; engineRunId?: string; content: string;
  proposedTools: readonly ProposedToolAction[];
  usage?: { inputTokens?:number; outputTokens?:number; totalTokens?:number };
  reason?:string; receivedAt:string;
}
/** Truthful, side-effect-free readiness report. Never performs network I/O. */
export interface EngineAvailability {
  readonly available: boolean;
  /** Stable machine-readable reason; 'READY' only when a call could actually be dispatched. */
  readonly reason: 'READY' | 'NO_ENDPOINT' | 'NO_CREDENTIAL' | 'NO_ATTESTATION' | 'INVALID_TIMEOUT' | 'INVALID_MODEL' | 'INVALID_ENDPOINT' | 'UNKNOWN';
}
export interface EnginePort {
  invoke(request: EngineRequest, options?: {signal?:AbortSignal}):Promise<EngineOutcome>;
  /**
   * Optional: adapters that cannot attest readiness omit it, and callers must then treat the engine
   * as unavailable rather than assuming it works.
   */
  isAvailable?():EngineAvailability;
}
