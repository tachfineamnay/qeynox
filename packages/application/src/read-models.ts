import { and,desc,eq,gt,sql } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,operations,events,attempts,approvals,claims,resultDocuments,eventEnvelopes,operationViews,projectionCursors,steps } from '@qeynox/persistence';
export type NeedsAttention='NONE'|'APPROVAL'|'FAILED'|'INCOMPLETE'|'REQUIRES_REVIEW';
export class OperationReadModels{
 constructor(private readonly store:QeyNoxStore){}
 async sync(actor:Principal,operationId:ID){
  const op=await this.store.getOperation(actor,operationId);
  await this.store.db.transaction(async tx=>{
   await tx.insert(projectionCursors).values({operationId,lastSequence:0}).onConflictDoNothing();
   const [cursor]=await tx.select().from(projectionCursors).where(eq(projectionCursors.operationId,operationId)).for('update').limit(1);
   if(!cursor)throw new DomainError('INVALID_STATE','Projection cursor missing');
   let sequence=cursor.lastSequence;
   const sourceEvents=await tx.select().from(events).where(and(eq(events.workspaceId,actor.workspaceId),eq(events.operationId,operationId))).orderBy(events.occurredAt,events.id);
   const mapped=await tx.select({eventId:eventEnvelopes.eventId}).from(eventEnvelopes).where(and(eq(eventEnvelopes.operationId,operationId),eq(eventEnvelopes.workspaceId,actor.workspaceId)));
   const seen=new Set(mapped.map(x=>x.eventId));
   for(const item of sourceEvents){
    if(seen.has(item.id))continue;
    sequence++;
    const event=item.payload;
    await tx.insert(eventEnvelopes).values({
      id:newId(),workspaceId:actor.workspaceId,operationId,eventId:item.id,sequence,schemaVersion:1,
      kind:item.kind,revisionId:(event.data?.revisionId as string|undefined),attemptId:(event.data?.attemptId as string|undefined),
      actorType:event.actorId?'USER_OR_SERVICE':'SYSTEM',occurredAt:event.occurredAt,
      correlationId:typeof event.data?.correlationId==='string'?event.data.correlationId:undefined,
      causationId:typeof event.data?.causationId==='string'?event.data.causationId:undefined,
      data:cleanProjection(event.data),
    });
   }
   await tx.update(projectionCursors).set({lastSequence:sequence}).where(eq(projectionCursors.operationId,operationId));
   const latest=(await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId))).limit(1))[0]?.payload;
   if(!latest)throw new DomainError('NOT_FOUND','Operation missing');
   const allSteps=latest.currentRevisionId?(await tx.select().from(steps).where(eq(steps.revisionId,latest.currentRevisionId))).map(x=>x.payload):[];
   const allAttempts=latest.currentRevisionId?(await tx.select().from(attempts).where(eq(attempts.revisionId,latest.currentRevisionId))).map(x=>x.payload):[];
   const complete=new Set(allAttempts.filter(a=>a.state==='COMPLETED').map(a=>a.workStepId));
   const waiting=(await tx.select().from(approvals).where(and(eq(approvals.workspaceId,actor.workspaceId),eq(approvals.operationId,operationId),eq(approvals.status,'PENDING')))).length;
   const resultCount=(await tx.select({n:sql<number>`count(*)::int`}).from(resultDocuments).where(and(eq(resultDocuments.workspaceId,actor.workspaceId),eq(resultDocuments.operationId,operationId))))[0]?.n??0;
   const evidenceCount=(await tx.select({n:sql<number>`count(*)::int`}).from(claims).where(and(eq(claims.workspaceId,actor.workspaceId),eq(claims.operationId,operationId))))[0]?.n??0;
   const attention:NeedsAttention=waiting>0?'APPROVAL':latest.status==='FAILED'?'FAILED':latest.status==='WAITING_APPROVAL'?'REQUIRES_REVIEW':latest.status==='RUNNING'?'INCOMPLETE':'NONE';
   const view={operationId,workspaceId:actor.workspaceId,title:latest.title,status:latest.status,revisionId:latest.currentRevisionId,attention,lastActivityAt:latest.lastActivityAt,stepCount:allSteps.length,completedSteps:complete.size,pendingApprovals:waiting,resultCount,evidenceCount,lastSequence:sequence};
   await tx.insert(operationViews).values(view).onConflictDoUpdate({target:operationViews.operationId,set:view});
  });
  return this.store.db.select().from(operationViews).where(and(eq(operationViews.operationId,operationId),eq(operationViews.workspaceId,actor.workspaceId))).limit(1).then(xs=>xs[0]);
 }
 async activity(actor:Principal,operationId:ID,afterSequence=0,limit=50){
  await this.sync(actor,operationId);
  const entries=await this.store.db.select().from(eventEnvelopes).where(and(eq(eventEnvelopes.workspaceId,actor.workspaceId),eq(eventEnvelopes.operationId,operationId),gt(eventEnvelopes.sequence,afterSequence))).orderBy(eventEnvelopes.sequence).limit(Math.min(100,Math.max(1,limit)));
  return {events:entries,nextCursor:entries.length?entries[entries.length-1]!.sequence:afterSequence,transport:'POLLING' as const};
 }
 async recent(actor:Principal,limit=30){
  const recent=await this.store.listOperations(actor,Math.min(limit,100));
  for(const op of recent)await this.sync(actor,op.id);
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
