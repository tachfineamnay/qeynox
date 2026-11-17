import assert from 'node:assert/strict';
import { connectDatabase,QeyNoxStore,runMigrations } from '@qeynox/persistence';
import { OperationReadModels } from '@qeynox/application';
import type { ID,Principal } from '@qeynox/domain';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';
import { projectOnce,startProjectionPolling } from '../src/runtime';
import { randomUUID } from 'node:crypto';
import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const qa=await createIsolatedQaDatabase();
let conn:ReturnType<typeof connectDatabase>|undefined,reader:ReturnType<typeof connectDatabase>|undefined;
try {
 await runMigrations(qa.url);
 conn=connectDatabase(qa.url);
 const store=new QeyNoxStore(conn.db);
 const actor:Principal={userId:'qa-user' as ID,workspaceId:'qa-workspace' as ID,roles:['OWNER']};
 const op=await store.createOperation(actor,'Projection QA','Read-only GET verification',[]);
 await assert.rejects(()=>new OperationReadModels(store).summary(actor,op.id),/Projection not available/);
 assert.equal(await projectOnce(conn.db),op.id,'worker projects without a GET');
 const readUrl=new URL(qa.url);readUrl.searchParams.set('options','-c default_transaction_read_only=on');
 reader=connectDatabase(readUrl.toString());
 const reads=new OperationReadModels(new QeyNoxStore(reader.db));
 await assert.doesNotReject(()=>reads.activity(actor,op.id),'activity must execute in a read-only database session');
 await assert.doesNotReject(()=>reads.summary(actor,op.id));
 await assert.doesNotReject(()=>reads.recent(actor));
 const outsider:Principal={...actor,workspaceId:'other-workspace' as ID};
 await assert.rejects(()=>reads.activity(outsider,op.id),/not found/i);
 await assert.rejects(()=>reads.summary(outsider,op.id),/not found/i);
 assert.deepEqual(await reads.recent(outsider),[]);
 const now=new Date().toISOString();
 await store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_ADDED',data:{},occurredAt:now});
 assert.equal((await reads.activity(actor,op.id)).events.length,1,'GET must not project new event');
 const concurrent=await Promise.all([projectOnce(conn.db),projectOnce(conn.db)]);
 assert.equal(concurrent.filter(Boolean).length,1,'one worker acquires the operation');
 let page=await reads.activity(actor,op.id);
 assert.deepEqual(page.events.map(e=>e.sequence),[1,2]);
 const original=JSON.stringify(page);
 await conn.pool.query('UPDATE projection_work SET dirty=true WHERE operation_id=$1',[op.id]);
 assert.equal(await projectOnce(conn.db),op.id);
 assert.equal(JSON.stringify(await reads.activity(actor,op.id)),original,'replay preserves published cursors');
 await conn.pool.query('UPDATE operation_event_envelopes SET sequence=99 WHERE operation_id=$1 AND sequence=2',[op.id]);
 await conn.pool.query('UPDATE projection_work SET dirty=true WHERE operation_id=$1',[op.id]);
 await assert.rejects(()=>projectOnce(conn!.db),/Projection failed/,'projection fails closed on corrupt envelope');
 assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,true,'failed projection retains dirty state');
 assert.equal((await conn.pool.query('SELECT last_sequence FROM projection_cursors WHERE operation_id=$1',[op.id])).rows[0].last_sequence,2,'failed projection rolls cursor back');
 await conn.pool.query('UPDATE operation_event_envelopes SET sequence=2 WHERE operation_id=$1 AND sequence=99',[op.id]);
 await projectOnce(conn.db);
 let releaseProjection!:()=>void,signalLocked!:()=>void;
 const locked=new Promise<void>(resolve=>{signalLocked=resolve;});
 const release=new Promise<void>(resolve=>{releaseProjection=resolve;});
 const inFlight=conn.db.transaction(async tx=>{
  await new OperationReadModels(store).projectInTransaction(tx,actor.workspaceId,op.id);
  signalLocked();await release;
 });
 await locked;
 let writerFinished=false;
 const waitingWriter=store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_WAKEUP_RACE',data:{},occurredAt:now}).then(()=>{writerFinished=true;});
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(writerFinished,false,'writer waits for projection lock');
 releaseProjection();await inFlight;await waitingWriter;
 assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,true,'writer re-marks dirty after projector commits');
 await projectOnce(conn.db);
 assert((await reads.activity(actor,op.id)).events.some(e=>e.kind==='QA_WAKEUP_RACE'));
 await store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_ABORTED_PROJECTION',data:{},occurredAt:now});
 await assert.rejects(()=>conn!.db.transaction(async tx=>{
  await new OperationReadModels(store).projectInTransaction(tx,actor.workspaceId,op.id);
  throw new Error('simulated worker interruption');
 }),/simulated worker interruption/);
 assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,true);
 assert.equal((await conn.pool.query("SELECT count(*)::int AS n FROM operation_event_envelopes WHERE kind='QA_ABORTED_PROJECTION' AND operation_id=$1",[op.id])).rows[0].n,0);
 await projectOnce(conn.db);
 const c=await conn.pool.connect();
 try {
  await c.query('BEGIN');
  await c.query("UPDATE operations SET status='READY' WHERE id=$1",[op.id]);
  await c.query('ROLLBACK');
 } finally {c.release();}
 assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,false,'rollback keeps work clean');
 const beforeCount=(await reads.summary(actor,op.id)).evidenceCount;
 await conn.pool.query("INSERT INTO claims(id,workspace_id,operation_id,attempt_id,statement,kind,status,created_at) VALUES($1,$2,$3,'qa-attempt','qa','QA','UNVERIFIED',$4)",[randomUUID(),actor.workspaceId,op.id,now]);
 assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,true,'claim without event marks work dirty');
 assert.equal(await projectOnce(conn.db),op.id);
 assert.equal((await reads.summary(actor,op.id)).evidenceCount,beforeCount+1);
 const a=await conn.pool.connect(),b=await conn.pool.connect();
 try {
  await a.query('BEGIN');await b.query('BEGIN');
  const makeEvent=(id:string,kind:string)=>({id,workspaceId:actor.workspaceId,operationId:op.id,kind,occurredAt:now,data:{},eventVersion:1});
  const first=makeEvent(randomUUID(),'QA_FIRST'),second=makeEvent(randomUUID(),'QA_SECOND');
  const insert='INSERT INTO operation_events(id,workspace_id,operation_id,kind,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6)';
  await a.query(insert,[first.id,actor.workspaceId,op.id,first.kind,now,first]);
  let secondDone=false;
  const inserting=b.query(insert,[second.id,actor.workspaceId,op.id,second.kind,now,second]).then(()=>{secondDone=true;});
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(secondDone,false,'later writer waits for earlier transaction');
  await a.query('COMMIT');await inserting;await b.query('COMMIT');
  await projectOnce(conn.db);
  page=await reads.activity(actor,op.id);
  assert.deepEqual(page.events.slice(-2).map(e=>e.kind),['QA_FIRST','QA_SECOND']);
 } finally {a.release();b.release();}
 await store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_RESTART',data:{},occurredAt:now});
 const stop=startProjectionPolling(conn.db,30);
 for(let i=0;i<100;i++){
  if(!(await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty)break;
  await new Promise(resolve=>setTimeout(resolve,30));
 }
 await stop();
 assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,false,'restart catches up');
 assert((await reads.activity(actor,op.id)).events.some(e=>e.kind==='QA_RESTART'));
 let child:ChildProcess|undefined;
 const waitClean=async()=>{
  for(let i=0;i<300;i++){
   if(child?.exitCode!==null)throw new Error('worker process exited before catch-up');
   if(!(await conn!.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty)return;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('worker process catch-up timed out');
 };
 const start=()=>{
  const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:qa.url};delete env.HATCHET_CLIENT_TOKEN;
  child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/main.ts',import.meta.url))],{env,stdio:'ignore',cwd:fileURLToPath(new URL('..',import.meta.url))});
 };
 const stopChild=async()=>{if(child&&child.exitCode===null){const done=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill();await done;}child=undefined;};
 try {
  await store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_NO_HATCHET',data:{},occurredAt:now});
  start();await waitClean();await stopChild();
  await store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_PROCESS_RESTART',data:{},occurredAt:now});
  start();await waitClean();await stopChild();
  assert((await reads.activity(actor,op.id)).events.some(e=>e.kind==='QA_PROCESS_RESTART'));
  await conn.pool.query("CREATE FUNCTION qa_pause_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='QA_CRASH' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$");
  await conn.pool.query('CREATE TRIGGER qa_pause_projection BEFORE INSERT ON operation_event_envelopes FOR EACH ROW EXECUTE FUNCTION qa_pause_projection()');
  await store.writeEvent({workspaceId:actor.workspaceId,operationId:op.id,kind:'QA_CRASH',data:{},occurredAt:now});
  start();let sleeping=false;
  for(let i=0;i<450;i++){
   if(child?.exitCode!==null)throw new Error('worker exited before crash probe');
   if(Number((await conn.pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep'")).rows[0].n)>0){sleeping=true;break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(sleeping,'worker entered in-flight projection');
  await stopChild();
  assert.equal((await conn.pool.query('SELECT dirty FROM projection_work WHERE operation_id=$1',[op.id])).rows[0].dirty,true);
  assert.equal((await conn.pool.query("SELECT count(*)::int AS n FROM operation_event_envelopes WHERE kind='QA_CRASH' AND operation_id=$1",[op.id])).rows[0].n,0);
  await conn.pool.query('DROP TRIGGER qa_pause_projection ON operation_event_envelopes');
  await conn.pool.query('DROP FUNCTION qa_pause_projection()');
  start();await waitClean();await stopChild();
  assert((await reads.activity(actor,op.id)).events.some(e=>e.kind==='QA_CRASH'));
 } finally {await stopChild();}
 console.log('Projection worker QA PASSED: read-only, isolation, dirty rollback, concurrent workers/writers, replay and restart');
} finally {
 await reader?.close();await conn?.close();await qa.drop();
}
