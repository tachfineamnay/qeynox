import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { connectDatabase,QeyNoxStore,runMigrations } from '@qeynox/persistence';
import { projectOnce } from '../../worker/src/runtime';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

const qa=await createIsolatedQaDatabase();const conn=connectDatabase(qa.url);let child:ChildProcess|undefined;
let app:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
try {
 await runMigrations(qa.url);process.env.DATABASE_URL=qa.url;process.env.QEYNOX_ALLOW_REGISTRATION='true';
 app=await NestFactory.create(AppModule,{logger:false});app.useGlobalFilters(new DomainExceptionFilter());await app.listen(0,'127.0.0.1');
 const base='http://127.0.0.1:'+(app.getHttpServer().address() as {port:number}).port;
 const post=async(path:string,body:unknown,token?:string)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 const one=await post('/v1/auth/register',{email:'sse-one@example.invalid',password:'qa-passphrase-for-testing',workspaceName:'SSE QA'});
 const two=await post('/v1/auth/register',{email:'sse-two@example.invalid',password:'qa-passphrase-for-testing',workspaceName:'SSE Other'});
 assert.equal(one.status,201);assert.equal(two.status,201);
 const op=await post('/v1/operations',{title:'SSE QA',goal:'Test projected event stream',constraints:[]},one.body.token);assert.equal(op.status,201);
 assert.equal(await projectOnce(conn.db),op.body.id);
 const webDir=fileURLToPath(new URL('../../web/',import.meta.url));
 child=spawn(process.execPath,[fileURLToPath(new URL('../../web/node_modules/next/dist/bin/next',import.meta.url)),'start','-p','3340'],{cwd:webDir,env:{...process.env,QEYNOX_API_URL:base},stdio:'inherit'});
 const url='http://127.0.0.1:3340/api/flow/operations/'+op.body.id+'/stream';
 for(let i=0;i<180;i++){if(child.exitCode!==null)throw new Error('Next QA process exited');try{await fetch(url);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const cookie=(v:any)=>'qx-session='+encodeURIComponent(JSON.stringify({token:v.token,workspaceId:v.workspaceId,expiresAt:v.expiresAt}));
 assert.equal((await fetch(url)).status,403);
 assert.equal((await fetch(url,{headers:{cookie:cookie(two.body)}})).status,403);
 const controller=new AbortController();
 const response=await fetch(url,{headers:{cookie:cookie(one.body)},signal:controller.signal});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/^text\/event-stream/);
 const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';
 const nextEvent=async()=>{for(;;){const part=await reader.read();if(part.done)throw new Error('stream ended');buffer+=decoder.decode(part.value,{stream:true});let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.includes('data: '))return frame;}}};
 const first=await nextEvent();assert(first.includes('id: 1'));assert(!first.includes(one.body.token));
 const firstData=JSON.parse(first.split('\n').find(x=>x.startsWith('data: '))!.slice(6));assert.equal(firstData.type,'CUSTOM');assert.equal(firstData.name,'qeynox.flow.event.v1');assert.deepEqual(Object.keys(firstData.value.event).sort(),['eventId','id','kind','occurredAt','sequence']);
 await new QeyNoxStore(conn.db).writeEvent({workspaceId:one.body.workspaceId,operationId:op.body.id,kind:'QA_SSE_NEXT',data:{secret:'hidden'},occurredAt:new Date().toISOString()});
 assert.equal(await projectOnce(conn.db),op.body.id);
 const second=await nextEvent();assert(second.includes('id: 2'));assert(!second.includes('hidden'));assert(!second.includes(one.body.token));
 controller.abort();await reader.cancel().catch(()=>{});
 const replayController=new AbortController();const replay=await fetch(url,{headers:{cookie:cookie(one.body),'last-event-id':'1'},signal:replayController.signal});
 assert.equal(replay.status,200);const replayReader=replay.body!.getReader();const replayChunk=await replayReader.read();assert(decoder.decode(replayChunk.value).includes('id: 2'));replayController.abort();await replayReader.cancel().catch(()=>{});
 const revocationController=new AbortController();const live=await fetch(url+'?after=2',{headers:{cookie:cookie(one.body)},signal:revocationController.signal});assert.equal(live.status,200);
 const liveReader=live.body!.getReader();await liveReader.read();
 const logout=await post('/v1/auth/logout',{},one.body.token);assert.equal(logout.status,201);
 let control='';for(let i=0;i<4&&!control.includes('SESSION_ENDED');i++){const part=await liveReader.read();if(part.done)break;control+=decoder.decode(part.value);}
 assert(control.includes('SESSION_ENDED'));assert(!control.includes(one.body.token));revocationController.abort();await liveReader.cancel().catch(()=>{});
 assert.equal((await fetch(url,{headers:{cookie:cookie(one.body)}})).status,403);
 console.log('SSE HTTP QA PASSED: auth, workspace, real projection, replay and secret exclusion');
} finally {child?.kill();await app?.close();await conn.close();await qa.drop();}
