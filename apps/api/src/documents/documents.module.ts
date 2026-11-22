import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import {
  DocumentVaultService, createS3ArtifactStoreFromEnv, embeddingsFromEnv,
  type DocumentObjectPort,
} from '@qeynox/application';
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
        const objects: DocumentObjectPort | undefined = createS3ArtifactStoreFromEnv();
        return new DocumentVaultService(store, objects, embeddingsFromEnv());
      },
      inject: [QEYNOX_STORE],
    },
  ],
})
export class DocumentsModule {}
