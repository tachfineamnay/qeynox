import { createHash } from 'node:crypto';
import { DomainError,type ToolInvocationIntent } from '@qeynox/domain';
import type { ConnectorCall,PermissionContext,ToolLedgerPort,ToolResult } from './types';
import { ToolRegistry } from './registry';
import { ProviderRateLimiter } from './rate-limit';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keyOf=(c:ConnectorCall)=>c.connectorId+':'+c.toolName+'@'+c.version;
export class ToolBroker {
 constructor(private readonly registry:ToolRegistry,private readonly ledger:ToolLedgerPort,private readonly limiter:ProviderRateLimiter=new ProviderRateLimiter()){}
 async invoke(call:ConnectorCall,permission:PermissionContext):Promise<ToolResult>{
   if(!permission.principal.userId||!permission.principal.workspaceId)throw new DomainError('DENIED','Authenticated workspace required');
   if(permission.operationId!==call.operationId||permission.stepAttemptId!==call.stepAttemptId||permission.planRevisionId!==call.planRevisionId||permission.capabilityId!==call.capabilityId)throw new DomainError('DENIED','Tool execution identity mismatch');
   if(!permission.profileId||!Number.isInteger(permission.profileVersion)||permission.profileVersion<1)throw new DomainError('DENIED','Profile identity missing');
   const {connector,definition}=this.registry.lookup(call.connectorId,call.toolName,call.version);
   if(!permission.allowedConnectorTools.includes(keyOf(call))||!definition.allowedCapabilities.includes(call.capabilityId))throw new DomainError('DENIED','Tool outside profile/capability allowlist');
   if(definition.requiredScopes.some(scope=>!permission.consentScopes.includes(scope)))throw new DomainError('DENIED','Missing consent for tool');
   if(permission.remainingToolCalls<1||permission.remainingCostUnits<definition.maxCostUnits)throw new DomainError('DENIED','Tool budget unavailable');
   const input=definition.input.parse(call.input);
   const hash=digest(input);
   if(definition.mode==='WRITE'){
     const approval=permission.approvedRequests.find(a=>a.id===call.approvalId&&a.intentId===call.intentId&&a.operationId===call.operationId&&a.planRevisionId===call.planRevisionId&&a.stepAttemptId===call.stepAttemptId&&a.workspaceId===permission.principal.workspaceId&&a.status==='APPROVED'&&a.expiresAt>new Date().toISOString());
     if(!approval)throw new DomainError('DENIED','Specific write intent not approved');
   }
   const manifest=this.registry.manifest(call.connectorId);
   await this.limiter.check(call.connectorId,manifest.rateLimit.maxPerMinute);
   const intent:ToolInvocationIntent={id:call.intentId,operationId:call.operationId,planRevisionId:call.planRevisionId,stepAttemptId:call.stepAttemptId,capabilityId:call.capabilityId,toolName:keyOf(call),toolVersion:call.version,payload:input,idempotencyKey:call.idempotencyKey,mode:definition.mode,approvalId:call.approvalId,requestedBy:permission.principal.userId,createdAt:new Date().toISOString()};
   const existing=await this.ledger.reserve({intent,workspaceId:permission.principal.workspaceId,connectorId:call.connectorId,requestDigest:hash,status:'STARTED',provider:connector.id,capturedAt:new Date().toISOString()});
   if(existing!=='RESERVED')throw new DomainError('CONFLICT','Existing invocation requires reconciliation');
   const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),definition.timeoutMs);
   try{
     const raw=await connector.invoke(call.toolName,call.version,input,{principal:permission.principal,operationId:call.operationId,stepAttemptId:call.stepAttemptId,signal:ac.signal});
     const value=definition.output.parse(raw.value);
     const responseDigest=digest(value);
     const provenance={provider:connector.id,retrievedAt:new Date().toISOString(),sourceUri:raw.sourceUri,publishedAt:raw.publishedAt,requestDigest:hash,responseDigest};
     await this.ledger.complete(call.intentId,responseDigest,provenance);
     return {value,provenance};
   }catch(error:unknown){
     await this.ledger.fail(call.intentId,error instanceof DomainError?error.code:'TOOL_EXECUTION_FAILED',definition.mode==='WRITE');
     throw error;
   }finally{clearTimeout(timer);}
 }
}

