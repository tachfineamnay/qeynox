import { Module } from '@nestjs/common';
import type { QeyNoxStore } from '@qeynox/persistence';
import type { EnginePort } from '@qeynox/engine';
import { SoulOnboardingService, SoulService, type AgentProfileStore } from '@qeynox/roles';
import { QEYNOX_STORE } from '../database/database.module';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { AGENT_PROFILES, ENGINE_PORT } from '../agent-runtime/agent-runtime.tokens';
import { SoulController } from './soul.controller';
import { SoulOnboardingController } from './soul-onboarding.controller';
import { SOUL_ONBOARDING_SERVICE, SOUL_SERVICE } from './soul.tokens';
@Module({
  imports: [AgentRuntimeModule],
  controllers: [SoulController, SoulOnboardingController],
  providers: [
    {
      provide: SOUL_SERVICE,
      useFactory: (store: QeyNoxStore, profiles: AgentProfileStore, engine: EnginePort) => new SoulService(store, profiles, engine),
      inject: [QEYNOX_STORE, AGENT_PROFILES, ENGINE_PORT],
    },
    {
      provide: SOUL_ONBOARDING_SERVICE,
      useFactory: (store: QeyNoxStore, soul: SoulService) => new SoulOnboardingService(store, soul),
      inject: [QEYNOX_STORE, SOUL_SERVICE],
    },
  ],
})
export class SoulModule {}
