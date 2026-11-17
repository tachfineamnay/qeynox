import { flowWireSchema } from './flow-stream-contract';

export type FlowLiveState={cursor:number;seen:Set<string>};
export function acceptFlowEvent(state:FlowLiveState,operationId:string,data:string,lastEventId:string):'new'|'duplicate'|'invalid'{
 let raw:unknown;try{raw=JSON.parse(data);}catch{return 'invalid';}
 const parsed=flowWireSchema.safeParse(raw);
 if(!parsed.success||parsed.data.name!=='qeynox.flow.event.v1'||parsed.data.value.operationId!==operationId)return 'invalid';
 const event=parsed.data.value.event;
 if(String(event.sequence)!==lastEventId)return 'invalid';
 if(event.sequence<=state.cursor)return 'duplicate';
 if(event.sequence!==state.cursor+1||state.seen.has(event.eventId))return 'invalid';
 state.cursor=event.sequence;state.seen.add(event.eventId);
 if(state.seen.size>10000)state.seen.delete(state.seen.values().next().value!);
 return 'new';
}
