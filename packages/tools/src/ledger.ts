import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID } from '@qeynox/domain';
import type { QeyNoxDatabase } from '@qeynox/persistence';
import { toolLedger,toolIntents } from '@qeynox/persistence';
import type { Provenance,ToolAuditRecord,ToolLedgerPort } from './types';

export class PgToolLedger implements ToolLedgerPort {
  constructor(private readonly db:QeyNoxDatabase){}
  async reserve(record:ToolAuditRecord):Promise<'RESERVED'|'ALREADY_COMPLETED'|'IN_PROGRESS'|'UNKNOWN'>{
    return this.db.transaction(async tx=>{
      const [existing]=await tx.select().from(toolLedger).where(eq(toolLedger.intentId,record.intent.id)).limit(1);
      if(existing)return existing.outcome==='COMPLETED'?'ALREADY_COMPLETED':existing.outcome==='UNKNOWN'?'UNKNOWN':'IN_PROGRESS';
      const [intent]=await tx.insert(toolIntents).values({id:record.intent.id,operationId:record.intent.operationId,idempotencyKey:record.intent.idempotencyKey,payload:record.intent}).onConflictDoNothing().returning({id:toolIntents.id});
      if(!intent)throw new DomainError('CONFLICT','Tool idempotency key already used');
      const [created]=await tx.insert(toolLedger).values({id:newId(),workspaceId:record.workspaceId,operationId:record.intent.operationId,attemptId:record.intent.stepAttemptId,intentId:record.intent.id,connector:record.connectorId,outcome:'STARTED',requestDigest:record.requestDigest,createdAt:record.capturedAt,updatedAt:record.capturedAt}).onConflictDoNothing().returning({id:toolLedger.id});
      return created?'RESERVED':'IN_PROGRESS';
    });
  }
  async complete(intentId:ID,resultDigest:string,metadata:Provenance):Promise<void>{
    const rows=await this.db.update(toolLedger).set({outcome:'COMPLETED',result:{provider:metadata.provider,sourceUri:metadata.sourceUri,retrievedAt:metadata.retrievedAt,responseDigest:resultDigest},updatedAt:new Date().toISOString()}).where(and(eq(toolLedger.intentId,intentId),eq(toolLedger.outcome,'STARTED'))).returning({id:toolLedger.id});
    if(!rows.length)throw new DomainError('CONFLICT','Tool completion cannot be reconciled');
  }
  async fail(intentId:ID,code:string,uncertain:boolean):Promise<void>{
    await this.db.update(toolLedger).set({outcome:uncertain?'UNKNOWN':'FAILED',result:{code},updatedAt:new Date().toISOString()}).where(and(eq(toolLedger.intentId,intentId),eq(toolLedger.outcome,'STARTED')));
  }
}
