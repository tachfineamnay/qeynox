import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { QeyNoxStore } from '@qeynox/persistence';
import type { EnginePort } from '@qeynox/engine';
import { AgentProfileStore, CapabilityRegistry, PlanProposalService, PilotService, type PlanProposalResult } from '@qeynox/roles';
import { PlanReadService } from '@qeynox/application';
import { DomainError, requireId, type Principal } from '@qeynox/domain';
import { planProposalRequestSchema } from '@qeynox/contracts';
import { QEYNOX_STORE } from '../database/database.module';
import { AGENT_PROFILES, ENGINE_PORT } from '../agent-runtime/agent-runtime.tokens';
import { apiRuntimeReadiness } from '../operations/runtime-readiness';
import { PLAN_PROPOSAL_SERVICE } from './pilot.tokens';
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
    @Inject(PLAN_PROPOSAL_SERVICE) private readonly proposals: PlanProposalService,
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

  /**
   * A12: Pilot drafts a structured plan proposal from the recorded objective. Nothing is persisted:
   * the customer edits and saves the steps through the existing plan endpoints, which stay the only
   * way to create or revise a plan. The response carries the deployment's real readiness per
   * referenced capability and the workspace budget boundary, or an honest unavailable state.
   */
  @Post('operations/:id/plan-proposal')
  async proposePlan(@Req() request: Request, @Param('id') id: string, @Body() body: unknown): Promise<PlanProposalResult> {
    const actor = principal(request);
    const operationId = requireId(id);
    const input = planProposalRequestSchema.parse(body);
    const operation = await this.store.getOperation(actor, operationId);
    const goal = (await this.store.getGoal(actor, operationId)) ?? null;
    const readService = new PlanReadService(this.store, apiRuntimeReadiness);
    const planView = await readService.read(actor, operationId);
    const readiness = new Map(planView.capabilities.map(capability => [capability.id, {
      operationalState: capability.operationalState as string,
      isExecutable: capability.isExecutable,
      missingProviders: capability.missingProviders as string[],
      missingPolicies: capability.missingPolicies as string[],
    }]));
    return this.proposals.proposePlan(actor, { id: operation.id, title: operation.title, status: operation.status },
      goal ? { statement: goal.statement, constraints: goal.constraints } : null, input, readiness);
  }
}
