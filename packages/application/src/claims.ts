import { and,desc,eq,inArray } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal,type Evidence,type Source } from '@qeynox/domain';
import { QeyNoxStore,claims,claimEvidenceLinks,claimAssessments,verificationPolicies,sources,evidences,type ClaimStatus } from '@qeynox/persistence';
export interface NewClaim {operationId:ID;attemptId:ID;statement:string;kind:string;profileId?:ID;profileVersion?:number}
export interface ClaimAssessmentInput {claimId:ID;capabilityId:ID;policyVersion:number;reason:string;reviewerDecision?:'SUPPORTED'|'DISPROVEN'|'CONFLICTING'}
type EvidenceRow = {id:string;payload:Evidence};
type SourceRow = {id:string;payload:Source};
interface EvaluatedLink { sourceId:string; evidenceId:string; qualified:boolean; stale:boolean; reason:string }

const publishUnknownNote = 'publication freshness unknown';
/**
 * Policy evaluation is structural evidence linkage, not a semantic truth proof:
 * - a support link must reference the exact captured provider response digest,
 * - both the source and the linked evidence must be tenant/operation-scoped,
 * - the provider must be approved and the retrieval/publication ages within policy,
 * - contradictions with qualifying evidence block promotion.
 * Human review remains required for policies that demand it.
 */
