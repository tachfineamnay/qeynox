import { createHash } from 'node:crypto';
import { and,eq } from 'drizzle-orm';
import { DomainError,newId,type ID,type Principal } from '@qeynox/domain';
import { QeyNoxStore,artifactObjects } from '@qeynox/persistence';
import type { ResultDocument } from './result-document';
export interface ObjectReceipt {key:string;versionId?:string;sha256:string;size:number}
export interface ArtifactStorePort {
 put(key:string,content:Uint8Array,contentType:string):Promise<ObjectReceipt>;
 signedRead(key:string,expiresSeconds:number):Promise<string>;
}
export class ArtifactDelivery {
 constructor(private readonly store:QeyNoxStore,private readonly objects:ArtifactStorePort){}
 async save(actor:Principal,doc:ResultDocument,format:'json'|'html',content:Uint8Array):Promise<{artifactId:ID;sha256:string}>{
  const op=await this.store.getOperation(actor,doc.operationId);
  if(doc.workspaceId!==actor.workspaceId||!doc.id||op.currentRevisionId!==doc.revisionId)throw new DomainError('DENIED','Document does not belong to workspace/active revision');
  if(content.byteLength>10_000_000)throw new DomainError('INVALID_INPUT','Artifact exceeds size policy');
  const id=newId(),key='workspaces/'+actor.workspaceId+'/operations/'+doc.operationId+'/results/'+doc.id+'/'+id+'.'+format;
  const type=format==='json'?'application/json':'text/html';
  const sha256=createHash('sha256').update(content).digest('hex');
  await this.store.db.insert(artifactObjects).values({id,documentId:doc.id,workspaceId:actor.workspaceId,operationId:doc.operationId,key,sha256,contentType:type,size:content.byteLength,state:'PENDING_UPLOAD',createdAt:new Date().toISOString()});
  const receipt=await this.objects.put(key,content,type);
  if(receipt.sha256!==sha256)throw new DomainError('CONFLICT','Artifact content digest mismatch');
  await this.store.db.update(artifactObjects).set({state:'AVAILABLE',versionId:receipt.versionId}).where(and(eq(artifactObjects.id,id),eq(artifactObjects.workspaceId,actor.workspaceId)));
  return {artifactId:id,sha256};
 }
 async readGrant(actor:Principal,operationId:ID,documentId:ID,artifactId:ID):Promise<string>{
  await this.store.getOperation(actor,operationId);
  const [row]=await this.store.db.select().from(artifactObjects).where(and(eq(artifactObjects.id,artifactId),eq(artifactObjects.documentId,documentId),eq(artifactObjects.workspaceId,actor.workspaceId),eq(artifactObjects.operationId,operationId),eq(artifactObjects.state,'AVAILABLE'))).limit(1);
  if(!row)throw new DomainError('NOT_FOUND','Artifact unavailable');
  return this.objects.signedRead(row.key,180);
 }
}
