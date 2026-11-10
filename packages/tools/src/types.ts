import type { ZodType } from 'zod';
import type { ID, Principal, ToolInvocationIntent, ApprovalRequest } from '@qeynox/domain';

export interface ConnectorCall {
  operationId: ID; stepAttemptId: ID; planRevisionId: ID; capabilityId: ID;
  connectorId: string; toolName: string; version: string; input: unknown;
  idempotencyKey: string; approvalId?: ID; intentId: ID;
}
export interface Provenance {
  provider: string; retrievedAt: string; sourceUri?: string; publishedAt?: string;
  requestDigest: string; responseDigest: string; notes?: string;
}
export interface ToolResult { value: unknown; provenance: Provenance; }
export interface ToolContext { principal: Principal; operationId: ID; stepAttemptId: ID; signal: AbortSignal }
export interface ToolDefinition {
  name: string; version: string; mode: 'READ' | 'WRITE'; requiredScopes: readonly string[];
  allowedCapabilities: readonly ID[]; input: ZodType; output: ZodType;
  timeoutMs: number; maxCostUnits: number;
}
export interface ToolConnector {
  id: string; version: string; definitions(): readonly ToolDefinition[];
  invoke(name: string, version: string, input: unknown, context: ToolContext): Promise<{ value: unknown; sourceUri?: string; publishedAt?: string }>;
}
export interface PermissionContext {
  principal: Principal; capabilityId: ID; allowedConnectorTools: readonly string[];
  consentScopes: readonly string[]; approvedRequests: readonly ApprovalRequest[];
  remainingCostUnits: number; remainingToolCalls: number;
}
export interface ToolAuditRecord {
  intent: ToolInvocationIntent; workspaceId: ID; connectorId: string;
  requestDigest: string; resultDigest?: string; status: 'STARTED'|'COMPLETED'|'FAILED'|'UNKNOWN';
  provider: string; capturedAt: string;
}
export interface ToolLedgerPort {
  reserve(record: ToolAuditRecord): Promise<'RESERVED'|'ALREADY_COMPLETED'|'IN_PROGRESS'|'UNKNOWN'>;
  complete(intentId: ID, resultDigest: string, metadata: Provenance): Promise<void>;
  fail(intentId: ID, code: string, uncertain: boolean): Promise<void>;
}
