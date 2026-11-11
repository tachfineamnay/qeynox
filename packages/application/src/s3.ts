import { createHash } from 'node:crypto';
import { GetObjectCommand,HeadObjectCommand,PutObjectCommand,S3Client,type PutObjectCommandInput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '@qeynox/domain';
import type { ArtifactStorePort,ObjectHead,ObjectReceipt } from './artifacts';
export interface S3ArtifactStoreOptions {
 endpoint?:string;region:string;accessKeyId:string;secretAccessKey:string;
 /** SSE-S3 is the production default; S3-compatible stores without KMS/SSE support may opt out. */
 serverSideEncryption?:'AES256'|false;
}
export class S3ArtifactStore implements ArtifactStorePort {
 private readonly client:S3Client;
 private readonly encryption:'AES256'|false;
 constructor(private readonly bucket:string,options:S3ArtifactStoreOptions){
  if(!bucket||!options.region||!options.accessKeyId||!options.secretAccessKey)throw new DomainError('NOT_CONFIGURED','Private S3 credentials and bucket are required');
  this.encryption=options.serverSideEncryption??'AES256';
  this.client=new S3Client({region:options.region,endpoint:options.endpoint,forcePathStyle:Boolean(options.endpoint),credentials:{accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey}});
 }
 async put(key:string,body:Uint8Array,contentType:string):Promise<ObjectReceipt>{
  const sha256=createHash('sha256').update(body).digest('hex');
  const input:PutObjectCommandInput={Bucket:this.bucket,Key:key,Body:body,ContentType:contentType,IfNoneMatch:'*',Metadata:{sha256}};
  if(this.encryption)input.ServerSideEncryption=this.encryption;
  const response=await this.client.send(new PutObjectCommand(input));
  return {key,versionId:response.VersionId,sha256,size:body.byteLength};
 }
 async head(key:string):Promise<ObjectHead|undefined>{
  try {
   const response=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}));
   return {sha256:typeof response.Metadata?.sha256==='string'?response.Metadata.sha256:undefined,size:response.ContentLength};
  } catch(error:unknown) {
   const status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;
   const name=(error as {name?:string}).name;
   if(status===404||name==='NotFound'||name==='NoSuchKey')return undefined;
   throw error;
  }
 }
 signedRead(key:string,expiresSeconds:number):Promise<string>{
  return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:key}),{expiresIn:Math.max(30,Math.min(300,expiresSeconds))});
 }
}
