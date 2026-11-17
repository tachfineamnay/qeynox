import assert from 'node:assert/strict';
import { mkdtemp,copyFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDatabase,defaultMigrationsDirectory,runMigrations } from '@qeynox/persistence';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';
import { projectOnce } from '../src/runtime';

const qa=await createIsolatedQaDatabase(),dir=await mkdtemp(join(tmpdir(),'qeynox-projection-migrations-'));
const conn=connectDatabase(qa.url);
try {
 for(const name of await readdir(defaultMigrationsDirectory))if(name.endsWith('.sql')&&!name.startsWith('0018_'))await copyFile(join(defaultMigrationsDirectory,name),join(dir,name));
 await runMigrations(qa.url,{directory:dir});
 const now=new Date().toISOString();
 const operation={id:'historical-op',workspaceId:'historical-ws',createdBy:'historical-user',goalId:'historical-goal',title:'Historical',status:'DRAFT',version:1,createdAt:now,updatedAt:now,lastActivityAt:now};
 await conn.pool.query("INSERT INTO operations(id,workspace_id,created_by,goal_id,status,version,last_activity_at,payload) VALUES($1,$2,$3,$4,'DRAFT',1,$5,$6)",[operation.id,operation.workspaceId,operation.createdBy,operation.goalId,now,operation]);
 for(const [id,kind] of [['first','FIRST'],['second','SECOND']]){
  const event={id,workspaceId:operation.workspaceId,operationId:operation.id,kind,occurredAt:now,data:{},eventVersion:1};
  await conn.pool.query('INSERT INTO operation_events(id,workspace_id,operation_id,kind,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6)',[id,operation.workspaceId,operation.id,kind,now,event]);
 }
 await conn.pool.query("INSERT INTO operation_event_envelopes(id,workspace_id,operation_id,event_id,sequence,kind,actor_type,occurred_at,data) VALUES('envelope-1',$1,$2,'first',1,'FIRST','SYSTEM',$3,'{}')",[operation.workspaceId,operation.id,now]);
 await conn.pool.query("INSERT INTO projection_cursors(operation_id,last_sequence) VALUES('historical-op',2)");
 await assert.rejects(()=>runMigrations(qa.url),/Invalid historical cursor/,'inconsistent historical cursor must block migration');
 const missing=await conn.pool.query("SELECT to_regclass('public.projection_work') AS name");assert.equal(missing.rows[0].name,null,'failed migration rolls back');
 await conn.pool.query("UPDATE projection_cursors SET last_sequence=1 WHERE operation_id='historical-op'");
 const result=await runMigrations(qa.url);assert.deepEqual(result.applied,['0018_projection_delivery.sql']);
 const events=await conn.pool.query("SELECT id,projection_sequence FROM operation_events ORDER BY projection_sequence");
 assert.deepEqual(events.rows,[{id:'first',projection_sequence:1},{id:'second',projection_sequence:2}]);
 const work=await conn.pool.query("SELECT dirty,next_event_sequence FROM projection_work WHERE operation_id='historical-op'");
 assert.deepEqual(work.rows[0],{dirty:true,next_event_sequence:2});
 assert.equal(await projectOnce(conn.db),'historical-op');
 const envelopes=await conn.pool.query("SELECT id,event_id,sequence FROM operation_event_envelopes WHERE operation_id='historical-op' ORDER BY sequence");
 assert.equal(envelopes.rows[0].id,'envelope-1');
 assert.deepEqual(envelopes.rows.map(row=>[row.event_id,row.sequence]),[['first',1],['second',2]]);
 const rerun=await runMigrations(qa.url);assert.equal(rerun.applied.length,0);
 console.log('Projection migration QA PASSED: historical sequence preservation, corruption refusal and atomic rollback');
} finally {await conn.close();await qa.drop();await rm(dir,{recursive:true,force:true});}
