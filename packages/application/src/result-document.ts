import { and,eq,desc,inArray } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,resultDocuments,claims,claimEvidenceLinks,attempts,sources,type DocumentState } from '@qeynox/persistence';
import type { Source } from '@qeynox/domain';
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
}
export class ResultAssembler {
 constructor(private readonly store:QeyNoxStore){}
 async assemble(actor:Principal,operationId:ID,revisionId:ID,title:string,scope:readonly string[],nextActions:readonly string[]){
  const op=await this.store.getOperation(actor,operationId);
  if(op.currentRevisionId!==revisionId)throw new DomainError('CONFLICT','Cannot publish an older plan revision');
  const rowsAll=await this.store.db.select().from(claims).where(and(eq(claims.workspaceId,actor.workspaceId),eq(claims.operationId,operationId)));
  const attemptIds=new Set((await this.store.db.select().from(attempts).where(eq(attempts.revisionId,revisionId))).map(a=>a.id));
  const rows=rowsAll.filter(row=>attemptIds.has(row.attemptId));
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
  const result:ResultDocument={id:newId(),workspaceId:actor.workspaceId,operationId,revisionId,version:(old?.version??0)+1,title,objective:op.title,scope,findings,nextActions,limitations:unresolved.length?['Some claims are unverified or lack a verifiable citation']:[],unresolved,citations,createdAt:now,status:state,priorId:old?.id as ID|undefined};
  await this.store.db.insert(resultDocuments).values({id:result.id,workspaceId:result.workspaceId,operationId,revisionId,version:result.version,state,document:result as unknown as Record<string,unknown>,createdAt:result.createdAt,supersedesId:result.priorId});
  return result;
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
function canonicalJson(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonicalJson);
 if(value&&typeof value==='object'){
  const record=value as Record<string,unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key=>[key,canonicalJson(record[key])]));
 }
 return value;
}
/** Canonical key ordering makes JSON exports byte-stable across storage round-trips and reconciliation. */
export const exportJson=(doc:ResultDocument):Uint8Array=>Buffer.from(JSON.stringify(canonicalJson(doc),null,2),'utf8');
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function citationHtml(citations:readonly ResultCitation[]):string{
 return citations.map(citation=>{
  const source=citation.uri&&/^https?:\/\//i.test(citation.uri)
   ?'<a href="'+escapeHtml(citation.uri)+'" rel="noopener noreferrer">'+escapeHtml(citation.uri)+'</a>'
   :'<span>'+escapeHtml(citation.uri??'no citation URI')+'</span>';
  return '<li>'+escapeHtml(citation.provider)+' — '+source+
   '<br>retrieved '+escapeHtml(citation.retrievedAt)+
   (citation.publishedAt?'; published '+escapeHtml(citation.publishedAt):'; publication freshness unknown')+
   (citation.fingerprint?'; response digest '+escapeHtml(citation.fingerprint):'')+'</li>';
 }).join('');
}
export function exportHtml(doc:ResultDocument):Uint8Array {
 const find=doc.findings.map(f=>'<li><h2>'+escapeHtml(f.statement)+'</h2><p>Status: '+escapeHtml(f.status)+'</p><ul>'+citationHtml(f.citations)+'</ul></li>').join('');
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+escapeHtml(doc.title)+'</title></head><body><main><h1>'+escapeHtml(doc.title)+'</h1><p>'+escapeHtml(doc.objective)+'</p><p>Document status: '+escapeHtml(doc.status)+'</p><ul>'+find+'</ul><h2>Citations</h2><ul>'+citationHtml(doc.citations)+'</ul><h2>Limits</h2><p>'+escapeHtml(doc.limitations.join('; '))+'</p></main></body></html>';
 return Buffer.from(html,'utf8');
}


