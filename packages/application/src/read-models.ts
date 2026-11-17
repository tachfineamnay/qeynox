import { and,desc,eq,gt,sql } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,operations,events,attempts,approvals,claims,resultDocuments,eventEnvelopes,operationViews,projectionCursors,projectionWork,steps,type QeyNoxDatabase } from '@qeynox/persistence';
export type NeedsAttention='NONE'|'APPROVAL'|'FAILED'|'INCOMPLETE'|'REQUIRES_REVIEW';
type Transaction=Parameters<Parameters<QeyNoxDatabase['transaction']>[0]>[0];
export class OperationReadModels{
 constructor(private readonly store:QeyNoxStore){}
 /** Materialize persisted events and the operation view under the per-operation cursor lock. */
 async project(actor:Principal,operationId:ID){
  await this.store.getOperation(actor,operationId);
  await this.store.db.transaction(async tx=>{
   const [work]=await tx.select().from(projectionWork).where(and(eq(projectionWork.operationId,operationId),eq(projectionWork.workspaceId,actor.workspaceId))).for('update').limit(1);
   if(!work)throw new DomainError('INVALID_STATE','Projection work missing');
   await this.projectInTransaction(tx,actor.workspaceId,operationId);
  });
  return this.summary(actor,operationId);
 }
 /** Lock the durable work row for the entire projection transaction. */
 async projectInTransaction(tx:Transaction,workspaceId:ID,operationId:ID){
   const [work]=await tx.select().from(projectionWork).where(and(eq(projectionWork.operationId,operationId),eq(projectionWork.workspaceId,workspaceId))).for('update').limit(1);
   if(!work)throw new DomainError('INVALID_STATE','Projection work missing');
   await tx.insert(projectionCursors).values({operationId,lastSequence:0}).onConflictDoNothing();
   const [cursor]=await tx.select().from(projectionCursors).where(eq(projectionCursors.operationId,operationId)).for('update').limit(1);
   if(!cursor)throw new DomainError('INVALID_STATE','Projection cursor missing');
   let sequence=0;
   const sourceEvents=await tx.select().from(events).where(and(eq(events.workspaceId,workspaceId),eq(events.operationId,operationId))).orderBy(events.projectionSequence);
   const mapped=await tx.select().from(eventEnvelopes).where(eq(eventEnvelopes.operationId,operationId));
   if(mapped.some(x=>x.sequence>cursor.lastSequence))throw new DomainError('INVALID_STATE','Projection cursor behind published envelope');
   const seen=new Map(mapped.map(x=>[x.eventId,x]));
   for(const item of sourceEvents){
    sequence++;
    if(item.projectionSequence!==sequence)throw new DomainError('INVALID_STATE','Projection source sequence gap');
    const existing=seen.get(item.id);
    if(existing){
     if(existing.workspaceId!==workspaceId||existing.sequence!==sequence)throw new DomainError('INVALID_STATE','Projection envelope mismatch');
     seen.delete(item.id);continue;
    }
    const event=item.payload;
    await tx.insert(eventEnvelopes).values({
      id:newId(),workspaceId,operationId,eventId:item.id,sequence,schemaVersion:1,
      kind:item.kind,revisionId:(event.data?.revisionId as string|undefined),attemptId:(event.data?.attemptId as string|undefined),
      actorType:event.actorId?'USER_OR_SERVICE':'SYSTEM',occurredAt:event.occurredAt,
      correlationId:typeof event.data?.correlationId==='string'?event.data.correlationId:undefined,
      causationId:typeof event.data?.causationId==='string'?event.data.causationId:undefined,
      data:cleanProjection(event.data),
    });
   }
   if(seen.size||cursor.lastSequence>sequence||work.nextEventSequence!==sequence)throw new DomainError('INVALID_STATE','Projection cursor or envelope mismatch');
   await tx.update(projectionCursors).set({lastSequence:sequence}).where(eq(projectionCursors.operationId,operationId));
   const latest=(await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,workspaceId))).limit(1))[0]?.payload;
   if(!latest)throw new DomainError('NOT_FOUND','Operation missing');
   const allSteps=latest.currentRevisionId?(await tx.select().from(steps).where(and(eq(steps.operationId,operationId),eq(steps.revisionId,latest.currentRevisionId)))).map(x=>x.payload):[];
   const allAttempts=latest.currentRevisionId?(await tx.select().from(attempts).where(and(eq(attempts.operationId,operationId),eq(attempts.revisionId,latest.currentRevisionId)))).map(x=>x.payload):[];
   const complete=new Set(allAttempts.filter(a=>a.state==='COMPLETED').map(a=>a.workStepId));
   const waiting=(await tx.select().from(approvals).where(and(eq(approvals.workspaceId,workspaceId),eq(approvals.operationId,operationId),eq(approvals.status,'PENDING')))).length;
   const resultCount=(await tx.select({n:sql<number>`count(*)::int`}).from(resultDocuments).where(and(eq(resultDocuments.workspaceId,workspaceId),eq(resultDocuments.operationId,operationId))))[0]?.n??0;
   const evidenceCount=(await tx.select({n:sql<number>`count(*)::int`}).from(claims).where(and(eq(claims.workspaceId,workspaceId),eq(claims.operationId,operationId))))[0]?.n??0;
   const attention:NeedsAttention=waiting>0?'APPROVAL':latest.status==='FAILED'?'FAILED':latest.status==='WAITING_APPROVAL'?'REQUIRES_REVIEW':latest.status==='RUNNING'?'INCOMPLETE':'NONE';
   const [priorView]=await tx.select({workspaceId:operationViews.workspaceId}).from(operationViews).where(eq(operationViews.operationId,operationId)).limit(1);
   if(priorView&&priorView.workspaceId!==workspaceId)throw new DomainError('INVALID_STATE','Projection view workspace mismatch');
   const view={operationId,workspaceId,title:latest.title,status:latest.status,revisionId:latest.currentRevisionId,attention,lastActivityAt:latest.lastActivityAt,stepCount:allSteps.length,completedSteps:complete.size,pendingApprovals:waiting,resultCount,evidenceCount,lastSequence:sequence};
   await tx.insert(operationViews).values(view).onConflictDoUpdate({target:operationViews.operationId,set:view});
   await tx.update(projectionWork).set({dirty:false}).where(and(eq(projectionWork.operationId,operationId),eq(projectionWork.workspaceId,workspaceId)));
 }
 /** Explicit projection entry point for maintenance callers. */
 async sync(actor:Principal,operationId:ID){return this.project(actor,operationId);}
 async summary(actor:Principal,operationId:ID){
  await this.store.getOperation(actor,operationId);
  const [view]=await this.store.db.select().from(operationViews).where(and(eq(operationViews.operationId,operationId),eq(operationViews.workspaceId,actor.workspaceId))).limit(1);
  if(!view)throw new DomainError('NOT_CONFIGURED','Projection not available yet');
  return view;
 }
 async activity(actor:Principal,operationId:ID,afterSequence=0,limit=50){
  await this.summary(actor,operationId);
  const entries=await this.store.db.select().from(eventEnvelopes).where(and(eq(eventEnvelopes.workspaceId,actor.workspaceId),eq(eventEnvelopes.operationId,operationId),gt(eventEnvelopes.sequence,afterSequence))).orderBy(eventEnvelopes.sequence).limit(Math.min(100,Math.max(1,limit)));
  return {events:entries,nextCursor:entries.length?entries[entries.length-1]!.sequence:afterSequence,transport:'POLLING' as const};
 }
 async recent(actor:Principal,limit=30){
  if(!actor.workspaceId||!actor.userId)throw new DomainError('DENIED','Workspace required');
  return this.store.db.select().from(operationViews).where(eq(operationViews.workspaceId,actor.workspaceId)).orderBy(desc(operationViews.lastActivityAt)).limit(Math.min(100,Math.max(1,limit)));
 }
}
function cleanProjection(value:Readonly<Record<string,unknown>>):Record<string,unknown>{
 const out:Record<string,unknown>={};
 for(const [key,v] of Object.entries(value)){
  if(/token|secret|password|prompt|credential|authorization|private|rawresponse/i.test(key))continue;
  if(typeof v==='string')out[key]=v.slice(0,2000);
  else if(typeof v==='number'||typeof v==='boolean'||v===null)out[key]=v;
 }
 return out;
}
