import { DomainError } from '@qeynox/domain';
import type { ToolConnector, ToolDefinition, ToolContext } from './types';

// Generic, operator-configured connector. No invented supplier/search API endpoints.
// Endpoint paths and JSON schemas come from reviewed tool definitions; callers cannot supply arbitrary URLs.
export interface HttpJsonTool extends ToolDefinition { path: string; method: 'GET'|'POST' }
export class HttpJsonConnector implements ToolConnector {
  readonly version: string;
  constructor(readonly id: string, private readonly baseUrl: string | undefined, private readonly bearerToken: string | undefined, private readonly specs: readonly HttpJsonTool[], version='1') {
    this.version = version;
  }
  definitions(): readonly ToolDefinition[] { return this.specs; }
  async invoke(name: string, version: string, input: unknown, ctx: ToolContext): Promise<{value:unknown,sourceUri?:string}> {
    if (!this.baseUrl) throw new DomainError('NOT_CONFIGURED',this.id+' endpoint is missing');
    const spec=this.specs.find(x=>x.name===name && x.version===version);
    if (!spec) throw new DomainError('UNSUPPORTED','Tool definition does not exist');
    const base=new URL(this.baseUrl);
    // Additional network-level outbound deny rules are mandatory (DNS rebinding cannot be solved with URL checks).
    if (base.protocol!=='https:' || base.username || base.password || base.search || base.hash) throw new DomainError('DENIED','Connector must use a clean HTTPS endpoint');
    if (isPrivateHost(base.hostname)) throw new DomainError('DENIED','Private endpoint cannot be used as external connector');
    if (!spec.path.startsWith('/') || spec.path.startsWith('//') || spec.path.includes('..') || spec.path.includes('?') || spec.path.includes('#')) throw new DomainError('DENIED','Unsafe fixed connector path');
    const url=new URL(spec.path,base);
    if (url.origin!==base.origin) throw new DomainError('DENIED','Cross-origin tool request refused');
    const response=await fetch(url,{method:spec.method,signal:ctx.signal,redirect:'error',headers:{'accept':'application/json',...(spec.method==='POST'?{'content-type':'application/json'}:{}),...(this.bearerToken?{authorization:'Bearer '+this.bearerToken}:{})},...(spec.method==='POST'?{body:JSON.stringify(input)}:{})});
    if (!response.ok) throw new DomainError('INVALID_STATE',this.id+' returned HTTP '+response.status);
    const length=Number(response.headers.get('content-length')??0);
    if (length>2_000_000) throw new DomainError('INVALID_STATE','Provider response too large');
    const body=await response.text();
    if (body.length>2_000_000) throw new DomainError('INVALID_STATE','Provider response too large');
    return {value:JSON.parse(body),sourceUri:url.toString()};
  }
}
function isPrivateHost(host:string):boolean {
  const h=host.toLowerCase();
  return h==='localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h==='::1' || h==='0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^fc|^fd/.test(h) || h==='[::1]';
}
