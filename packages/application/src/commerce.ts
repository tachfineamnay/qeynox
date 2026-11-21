import { createHash } from 'node:crypto';
import { and,desc,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,offers,quotes,quoteAcceptances,commercialOrders,payments,type BetaTransaction } from '@qeynox/persistence';
import { commercePolicyFromEnvironment,type CommercePolicy } from './commerce-mode';
import { BetaExecutionAuthorizer,betaAuthorizationError,isBetaOrderState,type BetaAuthorizationView,type BetaOrderRef } from './beta-execution';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type OrderRow=typeof commercialOrders.$inferSelect;
const orderRef=(order:OrderRow):BetaOrderRef=>({id:order.id,workspaceId:order.workspaceId,operationId:order.operationId,revisionId:order.revisionId,quoteId:order.quoteId,state:order.state,amountMinor:order.amountMinor,currency:order.currency});
function isUniqueViolation(error:unknown):boolean{
 for(let current:unknown=error,depth=0;current&&depth<4;depth++){
  if(typeof current==='object'&&(current as {code?:unknown}).code==='23505')return true;
  current=typeof current==='object'?(current as {cause?:unknown}).cause:undefined;
 }
 return false;
}
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
 /**
  * MISSION A21.03 — the non-financial free-beta authorization covering this order, if any. Separate from
  * `payment` on purpose: it never means money moved, and `amountDueNowMinor` is always 0.
  */
 readonly betaAuthorization:BetaAuthorizationView|null;
 /** True when an unpaid accepted order of this revision can be covered by the free beta right now. */
 readonly betaAuthorizationAvailable:boolean;
}
export class CommerceService {
 private readonly beta:BetaExecutionAuthorizer;
 /**
  * The commerce policy defaults to `QEYNOX_COMMERCE_MODE` (A21.01); an unsupported value throws at
  * construction, so a misconfigured deployment fails at boot instead of authorizing anything.
  */
 constructor(private readonly store:QeyNoxStore,policy:CommercePolicy=commercePolicyFromEnvironment(),private readonly now:()=>Date=()=>new Date()){this.beta=new BetaExecutionAuthorizer(policy);}
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
  if(quote.expiresAt<=this.now().toISOString())throw new DomainError('INVALID_STATE','Quote expired');
  const operation=await this.store.getOperation(actor,quote.operationId as ID);
  if(operation.currentRevisionId!==quote.revisionId)throw new DomainError('CONFLICT','Plan revision changed; request a new quote');
  const replay=async(executor:QeyNoxStore['db']|BetaTransaction)=>{
   const [existing]=await executor.select().from(quoteAcceptances).where(eq(quoteAcceptances.quoteId,quoteId)).limit(1);
   if(!existing)return null;
   if(existing.actorId!==actor.userId||existing.idempotencyKey!==key)throw new DomainError('CONFLICT','Quote already accepted');
   const [order]=await executor.select().from(commercialOrders).where(eq(commercialOrders.quoteId,quoteId)).limit(1);
   return {orderId:order?.id,state:order?.state,alreadyAccepted:true};
  };
  try{
   return await this.store.db.transaction(async tx=>{
    const previous=await replay(tx);
    if(previous)return previous;
    const acceptanceId=newId(),orderId=newId(),at=this.now(),now=at.toISOString();
    await tx.insert(quoteAcceptances).values({id:acceptanceId,quoteId,workspaceId:actor.workspaceId,operationId:quote.operationId,revisionId:quote.revisionId,actorId:actor.userId,scopeHash:quote.scopeHash,acceptedAt:now,termsVersion:quote.termsVersion,idempotencyKey:key});
    // Money cannot be considered received by the acceptance event alone.
    const [offer]=await tx.select().from(offers).where(and(eq(offers.id,quote.offerId),eq(offers.version,quote.offerVersion))).limit(1);
    const config=offer?.configuration as unknown as ConfiguredOffer|undefined;
    const genuinelyFree=quote.amountMinor===0&&config?.isExplicitlyFree===true;
    // A21.03: a PRICED scope accepted by a workspace holding an ACTIVE beta grant, while the platform runs
    // as a free beta, is covered by a separate non-financial beta authorization. The quote, price, offer
    // version, terms and scope hash are kept exactly as accepted; no payment of any kind is created.
    const priced=!genuinelyFree&&quote.amountMinor>0&&Boolean(config);
    const beta=priced&&this.beta.enabled?await this.beta.eligibleGrant(tx,actor.workspaceId,at,true):null;
    const state=genuinelyFree?'AUTHORIZED':beta&&'grantId' in beta?'BETA_AUTHORIZED':'PAYMENT_REQUIRED';
    await tx.insert(commercialOrders).values({id:orderId,workspaceId:actor.workspaceId,operationId:quote.operationId,revisionId:quote.revisionId,quoteId,state,amountMinor:quote.amountMinor,currency:quote.currency,createdAt:now,updatedAt:now});
    if(state!=='BETA_AUTHORIZED')return {orderId,state,alreadyAccepted:false};
    const authorization=await this.beta.authorize(tx,{actorUserId:actor.userId,acceptanceId,at,order:{id:orderId,workspaceId:actor.workspaceId,operationId:quote.operationId,revisionId:quote.revisionId,quoteId,state,amountMinor:quote.amountMinor,currency:quote.currency}});
    if(!authorization)throw new DomainError('CONFLICT','Beta grant changed during acceptance');
    return {orderId,state,alreadyAccepted:false,betaAuthorizationId:authorization.id};
   });
  }catch(error){
   // Concurrent acceptances race on the unique acceptance/order constraints. The loser is told the truth:
   // an exact replay (same actor and key) gets the recorded outcome, anything else is a CONFLICT.
   if(!isUniqueViolation(error))throw error;
   const previous=await replay(this.store.db);
   if(previous)return previous;
   throw new DomainError('CONFLICT','Another quote was already accepted for this plan revision');
  }
 }
 /**
  * MISSION A21.03 — covers an existing unpaid order with the free beta.
  *
  * For an order accepted before the workspace's grant was active (it is then PAYMENT_REQUIRED). Only
  * the current revision's order, only while it is PAYMENT_REQUIRED and has NO payment history, only in
  * BETA_FREE with an ACTIVE grant. Idempotent: an order that is already BETA_AUTHORIZED is returned
  * as is. The order's price, quote, acceptance and scope are not modified.
  */
 async authorizeBeta(actor:Principal,operationId:ID){
  const operation=await this.store.getOperation(actor,operationId);
  const revisionId=operation.currentRevisionId;
  if(!revisionId)throw new DomainError('INVALID_STATE','Operation has no current plan revision');
  return this.store.db.transaction(async tx=>{
   const [order]=await tx.select().from(commercialOrders).where(and(eq(commercialOrders.workspaceId,actor.workspaceId),eq(commercialOrders.operationId,operationId),eq(commercialOrders.revisionId,revisionId))).for('update').limit(1);
   if(!order)throw new DomainError('INVALID_STATE','Accept a quote for the current plan revision first');
   // Idempotent: whether it still authorizes execution is reported by view() and re-decided at launch.
   if(order.state==='BETA_AUTHORIZED')return {orderId:order.id,state:order.state,alreadyAuthorized:true};
   if(order.state!=='PAYMENT_REQUIRED'||!(order.amountMinor>0))throw new DomainError('INVALID_STATE','Only an unpaid priced order can be covered by the free beta');
   const [payment]=await tx.select({id:payments.id}).from(payments).where(eq(payments.orderId,order.id)).limit(1);
   if(payment)throw new DomainError('CONFLICT','Order has payment history and cannot be converted to a beta authorization');
   const [acceptance]=await tx.select().from(quoteAcceptances).where(and(eq(quoteAcceptances.quoteId,order.quoteId),eq(quoteAcceptances.workspaceId,actor.workspaceId))).limit(1);
   if(!acceptance)throw new DomainError('INVALID_STATE','Order has no recorded terms acceptance');
   const at=this.now();
   const eligible=await this.beta.eligibleGrant(tx,actor.workspaceId,at,true);
   if('denial' in eligible)throw betaAuthorizationError(eligible.denial,null,'EXECUTION');
   const authorization=await this.beta.authorize(tx,{actorUserId:actor.userId,acceptanceId:acceptance.id,at,order:{...orderRef(order),state:'BETA_AUTHORIZED'}});
   if(!authorization)throw new DomainError('CONFLICT','Beta grant changed during authorization');
   const moved=await tx.update(commercialOrders).set({state:'BETA_AUTHORIZED',updatedAt:at.toISOString()}).where(and(eq(commercialOrders.id,order.id),eq(commercialOrders.state,'PAYMENT_REQUIRED'))).returning({id:commercialOrders.id});
   if(moved.length!==1)throw new DomainError('CONFLICT','Order changed concurrently');
   return {orderId:order.id,state:'BETA_AUTHORIZED' as const,alreadyAuthorized:false,betaAuthorizationId:authorization.id};
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
  if(!revisionId)return {operationId,revisionId:null,offers:[],quotes:[],order:orderView,executionAuthorized:false,payment:{required:false,state:orderView?.state??null},betaAuthorization:null,betaAuthorizationAvailable:false};
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
  const at=this.now(),now=at.toISOString();
  const betaAuthorization=order?await this.beta.view(this.store.db,orderRef(order),revisionId,at):null;
  let betaAuthorizationAvailable=false;
  if(order?.state==='PAYMENT_REQUIRED'&&order.amountMinor>0&&this.beta.enabled){
   const [payment]=await this.store.db.select({id:payments.id}).from(payments).where(eq(payments.orderId,order.id)).limit(1);
   betaAuthorizationAvailable=!payment&&'grantId' in await this.beta.eligibleGrant(this.store.db,actor.workspaceId,at,false);
  }
  return {
   operationId,revisionId,offers:offered,
   quotes:quoteRows.map(quote=>({id:quote.id,offerId:quote.offerId,amountMinor:quote.amountMinor,currency:quote.currency,expiresAt:quote.expiresAt,createdAt:quote.createdAt,accepted:Boolean(order&&order.quoteId===quote.id),expired:quote.expiresAt<=now})),
   order:orderView,
   executionAuthorized:Boolean(order&&(['AUTHORIZED','FULFILLING'].includes(order.state)||(order.state==='BETA_AUTHORIZED'&&betaAuthorization?.valid===true))),
   payment:{required:order?.state==='PAYMENT_REQUIRED',state:order?.state??null},
   betaAuthorization,betaAuthorizationAvailable,
  };
 }
 /**
  * Commercial precondition of a launch. `executor` is the caller's transaction when the check must be
  * atomic with the launch (the linked beta grant is then held FOR SHARE until it commits).
  */
 async assertExecutionAllowed(actor:Principal,operationId:ID,revisionId:ID,executor?:BetaTransaction):Promise<void>{
  // Inside a launch transaction the caller holds the operation row locked at the expected version, so
  // `revisionId` IS the current revision; outside, the tenant-checked operation is read first.
  const currentRevisionId=executor?revisionId:(await this.store.getOperation(actor,operationId)).currentRevisionId??null;
  const db=executor??this.store.db;
  const [order]=await db.select().from(commercialOrders).where(and(eq(commercialOrders.workspaceId,actor.workspaceId),eq(commercialOrders.operationId,operationId),eq(commercialOrders.revisionId,revisionId))).limit(1);
  if(!order)throw new DomainError('PAYMENT_REQUIRED','Accepted service scope is required');
  // MISSION A08 — an unpaid order is NOT a configuration failure. Once a payment provider can be
  // configured, "you have not paid" and "we cannot take money" are different facts and must stay
  // distinguishable; conflating them hid a real unpaid order behind a 503.
  if(order.state==='PAYMENT_REQUIRED')throw new DomainError('PAYMENT_REQUIRED','Payment is required before execution; the order is not authorized');
  if(order.state==='DISPUTED')throw new DomainError('DENIED','Order is disputed and cannot execute');
  if(order.state==='CANCELLED')throw new DomainError('DENIED','Order was cancelled');
  // A21.03 — a free-beta order executes only while its authorization still matches this exact scope and
  // revision, the mode is BETA_FREE and the linked grant is ACTIVE and unexpired.
  if(order.state==='BETA_AUTHORIZED'){
   await this.beta.assert(db,{order:orderRef(order),currentRevisionId,at:this.now(),purpose:'EXECUTION',lockGrant:Boolean(executor)});
   return;
  }
  if(!['AUTHORIZED','FULFILLING'].includes(order.state))throw new DomainError('DENIED','Order is not authorized for execution');
 }
 /**
  * A21.03 — retry and redo re-launch work without the start-time commerce check (A21.02 behaviour,
  * unchanged for paid and free orders). A free-beta order must still be covered by a valid beta
  * authorization, so it is re-verified here inside the re-launch transaction. Other orders: no-op.
  */
 async assertBetaContinuation(tx:BetaTransaction,actor:Principal,operationId:ID,revisionId:ID):Promise<void>{
  const [order]=await tx.select().from(commercialOrders).where(and(eq(commercialOrders.workspaceId,actor.workspaceId),eq(commercialOrders.operationId,operationId),eq(commercialOrders.revisionId,revisionId))).limit(1);
  if(!order||!isBetaOrderState(order.state))return;
  await this.beta.assert(tx,{order:orderRef(order),currentRevisionId:revisionId,at:this.now(),purpose:'EXECUTION',lockGrant:true});
 }
}
