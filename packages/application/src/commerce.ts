import { createHash } from 'node:crypto';
import { and,desc,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,offers,quotes,quoteAcceptances,commercialOrders } from '@qeynox/persistence';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ConfiguredOffer {
 id:string;version:number;status:'DRAFT'|'ACTIVE'|'DISABLED';label:string;capabilityIds:readonly string[];
 deliverableSchemaVersion:number;scope:readonly string[];exclusions:readonly string[];
 regions:readonly string[];locales:readonly string[];termsVersion:string;currency:string;
 amountMinor:number;taxPolicy:'CONFIG_REQUIRED'|'CONFIGURED';isExplicitlyFree:boolean;
}
export interface CommercialOfferView {
 readonly id:string;readonly version:number;readonly label:string;readonly amountMinor:number;readonly currency:string;
 readonly isExplicitlyFree:boolean;readonly termsVersion:string;readonly scope:readonly string[];readonly exclusions:readonly string[];
}
export interface CommercialQuoteView {
 readonly id:string;readonly offerId:string;readonly amountMinor:number;readonly currency:string;
 readonly expiresAt:string;readonly createdAt:string;readonly accepted:boolean;readonly expired:boolean;
}
export interface CommercialView {
 readonly operationId:string;readonly revisionId:string|null;
 readonly offers:readonly CommercialOfferView[];readonly quotes:readonly CommercialQuoteView[];
 readonly order:{readonly id:string;readonly state:string;readonly amountMinor:number;readonly currency:string;readonly createdAt:string}|null;
 readonly executionAuthorized:boolean;
 readonly payment:{readonly required:boolean;readonly state:string|null};
}
export class CommerceService {
 constructor(private readonly store:QeyNoxStore){}
 async quote(actor:Principal,operationId:ID,offerId:string,revisionId:ID):Promise<unknown>{
  const operation=await this.store.getOperation(actor,operationId);
  if(operation.currentRevisionId!==revisionId)throw new DomainError('CONFLICT','Quote requires current plan revision');
  const [row]=await this.store.db.select().from(offers).where(and(eq(offers.id,offerId),eq(offers.status,'ACTIVE'))).orderBy(desc(offers.version)).limit(1);
  if(!row)throw new DomainError('NOT_CONFIGURED','No active configured RaaS offer');
  const offer=row.configuration as unknown as ConfiguredOffer;
  if(!Number.isSafeInteger(row.amountMinor)||row.amountMinor<0||!(/^[A-Z]{3}$/.test(row.currency)))throw new DomainError('INVALID_STATE','Invalid offer price/currency');
  if(offer.taxPolicy!=='CONFIGURED')throw new DomainError('NOT_CONFIGURED','Tax treatment must be configured');
  if(row.amountMinor===0&&!offer.isExplicitlyFree)throw new DomainError('INVALID_STATE','Free offer is not explicitly authorized');
  const plan=await this.store.getRevision(revisionId);
  if(!plan||plan.operationId!==operationId)throw new DomainError('INVALID_STATE','Plan revision missing');
  const steps=await this.store.getSteps(revisionId);
  if(steps.some(s=>!offer.capabilityIds.includes(s.capabilityId)))throw new DomainError('DENIED','Plan includes capabilities outside offer scope');
  const scopeHash=hash({workspaceId:actor.workspaceId,operationId,revisionId,offerId:row.id,version:row.version,terms:offer.termsVersion,steps:steps.map(s=>({id:s.id,capability:s.capabilityId,description:s.description,intent:s.intent})),amountMinor:row.amountMinor,currency:row.currency});
  const quoteId=newId(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+24*3600000).toISOString();
  const payload={id:quoteId,scopeHash,scope:offer.scope,exclusions:offer.exclusions,label:offer.label,termsVersion:offer.termsVersion};
  await this.store.db.insert(quotes).values({id:quoteId,workspaceId:actor.workspaceId,operationId,revisionId,offerId:row.id,offerVersion:row.version,amountMinor:row.amountMinor,currency:row.currency,scopeHash,expiresAt,createdAt,termsVersion:offer.termsVersion,payload});
  return {id:quoteId,amountMinor:row.amountMinor,currency:row.currency,expiresAt,scope:offer.scope,exclusions:offer.exclusions,scopeHash,termsVersion:offer.termsVersion};
 }
 async accept(actor:Principal,quoteId:ID,key:string){
  const [quote]=await this.store.db.select().from(quotes).where(and(eq(quotes.id,quoteId),eq(quotes.workspaceId,actor.workspaceId))).limit(1);
  if(!quote)throw new DomainError('NOT_FOUND','Quote not found');
  if(quote.expiresAt<=new Date().toISOString())throw new DomainError('INVALID_STATE','Quote expired');
  const operation=await this.store.getOperation(actor,quote.operationId as ID);
  if(operation.currentRevisionId!==quote.revisionId)throw new DomainError('CONFLICT','Plan revision changed; request a new quote');
  return this.store.db.transaction(async tx=>{
   const [existing]=await tx.select().from(quoteAcceptances).where(eq(quoteAcceptances.quoteId,quoteId)).limit(1);
   if(existing){
     if(existing.actorId!==actor.userId||existing.idempotencyKey!==key)throw new DomainError('CONFLICT','Quote already accepted');
     return {orderId:(await tx.select().from(commercialOrders).where(eq(commercialOrders.quoteId,quoteId)).limit(1))[0]?.id,alreadyAccepted:true};
   }
   const acceptanceId=newId(),orderId=newId(),now=new Date().toISOString();
   await tx.insert(quoteAcceptances).values({id:acceptanceId,quoteId,workspaceId:actor.workspaceId,operationId:quote.operationId,revisionId:quote.revisionId,actorId:actor.userId,scopeHash:quote.scopeHash,acceptedAt:now,termsVersion:quote.termsVersion,idempotencyKey:key});
   // Money cannot be considered received by the acceptance event alone.
   const [offer]=await tx.select().from(offers).where(and(eq(offers.id,quote.offerId),eq(offers.version,quote.offerVersion))).limit(1);
   const config=offer?.configuration as unknown as ConfiguredOffer|undefined;
   const genuinelyFree=quote.amountMinor===0&&config?.isExplicitlyFree===true;
   const state=genuinelyFree?'AUTHORIZED':'PAYMENT_REQUIRED';
   await tx.insert(commercialOrders).values({id:orderId,workspaceId:actor.workspaceId,operationId:quote.operationId,revisionId:quote.revisionId,quoteId,state,amountMinor:quote.amountMinor,currency:quote.currency,createdAt:now,updatedAt:now});
   return {orderId,state,alreadyAccepted:false};
  });
 }
 /** Customer-visible commercial state for the current plan revision: offers, quotes and order. */
 async view(actor:Principal,operationId:ID):Promise<CommercialView>{
  const operation=await this.store.getOperation(actor,operationId);
  const revisionId=operation.currentRevisionId??null;
  const [order]=revisionId
   ?await this.store.db.select().from(commercialOrders).where(and(eq(commercialOrders.workspaceId,actor.workspaceId),eq(commercialOrders.operationId,operationId),eq(commercialOrders.revisionId,revisionId))).limit(1)
   :[];
  const orderView=order?{id:order.id,state:order.state,amountMinor:order.amountMinor,currency:order.currency,createdAt:order.createdAt}:null;
  if(!revisionId)return {operationId,revisionId:null,offers:[],quotes:[],order:orderView,executionAuthorized:false,payment:{required:false,state:orderView?.state??null}};
  const steps=await this.store.getSteps(revisionId);
  const required=new Set(steps.map(step=>step.capabilityId));
  const offerRows=await this.store.db.select().from(offers).where(eq(offers.status,'ACTIVE'));
  const offered:CommercialOfferView[]=[];
  for(const row of offerRows){
   const configuration=row.configuration as unknown as ConfiguredOffer;
   const capabilityIds=Array.isArray(configuration.capabilityIds)?configuration.capabilityIds:[];
   if(!capabilityIds.length||![...required].every(id=>capabilityIds.includes(id)))continue;
   offered.push({id:row.id,version:row.version,label:configuration.label,amountMinor:row.amountMinor,currency:row.currency,isExplicitlyFree:configuration.isExplicitlyFree===true,termsVersion:configuration.termsVersion,scope:configuration.scope??[],exclusions:configuration.exclusions??[]});
  }
  const quoteRows=await this.store.db.select().from(quotes).where(and(eq(quotes.workspaceId,actor.workspaceId),eq(quotes.operationId,operationId),eq(quotes.revisionId,revisionId))).orderBy(desc(quotes.createdAt));
  const now=new Date().toISOString();
  return {
   operationId,revisionId,offers:offered,
   quotes:quoteRows.map(quote=>({id:quote.id,offerId:quote.offerId,amountMinor:quote.amountMinor,currency:quote.currency,expiresAt:quote.expiresAt,createdAt:quote.createdAt,accepted:Boolean(order&&order.quoteId===quote.id),expired:quote.expiresAt<=now})),
   order:orderView,
   executionAuthorized:Boolean(order&&['AUTHORIZED','FULFILLING'].includes(order.state)),
   payment:{required:order?.state==='PAYMENT_REQUIRED',state:order?.state??null},
  };
 }
 async assertExecutionAllowed(actor:Principal,operationId:ID,revisionId:ID):Promise<void>{
  await this.store.getOperation(actor,operationId);
  const [order]=await this.store.db.select().from(commercialOrders).where(and(eq(commercialOrders.workspaceId,actor.workspaceId),eq(commercialOrders.operationId,operationId),eq(commercialOrders.revisionId,revisionId))).limit(1);
  if(!order)throw new DomainError('PAYMENT_REQUIRED','Accepted service scope is required');
  if(order.state==='PAYMENT_REQUIRED')throw new DomainError('PAYMENT_NOT_CONFIGURED','No payment provider configured');
  if(!['AUTHORIZED','FULFILLING'].includes(order.state))throw new DomainError('DENIED','Order is not authorized for execution');
 }
}
