import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { and,eq,desc } from 'drizzle-orm';
import { QeyNoxStore,resultDocuments,claims,claimEvidenceLinks,artifactObjects,type DocumentState } from '@qeynox/persistence';
export interface ResultFinding {
 claimId:ID;statement:string;status:string;sourceIds:readonly string[];attemptId:ID;limitations:readonly string[];
}
export interface ResultDocument {
 id:ID;workspaceId:ID;operationId:ID;revisionId:ID;version:number;
 title:string;objective:string;scope:readonly string[];findings:readonly ResultFinding[];
 nextActions:readonly string[];limitations:readonly string[];unresolved:readonly string[];
 createdAt:string;status:DocumentState;priorId?:ID;
}
export class ResultAssembler {
 constructor(private readonly store:QeyNoxStore){}
 async assemble(actor:Principal,operationId:ID,revisionId:ID,title:string,scope:readonly string[],nextActions:readonly string[]){
  const op=await this.store.getOperation(actor,operationId);
  if(op.currentRevisionId!==revisionId)throw new DomainError('CONFLICT','Cannot publish an older plan revision');
  const rows=await this.store.db.select().from(claims).where(and(eq(claims.workspaceId,actor.workspaceId),eq(claims.operationId,operationId)));
  const findings:ResultFinding[]=[];
  for(const row of rows){
    const links=await this.store.db.select().from(claimEvidenceLinks).where(eq(claimEvidenceLinks.claimId,row.id));
    findings.push({claimId:row.id as ID,statement:row.statement,status:row.status,sourceIds:links.map(l=>l.sourceId),attemptId:row.attemptId as ID,limitations:row.status==='SUPPORTED'?[]:['Claim requires further verification']});
  }
  const unresolved=findings.filter(f=>f.status!=='SUPPORTED').map(f=>f.claimId);
  const state:DocumentState=!findings.length?'DRAFT':unresolved.length?'PARTIAL':'READY_FOR_REVIEW';
  const old=(await this.store.db.select().from(resultDocuments).where(and(eq(resultDocuments.operationId,operationId),eq(resultDocuments.workspaceId,actor.workspaceId))).orderBy(desc(resultDocuments.version)).limit(1))[0];
  const result:ResultDocument={id:newId(),workspaceId:actor.workspaceId,operationId,revisionId,version:(old?.version??0)+1,title,objective:op.title,scope,findings,nextActions,limitations:unresolved.length?['Some claims remain unsupported or stale']:[],unresolved,createdAt:new Date().toISOString(),status:state,priorId:old?.id as ID|undefined};
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
export const exportJson=(doc:ResultDocument):Uint8Array=>Buffer.from(JSON.stringify(doc,null,2),'utf8');
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function exportHtml(doc:ResultDocument):Uint8Array {
 const find=doc.findings.map(f=>'<li><h2>'+escapeHtml(f.statement)+'</h2><p>Status: '+escapeHtml(f.status)+'</p><p>Sources: '+escapeHtml(f.sourceIds.join(', '))+'</p></li>').join('');
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+escapeHtml(doc.title)+'</title></head><body><main><h1>'+escapeHtml(doc.title)+'</h1><p>'+escapeHtml(doc.objective)+'</p><ul>'+find+'</ul><h2>Limits</h2><p>'+escapeHtml(doc.limitations.join('; '))+'</p></main></body></html>';
 return Buffer.from(html,'utf8');
}
