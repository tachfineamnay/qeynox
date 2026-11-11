import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID } from '@qeynox/domain';
import type { QeyNoxDatabase } from '@qeynox/persistence';
import { toolLedger,toolIntents } from '@qeynox/persistence';
import type { Provenance,ToolAuditRecord,ToolLedgerPort } from './types';
export class PgToolLedger implements ToolLedgerPort{
 constructor(private readonly db:QeyNoxDatabase){}
 async reserve(record:ToolAuditRecord):Promise<'RESERVED'|'ALREADY_COMPLETED'|'IN_PROGRESS'|'UNKNOWN'>{
  return this.db.transaction(async tx=>{
   const [existing]=await tx.select().from(toolLedger).where(eq(toolLedger.intentId,record.intent.id)).limit(1);
   if(existing){
     if(existing.workspaceId!==record.workspaceId||existing.operationId!==record.intent.operationId||existing.requestDigest!==record.requestDigest)throw new DomainError('CONFLICT','Tool intent collision');
     return existing.outcome==='COMPLETED'?'ALREADY_COMPLETED':existing.outcome==='UNKNOWN'?'UNKNOWN':'IN_PROGRESS';
   }
   const createdIntent=await tx.insert(toolIntents).values({id:record.intent.id,operationId:record.intent.operationId,idempotencyKey:record.intent.idempotencyKey,payload:record.intent}).onConflictDoNothing().returning({id:toolIntents.id});
   if(!createdIntent.length)throw new DomainError('CONFLICT','Tool idempotency key collision');
   const inserted=await tx.insert(toolLedger).values({id:newId(),workspaceId:record.workspaceId,operationId:record.intent.operationId,attemptId:record.intent.stepAttemptId,intentId:record.intent.id,connector:record.connectorId,outcome:'STARTED',requestDigest:record.requestDigest,createdAt:record.capturedAt,updatedAt:record.capturedAt}).returning({id:toolLedger.id});
   return inserted.length?'RESERVED':'IN_PROGRESS';
  });
 }
 async complete(intentId:ID,resultDigest:string,metadata:Provenance):Promise<void>{
   const affected=await this.db.update(toolLedger).set({outcome:'COMPLETED',result:{provider:metadata.provider,sourceUri:metadata.sourceUri,retrievedAt:metadata.retrievedAt,responseDigest:resultDigest},updatedAt:new Date().toISOString()}).where(and(eq(toolLedger.intentId,intentId),eq(toolLedger.outcome,'STARTED'))).returning({id:toolLedger.id});
   if(!affected.length)throw new DomainError('CONFLICT','Tool completion conflict');
 }
 async fail(intentId:ID,code:string,uncertain:boolean):Promise<void>{
   await this.db.update(toolLedger).set({outcome:uncertain?'UNKNOWN':'FAILED',result:{errorCode:code},updatedAt:new Date().toISOString()}).where(and(eq(toolLedger.intentId,intentId),eq(toolLedger.outcome,'STARTED')));
 }
}
