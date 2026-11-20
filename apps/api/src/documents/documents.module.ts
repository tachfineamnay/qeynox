import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import {
  DocumentVaultService, S3ArtifactStore, embeddingsFromEnv,
  type DocumentObjectPort,
} from '@qeynox/application';
import { DomainError } from '@qeynox/domain';
import { QEYNOX_STORE } from '../database/database.module';
import { DocumentsController } from './documents.controller';
import { DOCUMENT_VAULT } from './documents.tokens';

/**
 * MISSION A17 — document vault wiring.
 *
 * Storage reuses the reviewed private-artifact configuration (QEYNOX_ARTIFACT_*): no separate
 * credential surface. Absent configuration, upload/complete/download fail closed with
 * NOT_CONFIGURED while list/search degrade to truthful empty results — never fake content.
 */
@Module({
  controllers: [DocumentsController],
  providers: [
    {
      provide: DOCUMENT_VAULT,
      useFactory: (store: QeyNoxStore) => {
        const accessKeyId = process.env.QEYNOX_ARTIFACT_ACCESS_KEY;
        const secretAccessKey = process.env.QEYNOX_ARTIFACT_SECRET_KEY;
        const bucket = process.env.QEYNOX_ARTIFACT_BUCKET;
        let objects: DocumentObjectPort | undefined;
        if (accessKeyId && secretAccessKey && bucket) {
          const endpoint = process.env.QEYNOX_ARTIFACT_ENDPOINT;
          const serverSideEncryption: 'AES256' | false = process.env.QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION === 'false' ? false : 'AES256';
          objects = new S3ArtifactStore(bucket, { accessKeyId, secretAccessKey, region: process.env.QEYNOX_ARTIFACT_REGION ?? 'us-east-1', endpoint, serverSideEncryption });
        }
        return new DocumentVaultService(store, objects, embeddingsFromEnv());
      },
      inject: [QEYNOX_STORE],
    },
  ],
})
export class DocumentsModule {}
