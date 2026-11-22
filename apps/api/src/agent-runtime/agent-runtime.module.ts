import { Logger, Module } from '@nestjs/common';
import type { DatabaseConnection } from '@qeynox/persistence';
import { HermesAdapter, hermesSettingsFromEnv } from '@qeynox/engine';
import { AgentProfileStore } from '@qeynox/roles';
import { DB_CONNECTION } from '../database/database.module';
import { AGENT_PROFILES, ENGINE_PORT } from './agent-runtime.tokens';
/**
 * The replaceable engine runtime and versioned agent profile store shared by Soul and Pilot.
 * The Hermes adapter remains fail-closed until its endpoint, credentials, native-tool isolation
 * attestation and egress attestation are all configured by the deployment operator.
 */
@Module({
  providers: [
    {
      provide: ENGINE_PORT,
      useFactory: () => new HermesAdapter({
        ...hermesSettingsFromEnv(process.env),
        onDiagnostic: event => Logger.log({ phase: event.phase, correlationId: event.correlationId,
          model: event.model, provider: event.provider, httpStatus: event.httpStatus,
          finishReason: event.finishReason, usageReported: event.usageReported,
          durationMs: event.durationMs, errorCode: event.errorCode }, 'HermesEngine'),
      }),
    },
    {
      provide: AGENT_PROFILES,
      useFactory: (connection: DatabaseConnection) => new AgentProfileStore(connection.db),
      inject: [DB_CONNECTION],
    },
  ],
  exports: [ENGINE_PORT, AGENT_PROFILES],
})
export class AgentRuntimeModule {}
