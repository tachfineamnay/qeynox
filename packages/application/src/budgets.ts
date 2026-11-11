import { and,eq,sql } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,operationBudgets,usageReservations,usageLedger,loopFingerprints } from '@qeynox/persistence';
export interface BudgetPolicy {
 version:number;currency:string;maxMoneyMinor:number;maxAgentCalls:number;maxToolCalls:number;
 maxDurationSeconds:number;maxConcurrent:number;unitMaxMinor:Record<string,number>;
}
export type ActivityKind='ENGINE'|'TOOL';
export class BudgetService {
 constructor(private readonly store:QeyNoxStore){}
 async requirePolicy(actor:Principal,operationId:ID):Promise<BudgetPolicy>{
  await this.store.getOperation(actor,operationId);
  const [row]=await this.store.db.select().from(operationBudgets).where(and(eq(operationBudgets.workspaceId,actor.workspaceId),eq(operationBudgets.operationId,operationId))).limit(1);
  if(!row)throw new DomainError('NOT_CONFIGURED','Operation execution budget not configured');
  const policy=row.policy as unknown as BudgetPolicy;
  if(!policy||policy.version!==row.version||!Number.isSafeInteger(row.maxMoneyMinor)||row.maxMoneyMinor<0)throw new DomainError('INVALID_STATE','Budget policy invalid');
  return policy;
 }
 async reserve(actor:Principal,operationId:ID,attemptId:ID,kind:ActivityKind,providerKey:string,key:string):Promise<{reservationId:string;maximumCostMinor:number}>{
  await this.store.getOperation(actor,operationId);
  const now=new Date();
  return this.store.db.transaction(async tx=>{
   const [budget]=await tx.select().from(operationBudgets).where(and(eq(operationBudgets.workspaceId,actor.workspaceId),eq(operationBudgets.operationId,operationId))).for('update').limit(1);
   if(!budget)throw new DomainError('NOT_CONFIGURED','Operation budget missing');
   const policy=budget.policy as unknown as BudgetPolicy;
   const [existing]=await tx.select().from(usageReservations).where(eq(usageReservations.key,key)).limit(1);
   if(existing){if(existing.operationId!==operationId||existing.attemptId!==attemptId||existing.providerKey!==providerKey)throw new DomainError('CONFLICT','Budget reservation key reused');return {reservationId:existing.id,maximumCostMinor:existing.reservedMinor};}
   const max=policy.unitMaxMinor?.[providerKey];
   if(max===undefined||!Number.isSafeInteger(max)||max<0)throw new DomainError('NOT_CONFIGURED','Provider cost ceiling absent');
   if((now.getTime()-Date.parse(budget.startedAt))/1000>budget.maxDurationSeconds)throw new DomainError('BUDGET_EXHAUSTED','Operation wall-time budget exceeded');
   const [active]=await tx.select({count:sql<number>`count(*)::int`}).from(usageReservations).where(and(eq(usageReservations.operationId,operationId),eq(usageReservations.state,'RESERVED')));
   if((active?.count??0)>=budget.maxConcurrent)throw new DomainError('BUDGET_EXHAUSTED','Concurrent execution limit');
   if(budget.spentMinor+budget.reservedMinor+max>budget.maxMoneyMinor)throw new DomainError('BUDGET_EXHAUSTED','Spending ceiling exceeded');
   if(kind==='ENGINE'&&budget.usedAgentCalls>=budget.maxAgentCalls)throw new DomainError('BUDGET_EXHAUSTED','Agent call ceiling exceeded');
   if(kind==='TOOL'&&budget.usedToolCalls>=budget.maxToolCalls)throw new DomainError('BUDGET_EXHAUSTED','Tool call ceiling exceeded');
   const id=newId();
   await tx.insert(usageReservations).values({id,workspaceId:actor.workspaceId,operationId,attemptId,key,kind,providerKey,policyVersion:budget.version,reservedMinor:max,state:'RESERVED',createdAt:now.toISOString()});
   await tx.update(operationBudgets).set({reservedMinor:budget.reservedMinor+max,usedAgentCalls:budget.usedAgentCalls+(kind==='ENGINE'?1:0),usedToolCalls:budget.usedToolCalls+(kind==='TOOL'?1:0)}).where(eq(operationBudgets.id,budget.id));
   return {reservationId:id,maximumCostMinor:max};
  });
 }
 async settle(actor:Principal,reservationId:ID,details:{costMinor?:number;origin:'PROVIDER_REPORTED'|'ESTIMATED'|'UNKNOWN';tokensIn?:number;tokensOut?:number}):Promise<void>{
  return this.store.db.transaction(async tx=>{
   const [reservation]=await tx.select().from(usageReservations).where(and(eq(usageReservations.id,reservationId),eq(usageReservations.workspaceId,actor.workspaceId))).for('update').limit(1);
   if(!reservation||reservation.state!=='RESERVED')throw new DomainError('CONFLICT','Reservation is not open');
   const [budget]=await tx.select().from(operationBudgets).where(and(eq(operationBudgets.operationId,reservation.operationId),eq(operationBudgets.workspaceId,actor.workspaceId))).for('update').limit(1);
   if(!budget)throw new DomainError('NOT_CONFIGURED','Budget missing');
   if(details.costMinor!==undefined&&(!Number.isSafeInteger(details.costMinor)||details.costMinor<0||details.costMinor>reservation.reservedMinor))throw new DomainError('INVALID_INPUT','Reported cost exceeds reserved maximum');
   const uncertain=details.origin==='UNKNOWN'||details.costMinor===undefined;
   const newState=uncertain?'UNKNOWN':'SETTLED';
   await tx.update(usageReservations).set({state:newState,settledAt:new Date().toISOString()}).where(eq(usageReservations.id,reservationId));
   await tx.update(operationBudgets).set({reservedMinor:budget.reservedMinor-(uncertain?0:reservation.reservedMinor),spentMinor:budget.spentMinor+(uncertain?0:details.costMinor!)}).where(eq(operationBudgets.id,budget.id));
   await tx.insert(usageLedger).values({id:newId(),workspaceId:actor.workspaceId,operationId:reservation.operationId,reservationId,origin:details.origin,costMinor:details.costMinor,currency:budget.currency,tokensIn:details.tokensIn,tokensOut:details.tokensOut,recordedAt:new Date().toISOString()});
  });
 }
 async progress(actor:Principal,operationId:ID,fingerprint:string,progressHash:string):Promise<void>{
  await this.store.getOperation(actor,operationId);
  await this.store.db.transaction(async tx=>{
   const [existing]=await tx.select().from(loopFingerprints).where(and(eq(loopFingerprints.operationId,operationId),eq(loopFingerprints.fingerprint,fingerprint))).for('update').limit(1);
   const count=existing?.lastProgressHash===progressHash?(existing.count+1):1;
   if(count>3)throw new DomainError('BUDGET_EXHAUSTED','Repeated no-progress agent loop detected');
   if(existing)await tx.update(loopFingerprints).set({count,lastProgressHash:progressHash,updatedAt:new Date().toISOString()}).where(eq(loopFingerprints.id,existing.id));
   else await tx.insert(loopFingerprints).values({id:newId(),workspaceId:actor.workspaceId,operationId,fingerprint,count,lastProgressHash:progressHash,updatedAt:new Date().toISOString()});
  });
 }
}
