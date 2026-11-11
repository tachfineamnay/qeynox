import { DomainError } from '@qeynox/domain';
import type { ToolDefinition,ToolConnector } from './types';

export interface ConnectorManifest {
 id:string;version:string;description:string;provider:string;
 regions:readonly string[];operations:readonly string[];
 credentialRef?:string;termsUrl?:string;licenseNotes:string;
 freshness:{ttlSeconds:number;publishedAtSource:'PROVIDER'|'UNKNOWN'};
 rateLimit:{maxPerMinute:number};mode:'READ_ONLY'|'SIDE_EFFECTS';
 tools:readonly {name:string;version:string}[];
}
export interface ConnectorBundle {manifest:ConnectorManifest;connector:ToolConnector}
export function validateBundle(bundle:ConnectorBundle):void{
 const {manifest,connector}=bundle;
 if(manifest.id!==connector.id||manifest.version!==connector.version)throw new DomainError('INVALID_INPUT','Connector manifest version mismatch');
 if(manifest.rateLimit.maxPerMinute<1||manifest.freshness.ttlSeconds<0)throw new DomainError('INVALID_INPUT','Invalid provider constraints');
 const declared=new Set(connector.definitions().map(d=>d.name+'@'+d.version));
 if(manifest.tools.some(t=>!declared.has(t.name+'@'+t.version)))throw new DomainError('INVALID_INPUT','Manifest references undefined tool');
 if(manifest.mode==='READ_ONLY'&&connector.definitions().some(d=>d.mode==='WRITE'))throw new DomainError('DENIED','Read-only provider cannot expose writes');
}
