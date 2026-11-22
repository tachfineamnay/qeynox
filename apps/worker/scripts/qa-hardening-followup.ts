/** Local ports/clock tests. No database or S3 is simulated or certified here. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError, requireId, type CapabilityDefinition, type Principal } from '@qeynox/domain';
import type { AgentProfile, EnginePort } from '@qeynox/engine';
import { CapabilityRegistry, PlanProposalService, type ProposalBudgetBoundary } from '@qeynox/roles';

const actor: Principal = { userId: requireId('followup-user'), workspaceId: requireId('followup-workspace'), roles: ['OWNER'] };
const cap: CapabilityDefinition = {
  id: requireId('followup-capability'), slot: 1, version: 1, status: 'ACTIVE', name: 'QA research',
  purpose: 'QA-only port regression', scope: ['QA'], allowedTools: [], privacyScopes: [],
  inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 2, maximumToolCalls: 0,
};
const profile: AgentProfile = {
  id: requireId('followup-profile'), version: 1, role: 'pilot', title: 'QA Pilot', systemInstructions: 'QA only',
  skillRefs: [], allowedTools: [], permittedContextKeys: [], maxOutputTokens: 500, maxIterations: 1,
};
const operation = { id: requireId('followup-operation'), title: 'QA objective', status: 'DRAFT' };
const request = { attemptKey: 'followup-attempt-01', locale: 'en' as const };
function engine(counter: { calls: number }): EnginePort {
  return { invoke: async () => {
    counter.calls++;
    return { status: 'COMPLETED', engine: 'qa-port-fixture', receivedAt: new Date().toISOString(), proposedTools: [], content: JSON.stringify({
      summary: 'QA research plan', deliverables: ['QA memo'], assumptions: [], questions: [],
      steps: [{ title: 'Inspect QA input', description: 'Inspect recorded QA input only', capabilityId: cap.id, intent: 'RESEARCH', dependsOnIndices: [], expectedDeliverable: 'QA memo' }],
    }) };
  } };
}

test('Pilot loads capabilities lazily per request and never replays a disabled catalogue', async () => {
  let reads = 0, active = true;
  const counter = { calls: 0 };
  const service = new PlanProposalService(engine(counter), async () => profile, async principal => {
    assert.equal(principal.workspaceId, actor.workspaceId);
    reads++;
    return new CapabilityRegistry(active ? [cap] : []);
  }, { attemptCache: new Map() });
  assert.equal(reads, 0, 'construction must not query persistence');
  const first = await service.proposePlan(actor, operation, null, request);
  assert.equal(first.source, 'AI');
  active = false;
  const second = await service.proposePlan(actor, operation, null, request);
  assert.equal(second.reason, 'NO_CAPABILITIES');
  assert.deepEqual(second.steps, []);
  assert.equal(reads, 2);
  assert.equal(counter.calls, 1);
});

test('Pilot cache cannot replay old goal, budget, readiness or profile configuration', async () => {
  const counter = { calls: 0 };
  let ceiling = 100;
  let profileVersion = 1;
  let capabilityVersion = 1;
  const service = new PlanProposalService(engine(counter), async () => ({ ...profile, version: profileVersion }), async () => new CapabilityRegistry([{ ...cap, version: capabilityVersion }]), {
    attemptCache: new Map(),
    peekBudget: async (): Promise<ProposalBudgetBoundary> => ({ configured: true, currency: 'USD', maxMoneyMinor: ceiling }),
  });
  const ready = new Map([[cap.id, { operationalState: 'OPERATIONAL', isExecutable: true }]]);
  const first = await service.proposePlan(actor, operation, null, request, ready);
  assert.deepEqual(await service.proposePlan(actor, operation, null, request, ready), first);
  assert.equal(counter.calls, 1, 'an unchanged retry is still cached');
  ceiling = 10;
  const blocked = new Map([[cap.id, { operationalState: 'BLOCKED', isExecutable: false }]]);
  const second = await service.proposePlan(actor, operation, null, request, blocked);
  assert.equal(second.budget.maxMoneyMinor, 10);
  assert.equal(second.capabilityNotes[0]?.isExecutable, false);
  await service.proposePlan(actor, { ...operation, title: 'Changed QA objective' }, null, request, blocked);
  const beforeProfileChange = counter.calls;
  profileVersion++;
  await service.proposePlan(actor, { ...operation, title: 'Changed QA objective' }, null, request, blocked);
  assert.equal(counter.calls, beforeProfileChange + 1, 'profile version change invalidates cached output');
  const beforeCapabilityChange = counter.calls;
  capabilityVersion++;
  await service.proposePlan(actor, { ...operation, title: 'Changed QA objective' }, null, request, blocked);
  assert.equal(counter.calls, beforeCapabilityChange + 1, 'full capability version change invalidates cached output');
});

test('capability ceilings reject non-finite, fractional and unsafe configuration', () => {
  for (const field of ['version', 'maximumSteps', 'maximumToolCalls'] as const) {
    for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new CapabilityRegistry([{ ...cap, [field]: value }]), DomainError, field + ':' + value);
    }
  }
  assert.doesNotThrow(() => new CapabilityRegistry([cap]));
});
