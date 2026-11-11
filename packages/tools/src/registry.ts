import { DomainError } from '@qeynox/domain';
import type { ToolConnector,ToolDefinition } from './types';
import type { ConnectorBundle,ConnectorManifest } from './manifest';
import { validateBundle } from './manifest';
export class ToolRegistry {
 private readonly connectors=new Map<string,ToolConnector>();
 private readonly definitions=new Map<string,ToolDefinition>();
 private readonly manifests=new Map<string,ConnectorManifest>();
 register(connector:ToolConnector):void{
  if(this.connectors.has(connector.id))throw new DomainError('CONFLICT','Connector already registered');
  const defs=connector.definitions();
  if(!defs.length)throw new DomainError('INVALID_INPUT','Connector has no tools');
  for(const d of defs){const k=this.key(connector.id,d.name,d.version);if(this.definitions.has(k))throw new DomainError('CONFLICT','Duplicate tool');if(d.timeoutMs<100||d.maxCostUnits<0)throw new DomainError('INVALID_INPUT','Invalid tool limits');this.definitions.set(k,d);}
  this.connectors.set(connector.id,connector);
 }
 registerBundle(bundle:ConnectorBundle):void {validateBundle(bundle);this.register(bundle.connector);this.manifests.set(bundle.manifest.id,bundle.manifest);}
 lookup(id:string,name:string,version:string):{connector:ToolConnector;definition:ToolDefinition}{
  const connector=this.connectors.get(id),def=this.definitions.get(this.key(id,name,version));
  if(!connector||!def||connector.version!==version)throw new DomainError('NOT_CONFIGURED','Tool unavailable');
  return {connector,definition:def};
 }
 manifest(id:string):ConnectorManifest{const m=this.manifests.get(id);if(!m)throw new DomainError('NOT_CONFIGURED','Provider manifest unavailable');return m;}
 available():readonly string[]{return [...this.definitions.keys()];}
 private key(c:string,n:string,v:string){return c+':'+n+'@'+v;}
}
