import { DomainError } from '@qeynox/domain';
import type { ToolConnector,ToolDefinition,ToolContext } from './types';
export interface HttpJsonTool extends ToolDefinition {path:string;method:'GET'|'POST'}
// Disabled until a pinned network transport can guarantee vetted egress and DNS resolution.
// A URL regex is NOT enough to prevent SSRF or DNS rebinding.
export class HttpJsonConnector implements ToolConnector {
 readonly version:string;
 constructor(readonly id:string,private readonly baseUrl:string|undefined,private readonly bearerToken:string|undefined,private readonly specs:readonly HttpJsonTool[],version='1'){this.version=version;}
 definitions():readonly ToolDefinition[]{return this.specs;}
 async invoke(_name:string,_version:string,_input:unknown,_ctx:ToolContext):Promise<never>{
  throw new DomainError('NOT_CONFIGURED','Generic HTTP connector needs operator-vetted network transport, domain allowlist and verified DNS/IP pinning');
 }
}