export class ClaimsService {
 constructor(private readonly store:QeyNoxStore){}
 async register(actor:Principal,input:NewClaim){
  await this.store.getOperation(actor,input.operationId);
  const attempt=await this.store.getAttempt(input.attemptId);
  if(!attempt||attempt.operationId!==input.operationId)throw new DomainError('DENIED','Claim attempt mismatch');
  if(!input.statement.trim()||input.statement.length>10000)throw new DomainError('INVALID_INPUT','Claim statement invalid');
  if(!input.kind.trim()||input.kind.length>120)throw new DomainError('INVALID_INPUT','Claim kind invalid');
  const value={id:newId(),workspaceId:actor.workspaceId,operationId:input.operationId,attemptId:input.attemptId,statement:input.statement,kind:input.kind,status:'UNVERIFIED' as ClaimStatus,createdAt:new Date().toISOString(),profileId:input.profileId,profileVersion:input.profileVersion};
  await this.store.db.insert(claims).values(value);
  return value;
 }
 async attach(actor:Principal,claimId:ID,sourceId:ID,relationship:'SUPPORTS'|'CONTRADICTS',evidenceId?:ID,observationDigest?:string){
  const claim=await this.get(actor,claimId);
  const [source]=await this.store.db.select().from(sources).where(and(eq(sources.id,sourceId),eq(sources.workspaceId,actor.workspaceId),eq(sources.operationId,claim.operationId))).limit(1);
  if(!source)throw new DomainError('DENIED','Source belongs to another operation or workspace');
  if(!evidenceId)throw new DomainError('INVALID_INPUT','Evidence ID is required to link a provider observation');
  if(!observationDigest||!/^[a-f0-9]{64}$/i.test(observationDigest))throw new DomainError('INVALID_INPUT','Exact captured response digest is required for evidence linkage');
  const [evidence]=await this.store.db.select().from(evidences).where(and(eq(evidences.id,evidenceId),eq(evidences.operationId,claim.operationId))).limit(1);
  if(!evidence)throw new DomainError('NOT_FOUND','Evidence observation unavailable');
  const evidencePayload=evidence.payload as Evidence;
  if(evidencePayload.sourceId!==sourceId)throw new DomainError('INVALID_INPUT','Evidence observation does not belong to the linked source');
  const fingerprint=source.payload.fingerprint;
  if(!fingerprint)throw new DomainError('INVALID_STATE','Captured source has no response digest');
  if(observationDigest.toLowerCase()!==fingerprint.toLowerCase())throw new DomainError('INVALID_INPUT','Evidence digest does not match the captured provider response');
  if(relationship==='SUPPORTS'&&(evidencePayload.status==='DISPUTED'||evidencePayload.status==='STALE'))throw new DomainError('INVALID_STATE','A disputed or stale observation cannot support a claim');
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
 /** Resolves the claim's own capability and active policy, then evaluates it. */
 async assessActive(actor:Principal,claimId:ID,review?:{reviewerDecision?:'SUPPORTED'|'DISPROVEN'|'CONFLICTING';reason?:string}){
  const claim=await this.get(actor,claimId);
  const attempt=await this.store.getAttempt(claim.attemptId as ID);
  if(!attempt||attempt.operationId!==claim.operationId)throw new DomainError('DENIED','Claim attempt no longer belongs to its operation');
  const steps=await this.store.getSteps(attempt.planRevisionId);
  const step=steps.find(candidate=>candidate.id===attempt.workStepId);
  if(!step)throw new DomainError('NOT_FOUND','Claim step unavailable');
  const [policy]=await this.store.db.select().from(verificationPolicies).where(and(eq(verificationPolicies.capabilityId,step.capabilityId),eq(verificationPolicies.status,'ACTIVE'))).orderBy(desc(verificationPolicies.version)).limit(1);
  if(!policy)throw new DomainError('NOT_CONFIGURED','Active capability verification policy unavailable');
  if(review?.reviewerDecision&&(!review.reason||review.reason.trim().length<5))throw new DomainError('INVALID_INPUT','Review rationale required');
  return this.assess(actor,{claimId:claim.id as ID,capabilityId:step.capabilityId,policyVersion:policy.version,reason:review?.reason??'policy evaluation',reviewerDecision:review?.reviewerDecision});
 }
 async assess(actor:Principal,input:ClaimAssessmentInput){
  const claim=await this.get(actor,input.claimId);
  const now=Date.now();
  const [policy]=await this.store.db.select().from(verificationPolicies).where(and(eq(verificationPolicies.capabilityId,input.capabilityId),eq(verificationPolicies.version,input.policyVersion),eq(verificationPolicies.status,'ACTIVE'))).limit(1);
  if(!policy)throw new DomainError('NOT_CONFIGURED','Active capability verification policy unavailable');
  const validFrom=Date.parse(policy.validFrom);
  if(!Number.isFinite(validFrom)||validFrom>now)throw new DomainError('NOT_CONFIGURED','Verification policy is not yet effective');
  // A claim can only be assessed against the capability that actually produced its step.
  const attempt=await this.store.getAttempt(claim.attemptId as ID);
  if(!attempt||attempt.operationId!==claim.operationId)throw new DomainError('DENIED','Claim attempt no longer belongs to its operation');
  const steps=await this.store.getSteps(attempt.planRevisionId);
  const step=steps.find(candidate=>candidate.id===attempt.workStepId);
  if(!step||step.capabilityId!==input.capabilityId)throw new DomainError('DENIED','Verification capability does not match the claim step');
  const links=await this.store.db.select().from(claimEvidenceLinks).where(eq(claimEvidenceLinks.claimId,claim.id));
  const sourceIds=[...new Set(links.map(link=>link.sourceId))];
  const sourceRows:SourceRow[]=sourceIds.length?(await this.store.db.select().from(sources).where(and(eq(sources.workspaceId,actor.workspaceId),eq(sources.operationId,claim.operationId),inArray(sources.id,sourceIds)))).map(row=>({id:row.id,payload:row.payload as Source})):[];
  const evidenceIds=[...new Set(links.map(link=>link.evidenceId).filter((value):value is string=>typeof value==='string'))];
  const evidenceRows:EvidenceRow[]=evidenceIds.length?(await this.store.db.select().from(evidences).where(and(eq(evidences.operationId,claim.operationId),inArray(evidences.id,evidenceIds)))).map(row=>({id:row.id,payload:row.payload as Evidence})):[];
  const sourceById=new Map(sourceRows.map(row=>[row.id,row.payload]));
  const evidenceById=new Map(evidenceRows.map(row=>[row.id,row.payload]));
  const approvedProviders=new Set(policy.approvedProviders as readonly string[]);
  const staleIds=new Set<string>();
  const unknownPublicationSources=new Set<string>();
  const eligibleSource=(source:Source|undefined,sourceId:string):{eligible:boolean;hasUnknownPublication:boolean}=>{
   if(!source)return {eligible:false,hasUnknownPublication:false};
   if(!approvedProviders.has(source.provider))return {eligible:false,hasUnknownPublication:false};
   if(!source.uri||!/^https?:\/\//i.test(source.uri))return {eligible:false,hasUnknownPublication:false};
   const retrieved=Date.parse(source.retrievedAt);
   if(!Number.isFinite(retrieved)||retrieved>now+300_000||now-retrieved>policy.maxAgeDays*86_400_000){staleIds.add(sourceId);return {eligible:false,hasUnknownPublication:false};}
   let hasUnknownPublication=false;
   if(source.sourcePublishedAt){
     const published=Date.parse(source.sourcePublishedAt);
     if(!Number.isFinite(published)||now-published>policy.maxAgeDays*86_400_000){staleIds.add(sourceId);return {eligible:false,hasUnknownPublication:false};}
   } else hasUnknownPublication=true;
   return {eligible:true,hasUnknownPublication};
  };
  const evaluate=(relationship:'SUPPORTS'|'CONTRADICTS'):EvaluatedLink[]=>{
   const result:EvaluatedLink[]=[];
   for(const link of links){
     if(link.relationship!==relationship)continue;
     const source=sourceById.get(link.sourceId);
     const eligibility=eligibleSource(source,link.sourceId);
     if(eligibility.hasUnknownPublication)unknownPublicationSources.add(link.sourceId);
     const evidenceId=link.evidenceId??'';
     const evidence=evidenceById.get(evidenceId);
     const digestMatches=Boolean(link.observationDigest&&source?.fingerprint&&link.observationDigest.toLowerCase()===source.fingerprint.toLowerCase());
     const evidenceMatches=Boolean(evidence&&evidence.sourceId===link.sourceId&&digestMatches&&evidence.status!=='DISPUTED'&&evidence.status!=='STALE');
     result.push({sourceId:link.sourceId,evidenceId,qualified:eligibility.eligible&&evidenceMatches,stale:staleIds.has(link.sourceId),reason:!eligibility.eligible?'source-not-eligible':!evidenceMatches?'evidence-link-invalid':'ok'});
   }
   return result;
  };
  const supports=evaluate('SUPPORTS');
  const contradictions=evaluate('CONTRADICTS');
  const qualifyingSupports=supports.filter(link=>link.qualified);
  const qualifyingContradictions=contradictions.filter(link=>link.qualified);
  const distinctSupportSources=new Set(qualifyingSupports.map(link=>link.sourceId));
  const distinctSupportEvidence=new Set(qualifyingSupports.map(link=>link.evidenceId));
  const enoughSources=distinctSupportSources.size>=policy.minimumSources&&distinctSupportEvidence.size>=policy.minimumSources;
  const relatedSources=sourceById.size;
  let status:ClaimStatus='UNVERIFIED';
  if(qualifyingContradictions.length)status='CONFLICTING';
  else if(enoughSources)status=policy.humanReviewRequired==='true'?'NEEDS_HUMAN_REVIEW':'SUPPORTED';
  else if(relatedSources>0&&links.length>0&&supports.every(link=>link.stale)&&contradictions.every(link=>link.stale))status='STALE';
  const privileged=actor.roles.some(role=>['OWNER','ADMIN','REVIEWER'].includes(role));
  if(input.reviewerDecision){
   if(!privileged)throw new DomainError('DENIED','Review requires elevated workspace role');
   if(input.reason.trim().length<5)throw new DomainError('INVALID_INPUT','Review rationale required');
   if(input.reviewerDecision==='SUPPORTED'){
     if(!enoughSources)throw new DomainError('INVALID_STATE','Evidence-backed sources are insufficient');
     if(qualifyingContradictions.length)throw new DomainError('INVALID_STATE','Contradicting evidence must be resolved first');
   }
   status=input.reviewerDecision;
  }
  const rationale='Policy v'+policy.version+': '+distinctSupportSources.size+'/'+policy.minimumSources+' evidence-backed sources, '+
   qualifyingContradictions.length+' qualifying contradictions, '+staleIds.size+' stale sources, '+
   (unknownPublicationSources.size?unknownPublicationSources.size+' sources with '+publishUnknownNote:'publication freshness recorded')+
   (input.reviewerDecision?'; human review: '+input.reason.trim():'')+
   (supports.length+contradictions.length-distinctSupportSources.size-qualifyingContradictions.length>0?' some links were ineligible/legacy':'');
  const assessment={id:newId(),claimId:claim.id,policyId:policy.id,status,method:input.reviewerDecision?'HUMAN_REVIEW':'POLICY_EVALUATION',actorId:input.reviewerDecision?actor.userId:undefined,rationale,sourceIds:[...distinctSupportSources],assessedAt:new Date().toISOString()};
  await this.store.db.transaction(async tx=>{
    await tx.insert(claimAssessments).values(assessment);
    await tx.update(claims).set({status}).where(and(eq(claims.id,claim.id),eq(claims.workspaceId,actor.workspaceId)));
  });
  return assessment;
 }
}

