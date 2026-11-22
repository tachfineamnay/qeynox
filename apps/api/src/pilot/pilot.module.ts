import { Module } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { budgetPolicies, type QeyNoxStore } from '@qeynox/persistence';
import type { EnginePort } from '@qeynox/engine';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { AgentProfileStore, CapabilityRegistry, PlanProposalService, type ProposalBudgetBoundary } from '@qeynox/roles';
import { budgetPolicyPayload } from '@qeynox/application';
import type { Principal } from '@qeynox/domain';
import { QEYNOX_STORE } from '../database/database.module';
import { AGENT_PROFILES, ENGINE_PORT } from '../agent-runtime/agent-runtime.tokens';
import { PilotController } from './pilot.controller';
import { PLAN_PROPOSAL_SERVICE } from './pilot.tokens';

/** Read-only peek at the ACTIVE workspace budget policy; never creates a budget or policy row. Exported for QA. */
export async function peekWorkspaceBudget(store: QeyNoxStore, actor: Principal): Promise<ProposalBudgetBoundary> {
  const [policy] = await store.db.select().from(budgetPolicies)
    .where(and(eq(budgetPolicies.workspaceId, actor.workspaceId), eq(budgetPolicies.status, 'ACTIVE')))
    .orderBy(desc(budgetPolicies.version)).limit(1);
  const payload = budgetPolicyPayload(policy) as (Record<string, unknown> & { currency: string; maxMoneyMinor: number }) | undefined;
  if (!payload) return { configured: false };
  return {
    configured: true,
    currency: payload.currency,
    maxMoneyMinor: payload.maxMoneyMinor,
    ...(typeof payload.maxAgentCalls === 'number' ? { maxAgentCalls: payload.maxAgentCalls } : {}),
    ...(typeof payload.maxToolCalls === 'number' ? { maxToolCalls: payload.maxToolCalls } : {}),
    ...(typeof payload.maxDurationSeconds === 'number' ? { maxDurationSeconds: payload.maxDurationSeconds } : {}),
  };
}

@Module({
  imports: [AgentRuntimeModule],
  controllers: [PilotController],
  providers: [{
    provide: PLAN_PROPOSAL_SERVICE,
    useFactory: (store: QeyNoxStore, profiles: AgentProfileStore, engine: EnginePort) =>
      new PlanProposalService(engine, actor => profiles.getActive('pilot'), async () => new CapabilityRegistry(await store.getCapabilities()), {
        peekBudget: actor => peekWorkspaceBudget(store, actor),
      }),
    inject: [QEYNOX_STORE, AGENT_PROFILES, ENGINE_PORT],
  }],
  exports: [PLAN_PROPOSAL_SERVICE],
})
export class PilotModule {}
