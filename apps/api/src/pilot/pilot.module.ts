import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { PilotController } from './pilot.controller';
@Module({ imports: [AgentRuntimeModule], controllers: [PilotController] })
export class PilotModule {}
