import { createHash } from 'node:crypto';
import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,artifactObjects,resultDocuments } from '@qeynox/persistence';
import { exportHtml,exportJson,type ResultDocument } from './result-document';
export interface ObjectReceipt {key:string;versionId?:string;sha256:string;size:number}
export interface ObjectHead {sha256?:string;size?:number}
export interface ArtifactStorePort {
 put(key:string,content:Uint8Array,contentType:string):Promise<ObjectReceipt>;
 head(key:string):Promise<ObjectHead|undefined>;
 signedRead(key:string,expiresSeconds:number):Promise<string>;
}
export interface ReconciliationResult {
 readonly recovered:readonly ID[];
 readonly pending:readonly ID[];
 readonly conflicts:readonly ID[];
}
const sha256Of=(content:Uint8Array)=>createHash('sha256').update(content).digest('hex');
export class ArtifactDelivery {
 constructor(private readonly store:QeyNoxStore,private readonly objects:ArtifactStorePort){}
 async save(actor:Principal,doc:ResultDocument,format:'json'|'html',content:Uint8Array):Promise<{artifactId:ID;sha256:string}>{
  const op=await this.store.getOperation(actor,doc.operationId);
  if(doc.workspaceId!==actor.workspaceId||!doc.id||op.currentRevisionId!==doc.revisionId)throw new DomainError('DENIED','Document does not belong to workspace/active revision');
  if(content.byteLength>10_000_000)throw new DomainError('INVALID_INPUT','Artifact exceeds size policy');
  const id=newId(),key='workspaces/'+actor.workspaceId+'/operations/'+doc.operationId+'/results/'+doc.id+'/'+id+'.'+format;
  const type=format==='json'?'application/json':'text/html';
  const sha256=sha256Of(content);
  await this.store.db.insert(artifactObjects).values({id,documentId:doc.id,workspaceId:actor.workspaceId,operationId:doc.operationId,key,sha256,contentType:type,size:content.byteLength,state:'PENDING_UPLOAD',createdAt:new Date().toISOString()});
  const receipt=await this.objects.put(key,content,type);
  if(receipt.sha256!==sha256)throw new DomainError('CONFLICT','Artifact content digest mismatch');
  await this.store.db.update(artifactObjects).set({state:'AVAILABLE',versionId:receipt.versionId}).where(and(eq(artifactObjects.id,id),eq(artifactObjects.workspaceId,actor.workspaceId)));
  return {artifactId:id,sha256};
 }
 /**
  * Safe reconciliation of PENDING_UPLOAD artifacts: only deterministic re-exports whose digest
  * still matches the recorded metadata are uploaded. An object that already exists with a
  * mismatching digest is a conflict and is never overwritten; storage errors leave the row
  * pending for a later safe retry.
  */
 async reconcilePending(actor:Principal,operationId:ID):Promise<ReconciliationResult>{
  await this.store.getOperation(actor,operationId);
  const rows=await this.store.db.select().from(artifactObjects).where(and(eq(artifactObjects.workspaceId,actor.workspaceId),eq(artifactObjects.operationId,operationId),eq(artifactObjects.state,'PENDING_UPLOAD')));
  const recovered:ID[]=[],pending:ID[]=[],conflicts:ID[]=[];
  for(const row of rows){
    const [documentRow]=await this.store.db.select().from(resultDocuments).where(and(eq(resultDocuments.id,row.documentId),eq(resultDocuments.workspaceId,actor.workspaceId),eq(resultDocuments.operationId,operationId))).limit(1);
    if(!documentRow){conflicts.push(row.id as ID);continue;}
    const format=row.contentType==='application/json'?'json':row.contentType==='text/html'?'html':undefined;
    if(!format){conflicts.push(row.id as ID);continue;}
    const content=format==='json'?exportJson(documentRow.document as unknown as ResultDocument):exportHtml(documentRow.document as unknown as ResultDocument);
    if(content.byteLength>10_000_000||sha256Of(content)!==row.sha256){conflicts.push(row.id as ID);continue;}
    try {
      const existing=await this.objects.head(row.key);
      if(existing){
        if(!existing.sha256||existing.sha256.toLowerCase()!==row.sha256.toLowerCase()){conflicts.push(row.id as ID);continue;}
        const updated=await this.store.db.update(artifactObjects).set({state:'AVAILABLE'}).where(and(eq(artifactObjects.id,row.id),eq(artifactObjects.workspaceId,actor.workspaceId),eq(artifactObjects.state,'PENDING_UPLOAD'))).returning({id:artifactObjects.id});
        if(updated.length)recovered.push(row.id as ID);else pending.push(row.id as ID);
        continue;
      }
      const receipt=await this.objects.put(row.key,content,row.contentType);
      if(receipt.sha256.toLowerCase()!==row.sha256.toLowerCase()){conflicts.push(row.id as ID);continue;}
      const updated=await this.store.db.update(artifactObjects).set({state:'AVAILABLE',versionId:receipt.versionId}).where(and(eq(artifactObjects.id,row.id),eq(artifactObjects.workspaceId,actor.workspaceId),eq(artifactObjects.state,'PENDING_UPLOAD'))).returning({id:artifactObjects.id});
      if(updated.length)recovered.push(row.id as ID);else pending.push(row.id as ID);
    } catch {
      pending.push(row.id as ID);
    }
  }
  return {recovered,pending,conflicts};
 }
 async readGrant(actor:Principal,operationId:ID,documentId:ID,artifactId:ID):Promise<string>{
  await this.store.getOperation(actor,operationId);
  const [row]=await this.store.db.select().from(artifactObjects).where(and(eq(artifactObjects.id,artifactId),eq(artifactObjects.documentId,documentId),eq(artifactObjects.workspaceId,actor.workspaceId),eq(artifactObjects.operationId,operationId),eq(artifactObjects.state,'AVAILABLE'))).limit(1);
  if(!row)throw new DomainError('NOT_FOUND','Artifact unavailable');
  return this.objects.signedRead(row.key,180);
 }
}
