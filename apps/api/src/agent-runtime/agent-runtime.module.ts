import { Module } from '@nestjs/common';
import type { DatabaseConnection } from '@qeynox/persistence';
import { HermesAdapter } from '@qeynox/engine';
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
        baseUrl: process.env.HERMES_API_BASE_URL,
        apiKey: process.env.HERMES_API_KEY,
        model: process.env.HERMES_MODEL ?? 'hermes-agent',
        timeoutMs: Number(process.env.HERMES_REQUEST_TIMEOUT_MS ?? 60000),
        nativeToolsIsolated: process.env.HERMES_NATIVE_TOOLS_ISOLATED === 'true',
        egressAttested: process.env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true',
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
