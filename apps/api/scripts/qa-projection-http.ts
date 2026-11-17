import 'reflect-metadata';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { connectDatabase,runMigrations } from '@qeynox/persistence';
import { projectOnce } from '../../worker/src/runtime';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

const qa=await createIsolatedQaDatabase();
let app:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
const conn=connectDatabase(qa.url);
try {
 await runMigrations(qa.url);process.env.DATABASE_URL=qa.url;process.env.QEYNOX_ALLOW_REGISTRATION='true';
 const start=async()=>{const a=await NestFactory.create(AppModule,{logger:false});a.useGlobalFilters(new DomainExceptionFilter());await a.listen(0,'127.0.0.1');return a;};
 app=await start();
 const base=()=>`http://127.0.0.1:${(app!.getHttpServer().address() as {port:number}).port}`;
 const request=async(path:string,method='GET',body?:unknown,token?:string)=>{
  const res=await fetch(base()+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,body:await res.json() as any};
 };
 const owner=await request('/v1/auth/register','POST',{email:'projection-http@example.invalid',password:'certification-passphrase',workspaceName:'Projection QA'});
 const other=await request('/v1/auth/register','POST',{email:'projection-other@example.invalid',password:'certification-passphrase',workspaceName:'Other QA'});
 assert.equal(owner.status,201);assert.equal(other.status,201);
 const op=await request('/v1/operations','POST',{title:'Projection QA',goal:'Verify HTTP read only',constraints:[]},owner.body.token);
 assert.equal(op.status,201);
 const prefix='/v1/mydash/operations/'+op.body.id;
 assert.equal((await request(prefix+'/summary','GET',undefined,owner.body.token)).status,503);
 assert.equal((await request(prefix+'/activity','GET',undefined,owner.body.token)).status,503);
 assert.equal(await projectOnce(conn.db),op.body.id);
 await app.close();app=undefined;
 const readUrl=new URL(qa.url);readUrl.searchParams.set('options','-c default_transaction_read_only=on');process.env.DATABASE_URL=readUrl.toString();
 app=await start();
 for(const path of [prefix+'/summary',prefix+'/activity?after=0&limit=1','/v1/mydash/recent',prefix+'/activity?after=1&limit=1']){
  const r=await request(path,'GET',undefined,owner.body.token);assert.equal(r.status,200,`${path} must work on read-only PostgreSQL`);
  if(path.includes('after=0')){assert.equal(r.body.events.length,1);assert.equal(r.body.nextCursor,1);assert.equal(r.body.transport,'POLLING');}
  if(path.includes('after=1'))assert.equal(r.body.events.length,0);
 }
 assert.equal((await request(prefix+'/summary','GET',undefined,other.body.token)).status,404);
 assert.equal((await request(prefix+'/activity','GET',undefined,other.body.token)).status,404);
 assert.deepEqual((await request('/v1/mydash/recent','GET',undefined,other.body.token)).body,[]);
 assert.equal((await request(prefix+'/summary')).status,403);
 console.log('Projection HTTP QA PASSED: read-only PostgreSQL, pagination, unprojected and workspace isolation');
} finally {await app?.close();await conn.close();await qa.drop();}
