import { DomainError, type CapabilityDefinition, type CapabilitySlot, type ID } from '@qeynox/domain';

const slots = [1,2,3,4,5,6,7,8] as const;
export class CapabilityRegistry {
  private readonly active = new Map<CapabilitySlot,CapabilityDefinition>();
  constructor(definitions:readonly CapabilityDefinition[]) {
    for (const definition of definitions) {
      if (!slots.includes(definition.slot)) throw new DomainError('INVALID_INPUT','Capability slot outside 1..8');
      if (definition.status!=='ACTIVE') continue;
      const prior=this.active.get(definition.slot);
      if (prior && prior.version>=definition.version) continue;
      if (!definition.name || !definition.purpose || definition.maximumSteps<1 || definition.maximumToolCalls<0)
        throw new DomainError('INVALID_INPUT','Active capability is incomplete');
      this.active.set(definition.slot,definition);
    }
  }
  list(): readonly {slot:CapabilitySlot; status:'ACTIVE'|'UNCONFIGURED'; definition?:CapabilityDefinition}[] {
    return slots.map(slot=>this.active.has(slot)?{slot,status:'ACTIVE' as const,definition:this.active.get(slot)}:{slot,status:'UNCONFIGURED' as const});
  }
  get(id:ID):CapabilityDefinition {
    const selected=[...this.active.values()].find(c=>c.id===id);
    if (!selected) throw new DomainError('NOT_CONFIGURED','Business capability is not active');
    return selected;
  }
  canUseTool(id:ID,tool:string):boolean {return this.get(id).allowedTools.includes(tool);}
}
