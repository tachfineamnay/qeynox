import { DomainError } from '@qeynox/domain';
import type { ToolConnector, ToolDefinition } from './types';

export class ToolRegistry {
  private readonly connectors = new Map<string, ToolConnector>();
  private readonly definitions = new Map<string, ToolDefinition>();
  register(connector: ToolConnector): void {
    if (this.connectors.has(connector.id)) throw new DomainError('CONFLICT','Connector already registered: '+connector.id);
    const defs = connector.definitions();
    if (!defs.length) throw new DomainError('INVALID_INPUT','Connector without tools');
    for (const definition of defs) {
      const key = this.key(connector.id,definition.name,definition.version);
      if (this.definitions.has(key)) throw new DomainError('CONFLICT','Duplicate tool definition');
      if (definition.timeoutMs < 100 || definition.maxCostUnits < 0) throw new DomainError('INVALID_INPUT','Invalid tool constraints');
      this.definitions.set(key,definition);
    }
    this.connectors.set(connector.id,connector);
  }
  lookup(connectorId:string,name:string,version:string): {connector:ToolConnector,definition:ToolDefinition} {
    const connector=this.connectors.get(connectorId),definition=this.definitions.get(this.key(connectorId,name,version));
    if (!connector || !definition || connector.version !== version) throw new DomainError('NOT_CONFIGURED','Tool is not registered');
    return {connector,definition};
  }
  available(): readonly string[] {return [...this.definitions.keys()];}
  private key(c:string,n:string,v:string) {return c+':'+n+'@'+v;}
}
