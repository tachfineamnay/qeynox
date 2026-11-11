import { createHash } from 'node:crypto';
import { GetObjectCommand,PutObjectCommand,S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '@qeynox/domain';
import type { ArtifactStorePort,ObjectReceipt } from './artifacts';
export class S3ArtifactStore implements ArtifactStorePort {
 private readonly client:S3Client;
 constructor(private readonly bucket:string,options:{endpoint?:string;region:string;accessKeyId:string;secretAccessKey:string}){
  if(!bucket||!options.region||!options.accessKeyId||!options.secretAccessKey)throw new DomainError('NOT_CONFIGURED','Private S3 credentials and bucket are required');
  this.client=new S3Client({region:options.region,endpoint:options.endpoint,forcePathStyle:Boolean(options.endpoint),credentials:{accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey}});
 }
 async put(key:string,body:Uint8Array,contentType:string):Promise<ObjectReceipt>{
  const sha256=createHash('sha256').update(body).digest('hex');
  const response=await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:body,ContentType:contentType,IfNoneMatch:'*',Metadata:{sha256},ServerSideEncryption:'AES256'}));
  return {key,versionId:response.VersionId,sha256,size:body.byteLength};
 }
 signedRead(key:string,expiresSeconds:number):Promise<string>{
  return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:key}),{expiresIn:Math.max(30,Math.min(300,expiresSeconds))});
 }
}
