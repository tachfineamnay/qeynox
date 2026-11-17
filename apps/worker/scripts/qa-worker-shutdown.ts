import assert from 'node:assert/strict';
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { startQeyNoxWorker } from '@qeynox/orchestration';

const original=HatchetClient.init;
const previous=process.env.HATCHET_CLIENT_TOKEN;
let finish!:()=>void,started!:()=>void;
const running=new Promise<void>(resolve=>{finish=resolve;});
const ready=new Promise<void>(resolve=>{started=resolve;});
let stopCount=0,completed=false,options:Record<string,unknown>={};
const worker={start:async()=>{started();await running;completed=true;},stop:async()=>{stopCount++;await running;}};
(HatchetClient as unknown as {init:unknown}).init=()=>({task:()=>({}),worker:async(_name:string,opts:Record<string,unknown>)=>{options=opts;return worker;}});
process.env.HATCHET_CLIENT_TOKEN='qa-offline-only';
try {
 const signal=new AbortController();
 const run=startQeyNoxWorker({handler:async()=>({outcome:'COMPLETED'}),startDispatcher:async()=>{}},signal.signal);
 await ready;signal.abort();await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(options.handleKill,false);assert.equal(stopCount,1);assert.equal(completed,false,'active task still draining');
 finish();await run;assert.equal(completed,true);assert.equal(stopCount,1);
 console.log('Worker shutdown QA PASSED: stop waits for in-flight work (offline SDK adapter)');
} finally {
 (HatchetClient as unknown as {init:unknown}).init=original;
 if(previous===undefined)delete process.env.HATCHET_CLIENT_TOKEN;else process.env.HATCHET_CLIENT_TOKEN=previous;
}
