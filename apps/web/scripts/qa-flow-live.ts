import assert from 'node:assert/strict';
import { acceptFlowEvent } from '../src/lib/flow-live';
const state={cursor:5,seen:new Set<string>()};
const event={type:'CUSTOM',name:'qeynox.flow.event.v1',value:{operationId:'operation_qa',event:{id:'envelope_6',eventId:'event_6',sequence:6,kind:'STEP_STARTED',occurredAt:'2026-11-17T00:00:00.000Z'}}};
assert.equal(acceptFlowEvent(state,'operation_qa',JSON.stringify(event),'6'),'new');
assert.equal(acceptFlowEvent(state,'operation_qa',JSON.stringify(event),'6'),'duplicate');
assert.equal(acceptFlowEvent(state,'other',JSON.stringify(event),'6'),'invalid');
assert.equal(acceptFlowEvent(state,'operation_qa',JSON.stringify({...event,value:{...event.value,event:{...event.value.event,sequence:8}}}),'8'),'invalid');
console.log('Flow live event QA PASSED');
