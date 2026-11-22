import { Module } from '@nestjs/common';
import { QeyNoxStore } from '@qeynox/persistence';
import {
  ArtifactDelivery,
  AtlasLibraryService,
  ResultAssembler,
  ResultDeliveryService,
  createS3ArtifactStoreFromEnv,
  type ArtifactStorePort,
} from '@qeynox/application';
import { DomainError } from '@qeynox/domain';
import { QEYNOX_STORE } from '../database/database.module';
import { AtlasLibraryController } from './atlas-library.controller';
import { ResultsController } from './results.controller';
import {
  ARTIFACT_DELIVERY,
  ARTIFACT_STORE_PORT,
  ATLAS_LIBRARY_SERVICE,
  RESULT_ASSEMBLER,
  RESULT_DELIVERY,
} from './results.tokens';

export interface ConfiguredArtifactStore {
  readonly port: ArtifactStorePort;
  readonly configured: boolean;
}

@Module({
  controllers: [ResultsController, AtlasLibraryController],
  providers: [
    {
      provide: RESULT_ASSEMBLER,
      useFactory: (s: QeyNoxStore) => new ResultAssembler(s),
      inject: [QEYNOX_STORE],
    },
    {
      provide: RESULT_DELIVERY,
      useFactory: (s: QeyNoxStore) => new ResultDeliveryService(s),
      inject: [QEYNOX_STORE],
    },
    {
      provide: ARTIFACT_STORE_PORT,
      useFactory: (): ConfiguredArtifactStore => {
        const missing: ArtifactStorePort = {
          put: async () => {
            throw new DomainError('NOT_CONFIGURED', 'Artifact store not configured');
          },
          head: async () => {
            throw new DomainError('NOT_CONFIGURED', 'Artifact store not configured');
          },
          signedRead: async () => {
            throw new DomainError('NOT_CONFIGURED', 'Artifact store not configured');
          },
        };
        const objects = createS3ArtifactStoreFromEnv();
        if (objects) return { port: objects, configured: true };
        return { port: missing, configured: false };
      },
    },
    {
      provide: ARTIFACT_DELIVERY,
      useFactory: (s: QeyNoxStore, storeConfig: ConfiguredArtifactStore) =>
        new ArtifactDelivery(s, storeConfig.port),
      inject: [QEYNOX_STORE, ARTIFACT_STORE_PORT],
    },
    {
      provide: ATLAS_LIBRARY_SERVICE,
      useFactory: (s: QeyNoxStore, storeConfig: ConfiguredArtifactStore) =>
        new AtlasLibraryService(s, { artifactStoreConfigured: () => storeConfig.configured }),
      inject: [QEYNOX_STORE, ARTIFACT_STORE_PORT],
    },
  ],
})
export class ResultsModule {}
