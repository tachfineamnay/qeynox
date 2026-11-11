import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { QeyNoxStore } from '@qeynox/persistence';
import type { EnginePort } from '@qeynox/engine';
import { AgentProfileStore, CapabilityRegistry, PilotService } from '@qeynox/roles';
import { DomainError, requireId, type Principal } from '@qeynox/domain';
import { QEYNOX_STORE } from '../database/database.module';
import { AGENT_PROFILES, ENGINE_PORT } from '../agent-runtime/agent-runtime.tokens';
interface Request { principal?: Principal }
const proposeSchema = z.object({ attemptId: z.string().min(4), capabilityId: z.string().min(4), question: z.string().trim().min(3).max(3000) });
function principal(request: Request): Principal {
  if (!request.principal?.workspaceId || !request.principal.userId) throw new DomainError('DENIED', 'Authenticated workspace required');
  return request.principal;
}
/**
 * Pilot advises from recorded operation state and the active versioned pilot profile.
 * It is not a scheduler: it never mutates plan/step state and cannot bypass ToolBroker.
 */
@Controller('v1/pilot')
export class PilotController {
  constructor(
    @Inject(QEYNOX_STORE) private readonly store: QeyNoxStore,
    @Inject(AGENT_PROFILES) private readonly profiles: AgentProfileStore,
    @Inject(ENGINE_PORT) private readonly engine: EnginePort,
  ) {}
  private async service(): Promise<PilotService> {
    return new PilotService(this.store, new CapabilityRegistry(await this.store.getCapabilities()), this.profiles, this.engine);
  }
  @Get('overview')
  async overview(@Req() request: Request) {
    return (await this.service()).operationOverview(principal(request));
  }
  @Get('operations/:id/next-action')
  async nextAction(@Req() request: Request, @Param('id') id: string) {
    return (await this.service()).nextAction(principal(request), requireId(id));
  }
  @Post('operations/:id/propose')
  async propose(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = proposeSchema.parse(body);
    return (await this.service()).proposeBusinessStep(principal(request), requireId(id), requireId(input.attemptId), requireId(input.capabilityId), input.question);
  }
}
