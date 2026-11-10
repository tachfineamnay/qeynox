import { DomainError } from '@qeynox/domain';
import type { EnginePort, EngineRequest, EngineOutcome, ProposedToolAction } from './types';

export interface HermesConfig {
  baseUrl: string | undefined; apiKey: string | undefined; model: string;
  timeoutMs: number; nativeToolsIsolated: boolean;
}
interface CompletionResponse {
  id?: string; choices?: Array<{message?:{content?:string|null};finish_reason?:string|null}>;
  usage?: {prompt_tokens?:number;completion_tokens?:number;total_tokens?:number};
}
export class HermesAdapter implements EnginePort {
  constructor(private readonly config:HermesConfig) {}
  async invoke(request:EngineRequest, options?:{signal?:AbortSignal}):Promise<EngineOutcome> {
    // The Hermes API server normally has its own tools. No request-time system prompt
    // can enforce ToolBroker. Deployment MUST disable/contain unmanaged tools and egress.
    if (!this.config.nativeToolsIsolated) throw new DomainError('NOT_CONFIGURED','Hermes unmanaged native tools must be isolated before tenant execution');
    if (!this.config.baseUrl || !this.config.apiKey) throw new DomainError('NOT_CONFIGURED','Hermes endpoint and API key are required');
    const base = new URL(this.config.baseUrl);
    if (base.username || base.password || base.search || base.hash || !(['http:','https:'].includes(base.protocol))) throw new DomainError('INVALID_INPUT','Invalid Hermes base URL');
    if (base.protocol === 'http:' && !['localhost','127.0.0.1','hermes','hermes-gateway'].includes(base.hostname)) throw new DomainError('DENIED','Plain HTTP is allowed only on an explicitly private runtime hostname');
    const url = new URL('chat/completions',base.href.endsWith('/')?base.href:base.href+'/');
    const ac=new AbortController();
    const onAbort=()=>ac.abort();
    options?.signal?.addEventListener('abort',onAbort,{once:true});
    const timeout=setTimeout(()=>ac.abort(),this.config.timeoutMs);
    try {
      const safeContext = Object.fromEntries(Object.entries(request.context).filter(([k])=>request.profile.permittedContextKeys.includes(k)));
      const systemInstructions = [
        request.profile.systemInstructions,
        'You may propose external tool requests only as JSON objects; never claim to have invoked one.',
        'All external tools are provided by QeyNox after policy review. Never use terminal, filesystem, browser or built-in tools.',
        'Business research must clearly separate verified evidence from uncertainty. Do not invent suppliers, citations or prices.',
        'Allowed QeyNox broker tool names: '+request.profile.allowedTools.join(', '),
      ].join('\n');
      const messages = [
        {role:'system',content:systemInstructions},
        ...((request.priorMessages??[]).slice(-20)),
        {role:'user',content:JSON.stringify({task:request.userMessage,context:safeContext,correlationId:request.correlationId})},
      ];
      const response=await fetch(url,{
        method:'POST',signal:ac.signal,
        headers:{'content-type':'application/json','authorization':'Bearer '+this.config.apiKey},
        body:JSON.stringify({model:this.config.model,messages,stream:false,max_tokens:Math.min(8192,request.profile.maxOutputTokens)}),
        redirect:'error',
      });
      if (!response.ok) throw new DomainError('INVALID_STATE','Hermes endpoint returned HTTP '+response.status);
      const wire=await response.json() as CompletionResponse;
      const choice=wire.choices?.[0];
      if (!choice || typeof choice.message?.content!=='string') throw new DomainError('INVALID_STATE','Hermes returned no text content');
      const {content,proposedTools}=parseProposals(choice.message.content);
      const reason=choice.finish_reason??undefined;
      return {
        status:reason==='length'?'INCOMPLETE':reason==='stop'?'COMPLETED':'INCOMPLETE',
        engine:'hermes',engineRunId:wire.id,content,proposedTools,
        usage:wire.usage?{inputTokens:wire.usage.prompt_tokens,outputTokens:wire.usage.completion_tokens,totalTokens:wire.usage.total_tokens}:undefined,
        reason,receivedAt:new Date().toISOString(),
      };
    } catch(error:unknown) {
      if (ac.signal.aborted) throw new DomainError('INVALID_STATE','Hermes request interrupted or timed out; server-side cancellation is unconfirmed');
      throw error;
    } finally {
      clearTimeout(timeout);options?.signal?.removeEventListener('abort',onAbort);
    }
  }
}
function parseProposals(body:string):{content:string;proposedTools:ProposedToolAction[]} {
  try {
    const json=JSON.parse(body) as Record<string,unknown>;
    if (!json || json.kind!=='tool_proposals' || !Array.isArray(json.actions)) return {content:body,proposedTools:[]};
    const proposals:ProposedToolAction[]=[];
    for (const value of json.actions.slice(0,20)) {
      if (!value || typeof value!=='object') continue;
      const a=value as Record<string,unknown>;
      if (typeof a.connectorId==='string' && typeof a.toolName==='string' && typeof a.version==='string' && typeof a.reason==='string') {
        proposals.push({connectorId:a.connectorId,toolName:a.toolName,version:a.version,reason:a.reason,input:a.input});
      }
    }
    return {content:typeof json.summary==='string'?json.summary:'Tool proposals awaiting QeyNox authorization',proposedTools:proposals};
  } catch {return {content:body,proposedTools:[]};}
}
