import { and,eq,desc,inArray } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,resultDocuments,claims,claimEvidenceLinks,attempts,sources,type DocumentState } from '@qeynox/persistence';
import type { Source } from '@qeynox/domain';
import { readBusinessPackResult,type ResultBusinessPack } from './business-pack-execution';
export interface ResultCitation {
  sourceId:string;provider:string;uri?:string;retrievedAt:string;publishedAt?:string;fingerprint?:string;
}
export interface ResultFinding {
  claimId:ID;statement:string;status:string;sourceIds:readonly string[];attemptId:ID;limitations:readonly string[];
  citations:readonly ResultCitation[];
}
export interface ResultDocument {
  id:ID;workspaceId:ID;operationId:ID;revisionId:ID;version:number;
  title:string;objective:string;scope:readonly string[];findings:readonly ResultFinding[];
  nextActions:readonly string[];limitations:readonly string[];unresolved:readonly string[];
  citations:readonly ResultCitation[];
  createdAt:string;status:DocumentState;priorId?:ID;reviewedBy?:string;reviewedAt?:string;
  /** P09: the agent's analytical synthesis from a validated business-pack deliverable. Never a finding, never evidence. */
  interpretations?:readonly string[];
  /** P09: identity of the validated business-pack deliverable this document was assembled from. */
  businessPack?:ResultBusinessPack;
}
export class ResultAssembler {
 constructor(private readonly store:QeyNoxStore){}
 async assemble(actor:Principal,operationId:ID,revisionId:ID,title:string,scope:readonly string[],nextActions:readonly string[]){
  const op=await this.store.getOperation(actor,operationId);
  if(op.currentRevisionId!==revisionId)throw new DomainError('CONFLICT','Cannot publish an older plan revision');
  const rowsAll=await this.store.db.select().from(claims).where(and(eq(claims.workspaceId,actor.workspaceId),eq(claims.operationId,operationId)));
  const attemptIds=new Set((await this.store.db.select().from(attempts).where(eq(attempts.revisionId,revisionId))).map(a=>a.id));
  // P09: a business-pack result is assembled ONLY from its validated deliverable (re-validated here) and
  // the domain claims of the attempt that produced it. A pack mission without one throws; generic
  // missions get null and keep the generic assembly.
  const pack=await readBusinessPackResult(this.store,actor,operationId,revisionId);
  const rows=rowsAll.filter(row=>attemptIds.has(row.attemptId)&&(!pack||row.attemptId===pack.identity.attemptId));
  const claimIds=rows.map(row=>row.id);
  const links=claimIds.length?await this.store.db.select().from(claimEvidenceLinks).where(inArray(claimEvidenceLinks.claimId,claimIds)):[];
  const linksByClaim=new Map<string,typeof links>();
  for(const link of links){const list=linksByClaim.get(link.claimId)??[];list.push(link);linksByClaim.set(link.claimId,list);}
  const sourceIds=[...new Set(links.map(link=>link.sourceId))];
  const sourceRows=sourceIds.length?await this.store.db.select().from(sources).where(and(eq(sources.workspaceId,actor.workspaceId),eq(sources.operationId,operationId),inArray(sources.id,sourceIds))):[];
  const sourceById=new Map(sourceRows.map(row=>[row.id,row.payload as Source]));
  const findings:ResultFinding[]=[];
  for(const row of rows){
    const claimLinks=linksByClaim.get(row.id)??[];
    const citations:ResultCitation[]=claimLinks.map(link=>{
      const source=sourceById.get(link.sourceId);
      return {
        sourceId:link.sourceId,provider:source?.provider??'unknown',uri:source?.uri,
        retrievedAt:source?.retrievedAt??'',publishedAt:source?.sourcePublishedAt,
        fingerprint:source?.fingerprint,
      };
    });
    findings.push({claimId:row.id as ID,statement:row.statement,status:row.status,sourceIds:[...new Set(claimLinks.map(link=>link.sourceId))],attemptId:row.attemptId as ID,limitations:row.status==='SUPPORTED'?[]:['Claim requires further verification'],citations});
  }
  const citationBySource=new Map<string,ResultCitation>();
  for(const finding of findings)for(const citation of finding.citations)if(!citationBySource.has(citation.sourceId))citationBySource.set(citation.sourceId,citation);
  const citations=[...citationBySource.values()];
  // A SUPPORTED claim without a verifiable http(s) citation remains unresolved for DELIVERABLE purposes.
  const unresolved=findings.filter(f=>f.status!=='SUPPORTED'||!f.citations.some(c=>Boolean(c.uri&&/^https?:\/\//i.test(c.uri)))).map(f=>f.claimId);
  const state:DocumentState=!findings.length?'DRAFT':unresolved.length?'PARTIAL':'READY_FOR_REVIEW';
  const old=(await this.store.db.select().from(resultDocuments).where(and(eq(resultDocuments.operationId,operationId),eq(resultDocuments.workspaceId,actor.workspaceId))).orderBy(desc(resultDocuments.version)).limit(1))[0];
  const now=new Date().toISOString();
  const evidenceLimitations=unresolved.length?['Some claims are unverified or lack a verifiable citation']:[];
  const result:ResultDocument={id:newId(),workspaceId:actor.workspaceId,operationId,revisionId,version:(old?.version??0)+1,
   title:pack?pack.projection.title:title,objective:op.title,scope:pack?[...pack.projection.scope]:scope,findings,
   nextActions:pack?[...pack.projection.nextActions]:nextActions,
   limitations:pack?[...pack.projection.limitations,...evidenceLimitations]:evidenceLimitations,
   unresolved,citations,createdAt:now,status:state,priorId:old?.id as ID|undefined,
   ...(pack?{interpretations:[...pack.projection.analyticalStatements],businessPack:pack.identity}:{})};
  await this.store.db.insert(resultDocuments).values({id:result.id,workspaceId:result.workspaceId,operationId,revisionId,version:result.version,state,document:result as unknown as Record<string,unknown>,createdAt:result.createdAt,supersedesId:result.priorId});
  return result;
 }
 /** Re-assembles the review version after claim re-assessment; history is preserved by version. */
 async reassemble(actor:Principal,operationId:ID){
  const op=await this.store.getOperation(actor,operationId);
  if(!op.currentRevisionId)throw new DomainError('INVALID_STATE','No plan revision to assemble');
  if(op.status!=='WAITING_APPROVAL')throw new DomainError('INVALID_STATE','Result review is not open');
  const steps=await this.store.getSteps(op.currentRevisionId);
  return this.assemble(actor,operationId,op.currentRevisionId,op.title,steps.map(step=>step.title),[]);
 }
 async list(actor:Principal,operationId:ID){
  await this.store.getOperation(actor,operationId);
  return (await this.store.db.select().from(resultDocuments).where(and(eq(resultDocuments.workspaceId,actor.workspaceId),eq(resultDocuments.operationId,operationId))).orderBy(desc(resultDocuments.version))).map(r=>r.document as unknown as ResultDocument);
 }
 async get(actor:Principal,operationId:ID,documentId:ID):Promise<ResultDocument>{
  await this.store.getOperation(actor,operationId);
  const [row]=await this.store.db.select().from(resultDocuments).where(and(eq(resultDocuments.id,documentId),eq(resultDocuments.workspaceId,actor.workspaceId),eq(resultDocuments.operationId,operationId))).limit(1);
  if(!row)throw new DomainError('NOT_FOUND','Result version unavailable');
  return row.document as unknown as ResultDocument;
 }
}
