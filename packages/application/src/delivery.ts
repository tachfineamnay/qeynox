import { and,eq,inArray } from 'drizzle-orm';
import { DomainError,newId,transitionOperation,type ID,type Principal,type Operation } from '@qeynox/domain';
import { QeyNoxStore,resultDocuments,commercialOrders,approvals,operations,claims,events,type DocumentState } from '@qeynox/persistence';
import type { ResultDocument } from './result-document';

export class ResultDeliveryService {
 constructor(private readonly store:QeyNoxStore){}
 async deliver(actor:Principal,operationId:ID,documentId:ID,approvalId:ID){
  const operation=await this.store.getOperation(actor,operationId);
  if(operation.status!=='WAITING_APPROVAL'||!operation.currentRevisionId)throw new DomainError('INVALID_STATE','Operation is not ready for result review');
  return this.store.db.transaction(async tx=>{
    const [op]=await tx.select().from(operations).where(and(eq(operations.id,operationId),eq(operations.workspaceId,actor.workspaceId))).for('update').limit(1);
    if(!op||op.status!=='WAITING_APPROVAL')throw new DomainError('CONFLICT','Operation changed');
    const [row]=await tx.select().from(resultDocuments).where(and(eq(resultDocuments.id,documentId),eq(resultDocuments.operationId,operationId),eq(resultDocuments.workspaceId,actor.workspaceId))).limit(1);
    if(!row||row.revisionId!==op.currentRevisionId||row.state!=='READY_FOR_REVIEW')throw new DomainError('INVALID_STATE','Document has not passed evidence readiness');
    const [approval]=await tx.select().from(approvals).where(and(eq(approvals.id,approvalId),eq(approvals.workspaceId,actor.workspaceId),eq(approvals.operationId,operationId))).limit(1);
    if(!approval||approval.payload.purpose!=='RESULT_REVIEW'||approval.payload.planRevisionId!==row.revisionId||approval.status!=='APPROVED')throw new DomainError('DENIED','Specific approved result review required');
    const doc=row.document as unknown as ResultDocument;
    const claimIds=doc.findings.map(f=>f.claimId);
    if(!claimIds.length)throw new DomainError('INVALID_STATE','No evidenced findings');
    const currentClaims=await tx.select().from(claims).where(and(eq(claims.workspaceId,actor.workspaceId),eq(claims.operationId,operationId),inArray(claims.id,claimIds)));
    if(currentClaims.length!==claimIds.length||currentClaims.some(c=>c.status!=='SUPPORTED'))throw new DomainError('INVALID_STATE','Unverified or stale claims prevent delivery');
    const [order]=await tx.select().from(commercialOrders).where(and(eq(commercialOrders.workspaceId,actor.workspaceId),eq(commercialOrders.operationId,operationId),eq(commercialOrders.revisionId,row.revisionId))).limit(1);
    if(!order||!['AUTHORIZED','FULFILLING'].includes(order.state))throw new DomainError('DENIED','Unapproved commercial fulfillment');
    const now=new Date().toISOString();
    const completed=transitionOperation(op.payload,'COMPLETED',now,op.version);
    await tx.update(operations).set({status:'COMPLETED',version:completed.version,payload:completed,lastActivityAt:now}).where(and(eq(operations.id,operationId),eq(operations.version,op.version)));
    await tx.update(resultDocuments).set({state:'DELIVERABLE',document:{...doc,status:'DELIVERABLE'}}).where(eq(resultDocuments.id,documentId));
    await tx.update(commercialOrders).set({state:'DELIVERED',updatedAt:now}).where(eq(commercialOrders.id,order.id));
    const event={id:newId(),workspaceId:actor.workspaceId,operationId,kind:'RESULT_DELIVERED',actorId:actor.userId,data:{documentId,approvalId},occurredAt:now,eventVersion:1};
    await tx.insert(events).values({id:event.id,workspaceId:event.workspaceId,operationId,kind:event.kind,occurredAt:now,payload:event});
    return {documentId,status:'DELIVERABLE' as DocumentState,operationStatus:'COMPLETED' as const};
  });
 }
}
