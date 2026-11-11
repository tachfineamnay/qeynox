import { and,desc,eq,inArray } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal,type Source } from '@qeynox/domain';
import { QeyNoxStore,claims,claimEvidenceLinks,claimAssessments,verificationPolicies,sources,type ClaimStatus } from '@qeynox/persistence';
export interface NewClaim {operationId:ID;attemptId:ID;statement:string;kind:string;profileId?:ID;profileVersion?:number}
export interface ClaimAssessmentInput {claimId:ID;capabilityId:ID;policyVersion:number;reason:string;reviewerDecision?:'SUPPORTED'|'DISPROVEN'|'CONFLICTING'}
export class ClaimsService {
 constructor(private readonly store:QeyNoxStore){}
 async register(actor:Principal,input:NewClaim){
  await this.store.getOperation(actor,input.operationId);
  const attempt=await this.store.getAttempt(input.attemptId);
  if(!attempt||attempt.operationId!==input.operationId)throw new DomainError('DENIED','Claim attempt mismatch');
  if(!input.statement.trim()||input.statement.length>10000)throw new DomainError('INVALID_INPUT','Claim statement invalid');
  const value={id:newId(),workspaceId:actor.workspaceId,operationId:input.operationId,attemptId:input.attemptId,statement:input.statement,kind:input.kind,status:'UNVERIFIED' as ClaimStatus,createdAt:new Date().toISOString(),profileId:input.profileId,profileVersion:input.profileVersion};
  await this.store.db.insert(claims).values(value);
  return value;
 }
 async attach(actor:Principal,claimId:ID,sourceId:ID,relationship:'SUPPORTS'|'CONTRADICTS',evidenceId?:ID,observationDigest?:string){
  const claim=await this.get(actor,claimId);
  const [source]=await this.store.db.select().from(sources).where(and(eq(sources.id,sourceId),eq(sources.workspaceId,actor.workspaceId),eq(sources.operationId,claim.operationId))).limit(1);
  if(!source)throw new DomainError('DENIED','Source belongs to another operation or workspace');
  await this.store.db.insert(claimEvidenceLinks).values({id:newId(),claimId,sourceId,evidenceId,relationship,observationDigest,addedAt:new Date().toISOString()}).onConflictDoNothing();
  return {claimId,sourceId,relationship};
 }
 async get(actor:Principal,id:ID){
  const [row]=await this.store.db.select().from(claims).where(and(eq(claims.id,id),eq(claims.workspaceId,actor.workspaceId))).limit(1);
  if(!row)throw new DomainError('NOT_FOUND','Claim unavailable');
  await this.store.getOperation(actor,row.operationId as ID);
  return row;
 }
 async list(actor:Principal,operationId:ID){
  await this.store.getOperation(actor,operationId);
  return this.store.db.select().from(claims).where(and(eq(claims.workspaceId,actor.workspaceId),eq(claims.operationId,operationId))).orderBy(desc(claims.createdAt));
 }
 async assess(actor:Principal,input:ClaimAssessmentInput){
  const claim=await this.get(actor,input.claimId);
  const [policy]=await this.store.db.select().from(verificationPolicies).where(and(eq(verificationPolicies.capabilityId,input.capabilityId),eq(verificationPolicies.version,input.policyVersion),eq(verificationPolicies.status,'ACTIVE'))).limit(1);
  if(!policy)throw new DomainError('NOT_CONFIGURED','Active capability verification policy unavailable');
  const links=await this.store.db.select().from(claimEvidenceLinks).where(eq(claimEvidenceLinks.claimId,claim.id));
  const related=links.length?await this.store.db.select().from(sources).where(and(eq(sources.workspaceId,actor.workspaceId),eq(sources.operationId,claim.operationId),inArray(sources.id,links.map(l=>l.sourceId)))):[];
  const now=Date.now();
  const valid=related.filter(r=>r.payload.uri&&policy.approvedProviders.includes(r.payload.provider)&&
    Number.isFinite(Date.parse(r.payload.retrievedAt))&&Date.parse(r.payload.retrievedAt)>=now-policy.maxAgeDays*86400000);
  const support=links.filter(l=>l.relationship==='SUPPORTS'&&valid.some(r=>r.id===l.sourceId));
  const contradicted=links.some(l=>l.relationship==='CONTRADICTS'&&related.some(r=>r.id===l.sourceId));
  const enoughSources=new Set(support.map(l=>l.sourceId)).size>=policy.minimumSources;
  const privileged=actor.roles.some(role=>['OWNER','ADMIN','REVIEWER'].includes(role));
  let status:ClaimStatus='UNVERIFIED';
  if(contradicted)status='CONFLICTING';
  else if(related.length&&!valid.length)status='STALE';
  else if(enoughSources)status=policy.humanReviewRequired==='true'?'NEEDS_HUMAN_REVIEW':'SUPPORTED';
  if(input.reviewerDecision){
    if(!privileged)throw new DomainError('DENIED','Review requires elevated workspace role');
    if(input.reviewerDecision==='SUPPORTED'&&!enoughSources)throw new DomainError('INVALID_STATE','Source evidence is insufficient');
    if(input.reviewerDecision==='SUPPORTED'&&contradicted)throw new DomainError('INVALID_STATE','Conflict requires resolution');
    status=input.reviewerDecision;
  }
  const assessment={id:newId(),claimId:claim.id,policyId:policy.id,status,method:input.reviewerDecision?'HUMAN_REVIEW':'POLICY_EVALUATION',actorId:input.reviewerDecision?actor.userId:undefined,rationale:input.reason,sourceIds:valid.map(x=>x.id),assessedAt:new Date().toISOString()};
  await this.store.db.transaction(async tx=>{
    await tx.insert(claimAssessments).values(assessment);
    await tx.update(claims).set({status}).where(and(eq(claims.id,claim.id),eq(claims.workspaceId,actor.workspaceId)));
  });
  return assessment;
 }
}
