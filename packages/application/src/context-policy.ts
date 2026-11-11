import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type Principal } from '@qeynox/domain';
import { QeyNoxStore,consents,contexts,erasureRequests,workspaceDataPolicies } from '@qeynox/persistence';
export class ContextPolicyService{
 constructor(private readonly store:QeyNoxStore){}
 async requestLocalErasure(actor:Principal){
  const now=new Date().toISOString();
  return this.store.db.transaction(async tx=>{
   const current=await tx.select().from(consents).where(and(eq(consents.workspaceId,actor.workspaceId),eq(consents.userId,actor.userId)));
   for(const c of current)if(!c.payload.revokedAt)await tx.update(consents).set({payload:{...c.payload,revokedAt:now,version:c.payload.version+1}}).where(eq(consents.id,c.id));
   const items=await tx.select().from(contexts).where(and(eq(contexts.workspaceId,actor.workspaceId),eq(contexts.ownerUserId,actor.userId)));
   for(const item of items)await tx.update(contexts).set({payload:{...item.payload,value:null,deletedAt:now,updatedAt:now}}).where(eq(contexts.id,item.id));
   const id=newId();
   await tx.insert(erasureRequests).values({id,workspaceId:actor.workspaceId,userId:actor.userId,requestedAt:now,localContextRevoked:'REQUESTED',externalDeletion:'NOT_CONFIRMED',notes:'Context values marked deleted; backups, audits and third-party retention require separate policies'});
   return {requestId:id,localContextMarked:items.length,externalDeletion:'NOT_CONFIRMED'};
  });
 }
 async policy(actor:Principal){
  const [row]=await this.store.db.select().from(workspaceDataPolicies).where(eq(workspaceDataPolicies.workspaceId,actor.workspaceId)).limit(1);
  if(!row)throw new DomainError('NOT_CONFIGURED','Workspace retention policy not configured');
  return {version:row.version,retentionDays:row.retentionDays};
 }
}
