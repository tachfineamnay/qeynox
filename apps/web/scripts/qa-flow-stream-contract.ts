import assert from 'node:assert/strict';
import { flowWireSchema,parseFlowCursor } from '../src/lib/flow-stream-contract';

assert.equal(parseFlowCursor(null),0);
assert.equal(parseFlowCursor('42'),42);
for(const value of ['','-1','01','1.5','9007199254740992','1\n'])assert.equal(parseFlowCursor(value),null);
const event={type:'CUSTOM',name:'qeynox.flow.event.v1',value:{operationId:'op',event:{id:'id',eventId:'event',sequence:1,kind:'CREATED',occurredAt:'2026-11-17T00:00:00.000Z'}}};
assert(flowWireSchema.safeParse(event).success);
assert(!flowWireSchema.safeParse({...event,value:{...event.value,event:{...event.value.event,data:{secret:'private'}}}}).success);
assert(!flowWireSchema.safeParse({...event,name:'qeynox.flow.event.v2'}).success);
console.log('Flow stream contract QA PASSED');
