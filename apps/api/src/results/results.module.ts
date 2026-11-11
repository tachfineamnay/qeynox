import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import { ArtifactDelivery,ResultAssembler,S3ArtifactStore,ResultDeliveryService,type ArtifactStorePort } from '@qeynox/application';
import { DomainError } from '@qeynox/domain';
import { QEYNOX_STORE } from '../database/database.module';
import { ResultsController } from './results.controller';
import { ARTIFACT_DELIVERY, RESULT_ASSEMBLER, RESULT_DELIVERY } from './results.tokens';
@Module({
 controllers:[ResultsController],
 providers:[
 {provide:RESULT_ASSEMBLER,useFactory:(s:QeyNoxStore)=>new ResultAssembler(s),inject:[QEYNOX_STORE]},
 {provide:RESULT_DELIVERY,useFactory:(s:QeyNoxStore)=>new ResultDeliveryService(s),inject:[QEYNOX_STORE]},
 {provide:ARTIFACT_DELIVERY,useFactory:(s:QeyNoxStore)=>{
  const accessKeyId=process.env.QEYNOX_ARTIFACT_ACCESS_KEY,secretAccessKey=process.env.QEYNOX_ARTIFACT_SECRET_KEY,bucket=process.env.QEYNOX_ARTIFACT_BUCKET;
  const missing:ArtifactStorePort={put:async()=>{throw new DomainError('NOT_CONFIGURED','Artifact store not configured');},signedRead:async()=>{throw new DomainError('NOT_CONFIGURED','Artifact store not configured');}};
  const store=accessKeyId&&secretAccessKey&&bucket?new S3ArtifactStore(bucket,{accessKeyId,secretAccessKey,region:process.env.QEYNOX_ARTIFACT_REGION??'us-east-1',endpoint:process.env.QEYNOX_ARTIFACT_ENDPOINT}):missing;
  return new ArtifactDelivery(s,store);
 },inject:[QEYNOX_STORE]},
 ],
})
export class ResultsModule {}
