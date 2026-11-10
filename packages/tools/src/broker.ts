import { createHash } from 'node:crypto';
import { DomainError, type ID, type ToolInvocationIntent } from '@qeynox/domain';
import type { ConnectorCall, PermissionContext, ToolLedgerPort, ToolResult } from './types';
import { ToolRegistry } from './registry';

const digest = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keyOf = (input: ConnectorCall) => input.connectorId+':'+input.toolName+'@'+input.version;

export class ToolBroker {
  constructor(private readonly registry: ToolRegistry, private readonly ledger: ToolLedgerPort) {}

  async invoke(call: ConnectorCall, permission: PermissionContext): Promise<ToolResult> {
    if (permission.principal.workspaceId === undefined || !permission.principal.userId) throw new DomainError('DENIED','Authenticated principal required');
    if (permission.capabilityId !== call.capabilityId) throw new DomainError('DENIED','Capability mismatch');
    const { connector, definition } = this.registry.lookup(call.connectorId,call.toolName,call.version);
    if (!permission.allowedConnectorTools.includes(keyOf(call)) || !definition.allowedCapabilities.includes(call.capabilityId)) throw new DomainError('DENIED','Tool not allowed for capability');
    if (definition.requiredScopes.some(scope=>!permission.consentScopes.includes(scope))) throw new DomainError('DENIED','Consent scope not granted');
    if (permission.remainingToolCalls < 1 || permission.remainingCostUnits < definition.maxCostUnits) throw new DomainError('DENIED','Tool budget exhausted');
    if (definition.mode === 'WRITE') {
      const approval = permission.approvedRequests.find(a=>a.id===call.approvalId && a.operationId===call.operationId && a.stepAttemptId===call.stepAttemptId && a.planRevisionId===call.planRevisionId && a.workspaceId===permission.principal.workspaceId && a.status==='APPROVED' && a.expiresAt > new Date().toISOString());
      if (!approval) throw new DomainError('DENIED','External side effect requires specific approval');
    }
    const validatedInput = definition.input.parse(call.input);
    const requestDigest = digest(validatedInput);
    const intent: ToolInvocationIntent = {
      id:call.intentId,operationId:call.operationId,planRevisionId:call.planRevisionId,stepAttemptId:call.stepAttemptId,
      capabilityId:call.capabilityId,toolName:keyOf(call),toolVersion:call.version,payload:validatedInput,
      idempotencyKey:call.idempotencyKey,mode:definition.mode,approvalId:call.approvalId,requestedBy:permission.principal.userId,createdAt:new Date().toISOString(),
    };
    const state = await this.ledger.reserve({intent,workspaceId:permission.principal.workspaceId,connectorId:call.connectorId,requestDigest,status:'STARTED',provider:connector.id,capturedAt:new Date().toISOString()});
    if (state === 'IN_PROGRESS' || state === 'ALREADY_COMPLETED' || state === 'UNKNOWN') throw new DomainError('CONFLICT','Invocation has a previous attempt; reconcile rather than duplicate');
    const ac = new AbortController();
    const timer = setTimeout(()=>ac.abort(),definition.timeoutMs);
    try {
      const raw = await connector.invoke(call.toolName,call.version,validatedInput,{principal:permission.principal,operationId:call.operationId,stepAttemptId:call.stepAttemptId,signal:ac.signal});
      const value = definition.output.parse(raw.value);
      const responseDigest = digest(value);
      const provenance = { provider:connector.id,retrievedAt:new Date().toISOString(),sourceUri:raw.sourceUri,publishedAt:raw.publishedAt,requestDigest,responseDigest };
      await this.ledger.complete(call.intentId,responseDigest,provenance);
      return {value,provenance};
    } catch (error:unknown) {
      // A timed-out write may have reached the provider: do NOT retry automatically.
      const code=error instanceof DomainError?error.code:'TOOL_EXECUTION_FAILED';
      const uncertain=definition.mode==='WRITE';
      await this.ledger.fail(call.intentId,code,uncertain);
      throw error;
    } finally {clearTimeout(timer);}
  }
}
