import { createHash } from 'node:crypto';
import { DomainError,type ToolInvocationIntent } from '@qeynox/domain';
import type { ConnectorCall,PermissionContext,ToolLedgerPort,ToolResult,ToolSource } from './types';
import type { ToolAuthorizationPort } from './authorization';
import { ToolRegistry } from './registry';
import { ProviderRateLimiter } from './rate-limit';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keyOf=(c:ConnectorCall)=>c.connectorId+':'+c.toolName+'@'+c.version;
export class ToolBroker {
 constructor(private readonly registry:ToolRegistry,private readonly ledger:ToolLedgerPort,private readonly limiter:ProviderRateLimiter=new ProviderRateLimiter(),private readonly authorization?:ToolAuthorizationPort){}
 async invoke(call:ConnectorCall,permission:PermissionContext):Promise<ToolResult>{
   const dispatch={invoked:false};
   try{return await this.invokeOnce(call,permission,dispatch);}
   catch(error:unknown){
     if(!dispatch.invoked)throw new DomainError(error instanceof DomainError?error.code:'UNEXPECTED_EXECUTION_ERROR',error instanceof DomainError?error.message:'Tool failed before provider admission',{...(error instanceof DomainError?error.context:{}),toolInvocation:'NOT_STARTED'});
     throw error;
   }
 }
 private async invokeOnce(call:ConnectorCall,permission:PermissionContext,dispatch:{invoked:boolean}):Promise<ToolResult>{
   if(!permission.principal.userId||!permission.principal.workspaceId)throw new DomainError('DENIED','Authenticated workspace required');
   if(permission.operationId!==call.operationId||permission.stepAttemptId!==call.stepAttemptId||permission.planRevisionId!==call.planRevisionId||permission.capabilityId!==call.capabilityId)throw new DomainError('DENIED','Tool execution identity mismatch');
   if(!permission.profileId||!Number.isSafeInteger(permission.profileVersion)||permission.profileVersion<1)throw new DomainError('DENIED','Profile identity missing');
   const {connector,definition}=this.registry.lookup(call.connectorId,call.toolName,call.version);
   if(!permission.allowedConnectorTools.includes(keyOf(call))||!definition.allowedCapabilities.includes(call.capabilityId))throw new DomainError('DENIED','Tool outside profile/capability allowlist');
   if(definition.requiredScopes.some(scope=>!permission.consentScopes.includes(scope)))throw new DomainError('DENIED','Missing consent for tool');
   if(!Number.isSafeInteger(permission.remainingToolCalls)||permission.remainingToolCalls<1||!Number.isSafeInteger(permission.remainingCostUnits)||permission.remainingCostUnits<0||permission.remainingCostUnits<definition.maxCostUnits||(definition.requiresPositiveCostCeiling&&permission.remainingCostUnits===0))throw new DomainError('DENIED','Tool budget unavailable');
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
   if(existing!=='RESERVED')throw new DomainError('CONFLICT','Existing invocation requires reconciliation',{toolInvocation:'NOT_STARTED'});
   const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),definition.timeoutMs);
   let invoked=false;
   try{
     // Bound authority waits and invocation even if an adapter ignores AbortSignal. A late result
     // can never reach output validation/ledger completion or become a source after this deadline.
     let abort: (()=>void)|undefined;
     const deadline=new Promise<never>((_,reject)=>{
       abort=()=>reject(new DomainError('UNAVAILABLE','Tool deadline exceeded',{providerFailure:'TIMEOUT'}));
       if(ac.signal.aborted)abort();else ac.signal.addEventListener('abort',abort,{once:true});
     });
     const work=async()=>{
       await this.authorization?.assertCurrent(call,permission,definition);
       if(ac.signal.aborted)throw new DomainError('UNAVAILABLE','Tool deadline exceeded',{providerFailure:'TIMEOUT'});
       invoked=true;dispatch.invoked=true;
       return connector.invoke(call.toolName,call.version,input,{principal:permission.principal,operationId:call.operationId,stepAttemptId:call.stepAttemptId,signal:ac.signal});
     };
     let raw:Awaited<ReturnType<typeof connector.invoke>>;
     try{raw=await Promise.race([work(),deadline]);}
     finally{if(abort)ac.signal.removeEventListener('abort',abort);}
     const value=definition.output.parse(raw.value);
     const responseDigest=digest(value);
     const declaredSources:readonly ToolSource[]=raw.sources??(raw.sourceUri?[{uri:raw.sourceUri,title:call.toolName}]:[]);
     const sources=[...new Map(declaredSources.map(source=>[source.uri,source])).values()];
     if(declaredSources.length>20||sources.some(source=>!safeSource(source.uri)||typeof source.title!=='string'||source.title.length>500)||raw.sourceUri&&!safeSource(raw.sourceUri))throw new DomainError('INVALID_STATE','Invalid provider source metadata');
     if(raw.rawResponseDigest!==undefined&&!/^[a-f0-9]{64}$/.test(raw.rawResponseDigest))throw new DomainError('INVALID_STATE','Invalid provider response digest');
     if(raw.retrievedAt!==undefined&&(!Number.isFinite(Date.parse(raw.retrievedAt))||Date.parse(raw.retrievedAt)>Date.now()+60000))throw new DomainError('INVALID_STATE','Invalid provider retrieval time');
     const provenance={provider:connector.id,retrievedAt:raw.retrievedAt??new Date().toISOString(),sourceUri:raw.sourceUri,publishedAt:raw.publishedAt,requestDigest:hash,responseDigest,rawResponseDigest:raw.rawResponseDigest,freshnessTtlSeconds:manifest.freshness.ttlSeconds,notes:connector.id==='brave-search'?'Search discovery snippets only; target pages were not fetched. Digests bind the provider response, not individual page contents.':undefined};
     await this.ledger.complete(call.intentId,responseDigest,provenance);
     return {value,provenance,sources};
   }catch(error:unknown){
     try {
       await this.ledger.fail(call.intentId,error instanceof DomainError?error.code:'TOOL_EXECUTION_FAILED',invoked&&definition.mode==='WRITE');
     } catch(recordingError:unknown) {
       if(invoked&&definition.mode==='WRITE')throw new DomainError('UNKNOWN_OUTCOME','External write and its ledger acknowledgement require reconciliation');
       throw recordingError;
     }
     if(invoked&&definition.mode==='WRITE')throw new DomainError('UNKNOWN_OUTCOME','External write may have started; reconcile its outcome before any retry');
     if(!invoked&&error instanceof DomainError)throw new DomainError(error.code,error.message,{...error.context,toolInvocation:'NOT_STARTED'});
     throw error;
   }finally{clearTimeout(timer);}
 }
}


function safeSource(value:string):boolean {
 try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}
