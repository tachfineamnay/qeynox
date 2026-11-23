/**
 * MISSION A03 — first operational business service QA.
 *
 * Two independent halves, deliberately separated:
 *
 *  PART 1 — CONFIGURATION + REQUEST + PLAN (pure, always runnable)
 *   - the applyable operator configuration is internally consistent and applies cleanly;
 *   - the request contract accepts an explicit objective/country/indicator/constraints and rejects
 *     every malformed or out-of-scope variant;
 *   - the bounded plan is derived deterministically and always requires user approval.
 *
 *  PART 2 — PROVIDER + EVIDENCE + REVIEW + DELIVERABLE (isolated database, REAL provider read)
 *   - configuration validation against the database;
 *   - unauthorized access, budget exhaustion, unavailable provider, stale data, contradiction;
 *   - the full chain to a traceable DELIVERABLE.
 *
 * PART 2 refuses to run without QEYNOX_QA_DATABASE_URL and reports BLOCKED if the provider cannot
 * be reached from this environment. It NEVER substitutes a fixture observation for a provider
 * response and never reports a contract-only run as integration evidence.
 *
 * Run: pnpm --filter @qeynox/worker qa:a03-service
 * Exit: 0 PASS · 3 BLOCKED (prerequisite or live provider unavailable) · 1 FAILED
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  approvals, attempts, budgetPolicies, capabilities, identityMemberships, identityUsers,
  identityWorkspaces, offers, sourceSnapshots, sources, toolConfigurations, verificationPolicies,
} from '@qeynox/persistence';
import {
  BudgetService, ClaimsService, CommerceService, ConfigurationService, EconomicResearchService,
  OperationControlService, OperationExecutionService, PlanningService, ResultAssembler,
  ResultDeliveryService, StepProgression, buildResearchPlan, makeRuntimeReadiness,
  normalizeResearchRequest,
} from '@qeynox/application';
import {
  PgToolLedger, ToolBroker, createConfiguredToolRegistry, egressPolicyFromEnv,
  type ConnectorCall, type PermissionContext, type ToolResult,
} from '@qeynox/tools';
import { DomainError, type ID, type Principal, type Source } from '@qeynox/domain';
import type { ConfigurationEntry } from '@qeynox/application';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';
import { seedQaBetaGrant } from '../../api/scripts/qa-beta-fixture';
import { makeRuntimeReadiness as qaRuntimeFixture } from '@qeynox/application';
// A21.07 QA fixture (test infrastructure only): this suite exercises launches, not runtime probing.
// The launch gate itself is proven against real probes in qa:runtime-verification.
const qaVerifiedRuntime = () => qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:qa-a03-service', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:qa-a03-service' });

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ': ' + error.message : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
/**
 * Signals a BLOCKED outcome by throwing a sentinel that the top-level handler recognises. It must
 * not call process.exit() here: a live exit inside the try block skips nothing but still lets
 * `finally` throw, which masks the intended exit code with a teardown error.
 */
class BlockedSignal extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'BlockedSignal'; }
}
function blocked(reason: string): never {
  throw new BlockedSignal(reason);
}

// ---------------------------------------------------------------------------------------------
// The operator configuration under test — the file an operator actually applies.
// ---------------------------------------------------------------------------------------------
interface ServiceTemplate {
  readonly idempotencyKey: string;
  readonly service: {
    readonly capabilityId: string; readonly offerId: string; readonly budgetPolicyId: string;
    readonly allowedCountries: readonly string[]; readonly allowedIndicators: readonly string[];
    readonly maximumObservations: number;
  };
  readonly entries: readonly ConfigurationEntry[];
}
const templatePath = fileURLToPath(new URL('../../../infra/operator/a03-economic-research.json', import.meta.url));
const template = JSON.parse(readFileSync(templatePath, 'utf8')) as ServiceTemplate;

function entryOf<D extends ConfigurationEntry['domain']>(domain: D): Extract<ConfigurationEntry, { domain: D }> {
  const found = template.entries.find(entry => entry.domain === domain);
  if (!found) throw new Error('template is missing a ' + domain + ' entry');
  return found as Extract<ConfigurationEntry, { domain: D }>;
}
const capabilityEntry = entryOf('BUSINESS_CAPABILITY');
const profileEntry = entryOf('AGENT_PROFILE');
const policyEntry = entryOf('VERIFICATION_POLICY');
const offerEntry = entryOf('RAAS_OFFER');
const budgetEntry = entryOf('BUDGET_POLICY');
/** The configured engine rate every budget assertion is measured against. */
const engineRate = budgetEntry.unitMaxMinor['hermes'] as number;

/** A fully operational runtime: only used to prove the service is not permanently BLOCKED by design. */
const OPERATIONAL_RUNTIME = makeRuntimeReadiness({
  engineConfigured: true, engineVerifiedLive: true, engineAttested: true, engineEvidence: 'qa-a03',
  orchestratorConfigured: true, orchestratorVerifiedLive: true, orchestratorAttested: true, orchestratorEvidence: 'qa-a03',
});
const serviceConfig = {
  capabilityId: template.service.capabilityId as ID,
  offerId: template.service.offerId,
  allowedCountries: template.service.allowedCountries,
  allowedIndicators: template.service.allowedIndicators,
  maximumObservations: template.service.maximumObservations,
};
const researchObjective = 'Assess how GDP per capita evolved in Morocco across the last three published years';
const plainRequest = { objective: researchObjective, country: 'MAR', indicator: 'NY.GDP.PCAP.CD' };

// =============================================================================================
// PART 1 — pure validation (no database)
// =============================================================================================
function partOne(): void {
  console.log('— PART 1: configuration content, request contract, bounded plan —');
  const before = assertions;

  // --- configuration content -------------------------------------------------------------
  check(new Set(template.entries.map(entry => entry.domain)).size === 6, 'the template defines exactly the six domains');
  check(capabilityEntry.status === 'ACTIVE' && capabilityEntry.allowedTools.every(ref => ref === 'world-bank:indicator@1'), 'capability is ACTIVE and allows only the reviewed World Bank tool');
  check(profileEntry.allowedTools.every(ref => ref === 'world-bank:indicator@1'), 'profile allows no browser or unrestricted web tool');
  check(profileEntry.permittedContextKeys.length === 0, 'profile reads no customer private context');
  check(policyEntry.humanReviewRequired === true, 'human review is required before SUPPORTED');
  check(policyEntry.approvedProviders.length === 1 && policyEntry.approvedProviders[0] === 'world-bank', 'policy approves only the reviewed provider');
  check(policyEntry.maxAgeDays <= 180, 'freshness window is defensible for an economic series');
  check(offerEntry.capabilityIds.includes(template.service.capabilityId), 'offer covers the service capability');
  check(offerEntry.status === 'ACTIVE' && offerEntry.taxPolicy === 'CONFIGURED', 'offer is ACTIVE with configured tax treatment');
  check(offerEntry.amountMinor !== 0 || offerEntry.isExplicitlyFree, 'a zero price is explicitly free, never silent');
  check(capabilityEntry.maximumSteps <= 4, 'plan step ceiling stays bounded');
  check(capabilityEntry.maximumToolCalls >= 3, 'tool-call ceiling covers the primary series and two comparisons');
  check(typeof engineRate === 'number' && engineRate > 0, 'budget declares an engine rate');
  check(Math.floor(budgetEntry.maxMoneyMinor / engineRate) >= profileEntry.maxIterations, 'budget affords the full iteration ceiling');
  check(budgetEntry.maxAgentCalls >= profileEntry.maxIterations, 'agent-call ceiling matches the profile');
  check(budgetEntry.maxToolCalls >= capabilityEntry.maximumToolCalls, 'tool-call ceiling matches the capability');
  check(budgetEntry.unitMaxMinor['world-bank:indicator@1'] === 0, 'the free public provider is rate-carded at zero, not omitted');

  // --- accepted request shapes ------------------------------------------------------------
  const normalized = normalizeResearchRequest(plainRequest, template.service);
  check(normalized.country === 'MAR' && normalized.indicator === 'NY.GDP.PCAP.CD', 'codes normalize to upper case');
  check(normalized.mostRecent === 3, 'default observation count applied');
  check(normalized.fingerprint.length > 0, 'the request carries a fingerprint');
  check(normalizeResearchRequest(plainRequest, template.service).fingerprint === normalized.fingerprint, 'fingerprint is deterministic');
  check(normalizeResearchRequest({ ...plainRequest, constraints: { includeInterpretation: true } }, template.service).fingerprint !== normalized.fingerprint, 'changing the approved scope changes the fingerprint');

  // --- rejected request shapes ------------------------------------------------------------
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, objective: 'too short' }), 'objective too short');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, objective: 'x'.repeat(5001) }), 'objective too long');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, country: 'M' }), 'country too short');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, country: 'Morocco' }), 'country name instead of a code');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, country: 'M4R' }), 'country containing a digit');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, indicator: 'GDP' }), 'indicator without the dotted shape');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, indicator: 'NY GDP' }), 'indicator containing a space');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { mostRecent: 0 } }), 'zero observations requested');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { mostRecent: 99 } }), 'observation count beyond the ceiling');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { minObservationYear: 1800 } }), 'implausible observation year');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { minObservationYear: 2999 } }), 'future observation year');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { compareIndicators: ['NY.GDP.MKTP.CD', 'SP.POP.TOTL', 'SL.UEM.TOTL.ZS'] } }), 'more than two comparisons');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { compareIndicators: ['NY.GDP.PCAP.CD'] } }), 'comparison repeating the primary indicator');
  void expectError('INVALID_INPUT', () => normalizeResearchRequest({ ...plainRequest, constraints: { note: 'n'.repeat(501) } }), 'note too long');
  void expectError('DENIED', () => normalizeResearchRequest({ ...plainRequest, country: 'CHN' }, serviceConfig), 'country outside the operator allowlist');
  void expectError('DENIED', () => normalizeResearchRequest({ ...plainRequest, indicator: 'AG.LND.AGRI.ZS' }, serviceConfig), 'indicator outside the operator allowlist');

  // --- bounded plan ------------------------------------------------------------------------
  const plan = buildResearchPlan(normalized, { capabilityId: serviceConfig.capabilityId, offerId: serviceConfig.offerId, maximumSteps: capabilityEntry.maximumSteps, maximumToolCalls: capabilityEntry.maximumToolCalls });
  check(plan.steps.length === 1 && plan.steps[0]!.intent === 'RESEARCH', 'a plain request is one bounded research step');
  check(plan.requiresUserApproval, 'the plan always requires explicit user approval');
  check(plan.steps[0]!.description.includes('NY.GDP.PCAP.CD') && plan.steps[0]!.description.includes('MAR'), 'the plan names the exact indicator and country');
  check(plan.steps[0]!.description.includes('ToolBroker'), 'the plan states provider reads are mediated by ToolBroker');

  const interpretedRequest = normalizeResearchRequest({ ...plainRequest, constraints: { includeInterpretation: true } }, template.service);
  const interpreted = buildResearchPlan(interpretedRequest, { capabilityId: serviceConfig.capabilityId, offerId: serviceConfig.offerId, maximumSteps: capabilityEntry.maximumSteps, maximumToolCalls: capabilityEntry.maximumToolCalls });
  check(interpreted.steps.length === 2, 'interpretation adds exactly one step');
  check(interpreted.steps[1]!.dependsOnIndices.length === 1 && interpreted.steps[1]!.dependsOnIndices[0] === 0, 'the interpretation step depends on the research step');
  check(interpreted.steps[1]!.intent === 'ANALYZE', 'the interpretation step is ANALYZE, never EXTERNAL_ACTION');

  void expectError('INVALID_INPUT', () => buildResearchPlan(normalized, { capabilityId: serviceConfig.capabilityId, offerId: serviceConfig.offerId, maximumSteps: 4, maximumToolCalls: 0 }), 'a plan needing more provider reads than the capability allows');
  void expectError('INVALID_INPUT', () => buildResearchPlan(interpretedRequest, { capabilityId: serviceConfig.capabilityId, offerId: serviceConfig.offerId, maximumSteps: 1, maximumToolCalls: 3 }), 'interpretation on a single-step capability');

  // --- disclosures are surfaced, not hidden ------------------------------------------------
  const constrained = normalizeResearchRequest({ ...plainRequest, constraints: { minObservationYear: 2020, compareIndicators: ['NY.GDP.MKTP.KD.ZG'] } }, template.service);
  const disclosed = buildResearchPlan(constrained, { capabilityId: serviceConfig.capabilityId, offerId: serviceConfig.offerId, maximumSteps: capabilityEntry.maximumSteps, maximumToolCalls: capabilityEntry.maximumToolCalls });
  check(disclosed.warnings.some(warning => warning.includes('2020')), 'the caller year filter is disclosed to the approving user');
  check(disclosed.warnings.some(warning => warning.includes('Comparison')), 'comparison reads are disclosed');

  console.log('  PART 1 PASSED: ' + (assertions - before) + ' assertions');
}

// =============================================================================================
// PART 2 — integration against a disposable database and the real provider
// =============================================================================================
async function partTwo(): Promise<'PASSED' | 'BLOCKED'> {
  console.log('— PART 2: configuration, authorization, budget, provider, evidence, review, deliverable —');
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: PART 2 not run — QEYNOX_QA_DATABASE_URL is not set. A contract-only run is not integration evidence.');
    return 'BLOCKED';
  }

  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    check(migration.total > 0 && migration.applied.length === migration.total, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);

    // --- principals ------------------------------------------------------------------------
    const ownerId = randomUUID(), memberId = randomUUID(), outsiderId = randomUUID();
    const workspaceId = randomUUID(), otherWorkspaceId = randomUUID();
    await db.insert(identityUsers).values([
      { id: ownerId, email: 'qa-a03-owner-' + ownerId + '@example.invalid' },
      { id: memberId, email: 'qa-a03-member-' + memberId + '@example.invalid' },
      { id: outsiderId, email: 'qa-a03-outsider-' + outsiderId + '@example.invalid' },
    ]);
    await db.insert(identityWorkspaces).values([
      { id: workspaceId, name: 'QA A03 Workspace', createdBy: ownerId },
      { id: otherWorkspaceId, name: 'QA A03 Other Workspace', createdBy: outsiderId },
    ]);
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberId, workspaceId, role: 'MEMBER', status: 'ACTIVE' },
      { id: randomUUID(), userId: outsiderId, workspaceId: otherWorkspaceId, role: 'OWNER', status: 'ACTIVE' },
    ]);
    // A21.02: launches and provider spend require an ACTIVE beta grant (explicit QA precondition).
    await seedQaBetaGrant(db, workspaceId, { currency: budgetEntry.currency });
    const owner: Principal = { userId: ownerId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const member: Principal = { userId: memberId as ID, workspaceId: workspaceId as ID, roles: ['MEMBER'] };
    const outsider: Principal = { userId: outsiderId as ID, workspaceId: otherWorkspaceId as ID, roles: ['OWNER'] };

    process.env.QEYNOX_OPERATOR_USER_IDS = ownerId;
    process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
    process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
    process.env.QEYNOX_EGRESS_ALLOWED_HOSTS = 'api.worldbank.org';

    // --- 1. Apply the operator template and prove it validates -----------------------------
    const configuration = new ConfigurationService(store);
    await configuration.apply(owner, { idempotencyKey: template.idempotencyKey, entries: [...template.entries] } as never);
    const service: EconomicResearchService = new EconomicResearchService(store, serviceConfig, () => OPERATIONAL_RUNTIME);

    const [capabilityRow] = await db.select().from(capabilities).where(eq(capabilities.id, template.service.capabilityId));
    check(Boolean(capabilityRow), 'the capability was applied');
    const [policyRow] = await db.select().from(verificationPolicies).where(eq(verificationPolicies.capabilityId, template.service.capabilityId));
    check(policyRow?.humanReviewRequired === 'true', 'the applied policy requires human review');
    const [offerRow] = await db.select().from(offers).where(eq(offers.id, template.service.offerId));
    check(offerRow?.status === 'ACTIVE', 'the applied offer is ACTIVE');
    // Budget policies are workspace-scoped: the row id includes the paying workspace.
    const budgetRowId = 'budget-' + workspaceId + '-' + template.service.budgetPolicyId + '-v1';
    const [budgetRow] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, budgetRowId));
    check(budgetRow?.status === 'ACTIVE', 'the applied budget policy is ACTIVE in the paying workspace');
    const [foreignBudget] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.workspaceId, otherWorkspaceId));
    check(!foreignBudget, "another workspace does not inherit this workspace's budget policy");
    const toolRows = await db.select().from(toolConfigurations).where(and(eq(toolConfigurations.connectorId, 'world-bank'), eq(toolConfigurations.status, 'ACTIVE')));
    check(toolRows.length === 1, 'exactly one ACTIVE World Bank tool configuration');

    // --- 2. Configuration validation catches each historical defect ------------------------
    const { validateServiceConfiguration } = await import('@qeynox/application');
    const healthy = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: template.service.offerId,
      budgetPolicyId: template.service.budgetPolicyId, expectedProvider: 'world-bank',
      maximumIterations: profileEntry.maxIterations, workspaceId,
    });
    check(healthy.valid, 'the applied configuration has no blocker: ' + healthy.findings.map(finding => finding.code).join(', '));
    // A policy that does not require human review is reported, never silently accepted.
    await db.update(verificationPolicies).set({ humanReviewRequired: 'false' }).where(eq(verificationPolicies.capabilityId, template.service.capabilityId));
    const noReview = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: template.service.offerId,
      budgetPolicyId: template.service.budgetPolicyId, expectedProvider: 'world-bank', maximumIterations: profileEntry.maxIterations, workspaceId,
    });
    check(noReview.findings.some(finding => finding.code === 'POLICY_SKIPS_HUMAN_REVIEW'), 'a policy that skips human review is reported');
    check(noReview.valid, 'skipping review is a WARNING, not a silent pass: the claim path still enforces review');
    await db.update(verificationPolicies).set({ humanReviewRequired: 'true' }).where(eq(verificationPolicies.capabilityId, template.service.capabilityId));
    // The policy approval must name the enabled provider.
    await db.update(verificationPolicies).set({ approvedProviders: ['other-provider'] as never }).where(eq(verificationPolicies.capabilityId, template.service.capabilityId));
    const wrongProvider = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: template.service.offerId,
      budgetPolicyId: template.service.budgetPolicyId, expectedProvider: 'world-bank', maximumIterations: profileEntry.maxIterations, workspaceId,
    });
    check(!wrongProvider.valid && wrongProvider.findings.some(finding => finding.code === 'POLICY_PROVIDER_MISMATCH'), 'a policy approving an unconfigured provider is a blocker');
    check(wrongProvider.findings.some(finding => finding.code === 'POLICY_PROVIDER_DISABLED'), 'the disabled approved provider is named');
    await db.update(verificationPolicies).set({ approvedProviders: ['world-bank'] as never }).where(eq(verificationPolicies.capabilityId, template.service.capabilityId));
    // A budget that cannot finish the plan is a blocker, not a mid-plan failure.
    const budgetPayload = budgetEntry as unknown as Record<string, unknown>;
    await db.update(budgetPolicies).set({ payload: { ...budgetPayload, maxMoneyMinor: budgetEntry.unitMaxMinor['hermes']! * 2 } }).where(eq(budgetPolicies.id, budgetRowId));
    const starved = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: template.service.offerId,
      budgetPolicyId: template.service.budgetPolicyId, expectedProvider: 'world-bank', maximumIterations: profileEntry.maxIterations, workspaceId,
    });
    check(!starved.valid && starved.findings.some(finding => finding.code === 'BUDGET_EXHAUSTS_MID_PLAN'), 'a budget that starves the plan is a blocker');
    await db.update(budgetPolicies).set({ payload: { ...budgetPayload } }).where(eq(budgetPolicies.id, budgetRowId));
    const restored = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: template.service.offerId,
      budgetPolicyId: template.service.budgetPolicyId, expectedProvider: 'world-bank', maximumIterations: profileEntry.maxIterations, workspaceId,
    });
    check(restored.valid, 'restoring the template configuration clears the blockers');

    // --- 3. Service availability and unauthorized access ----------------------------------
    const availability = await service.availability();
    check(availability.executable && availability.blockers.length === 0, 'the service is executable with an operational runtime');
    const failedClosed = await new EconomicResearchService(store, serviceConfig).availability();
    check(!failedClosed.executable && failedClosed.blockers.includes('RUNTIME_NOT_OPERATIONAL'), 'without a runtime attestation the service is BLOCKED, never available');

    const planning = new PlanningService(store);
    await expectError('NOT_CONFIGURED', () => new EconomicResearchService(store, { capabilityId: 'capability-slot-8-v1' as ID, offerId: template.service.offerId }).propose(plainRequest), 'an unconfigured capability slot');
    await expectError('DENIED', () => normalizeResearchRequest({ ...plainRequest, country: 'CHN' }, serviceConfig), 'a country outside the operator allowlist is refused before any provider call');

    // --- 4. Plan and commercial approval ---------------------------------------------------
    const created = await service.createPlan(owner, plainRequest, planning);
    check(created.steps.length === 1, 'a plain request yields one plan step');
    check(created.operationId && created.revisionId, 'plan creation returns the operation and revision');
    // Tenancy: the same service, used by a principal in another workspace, produces an operation
    // that belongs to THAT workspace and is invisible to this one — never a shared or elevated row.
    const outsiderPlan = await service.createPlan(outsider, plainRequest, planning);
    check(outsiderPlan.operationId !== created.operationId, 'plans are never shared across workspaces');
    await expectError('NOT_FOUND', () => store.getOperation(owner, outsiderPlan.operationId), "this workspace cannot read another workspace's operation");
    await expectError('NOT_FOUND', () => store.getOperation(outsider, created.operationId), 'another workspace cannot read this operation');
    const readyOperation = await store.getOperation(owner, created.operationId);
    check(readyOperation.status === 'READY', 'the operation is READY, awaiting explicit approval');
    const commerce = new CommerceService(store);
    const quote = await commerce.quote(owner, created.operationId, template.service.offerId, created.revisionId) as { id: string; amountMinor: number };
    check(quote.amountMinor === 0, 'the configured offer is explicitly free');
    const order = await commerce.accept(owner, quote.id as ID, 'qa-a03-acceptance-0001');
    check(order.state === 'AUTHORIZED', 'explicit acceptance authorizes execution');
    // NOT_FOUND, not DENIED: an unauthorized principal must not learn that the operation exists.
    await expectError('NOT_FOUND', () => commerce.assertExecutionAllowed(outsider, created.operationId, created.revisionId), 'an outsider cannot authorize execution and is not told the operation exists');

    // --- 5. Attempt and budget materialization ---------------------------------------------
    // The attempt must exist before any reservation: every reservation belongs to a concrete step
    // attempt, so budget can never be consumed by an operation with no executing work.
    const execution = new OperationExecutionService(store, qaVerifiedRuntime);
    const startable = await store.getOperation(owner, created.operationId);
    const started = await execution.start(owner, created.operationId, startable.version, 'qa-a03-start-0001') as { attemptId: ID };
    check(typeof started.attemptId === 'string', 'the research step attempt was created');

    const budgets = new BudgetService(store);
    // The workspace's ACTIVE budget policy is materialized onto the operation exactly once.
    const materialized = await budgets.ensureBudget(owner, created.operationId);
    check(materialized.maxMoneyMinor === budgetEntry.maxMoneyMinor, 'the operation budget is the workspace policy, not a default');
    check(materialized.maxToolCalls === budgetEntry.maxToolCalls, 'the tool-call ceiling is carried onto the operation');

    // --- 6. The real provider read ---------------------------------------------------------
    const registry = await createConfiguredToolRegistry(db, { worldBankEnabled: true, braveSearchEnabled: false, egress: egressPolicyFromEnv() });
    const broker = new ToolBroker(registry, new PgToolLedger(db));
    const call: ConnectorCall = {
      operationId: created.operationId, planRevisionId: created.revisionId, stepAttemptId: started.attemptId,
      capabilityId: template.service.capabilityId as ID, connectorId: 'world-bank', toolName: 'indicator', version: '1',
      input: { country: created.request.country, indicator: created.request.indicator, mostRecent: created.request.mostRecent },
      idempotencyKey: 'qa-a03-read-1', intentId: randomUUID() as ID,
    };
    const permission: PermissionContext = {
      principal: owner, operationId: created.operationId, planRevisionId: created.revisionId, stepAttemptId: started.attemptId,
      capabilityId: template.service.capabilityId as ID, profileId: 'profile-business-1-v1' as ID, profileVersion: 1,
      allowedConnectorTools: ['world-bank:indicator@1'], consentScopes: [], approvedRequests: [],
      remainingCostUnits: 0, remainingToolCalls: 3,
    };
    // The broker must refuse a provider the policy does not approve, without any network traffic.
    await expectError('DENIED', () => broker.invoke(call, { ...permission, capabilityId: 'capability-slot-2-v1' as ID }), 'a provider read for a capability that does not allow the tool');

    let providerResult: ToolResult | undefined;
    let providerBlocked: string | null = null;
    try {
      providerResult = await broker.invoke(call, permission);
    } catch (error: unknown) {
      if (error instanceof BlockedSignal) throw error;
      // A provider outage reaches us as INVALID_STATE/UNAVAILABLE from the adapter, never as a
      // passing result. DENIED/CONFLICT/INVALID_INPUT would mean the broker rejected our own call,
      // which is a defect in this script rather than an environment limitation: rethrow those.
      if (error instanceof DomainError && ['DENIED', 'CONFLICT', 'INVALID_INPUT'].includes(error.code)) throw error;
      providerBlocked = 'the live World Bank provider is unreachable from this environment ('
        + (error instanceof Error ? error.message : String(error)) + '). '
        + 'Provider provenance, digest, human review and deliverable were NOT verified; no fixture was substituted.';
    }

    // --- 6b. Budget exhaustion (independent of the provider) --------------------------------
    const first = await budgets.reserve(owner, created.operationId, started.attemptId, 'ENGINE', 'hermes', 'qa-a03-budget-1');
    check(first.maximumCostMinor === engineRate, 'the engine reservation uses the configured hermes rate');
    await budgets.settle(owner, first.reservationId as ID, { origin: 'ESTIMATED', costMinor: first.maximumCostMinor });
    let exhausted = false;
    for (let index = 0; index < budgetEntry.maxAgentCalls + 2 && !exhausted; index++) {
      try {
        const extra = await budgets.reserve(owner, created.operationId, started.attemptId, 'ENGINE', 'hermes', 'qa-a03-budget-' + index);
        await budgets.settle(owner, extra.reservationId as ID, { origin: 'ESTIMATED', costMinor: extra.maximumCostMinor });
      } catch (error: unknown) {
        exhausted = error instanceof DomainError && error.code === 'BUDGET_EXHAUSTED';
      }
    }
    check(exhausted, 'engine calls beyond the budget ceiling raise BUDGET_EXHAUSTED');

    if (providerBlocked !== null || !providerResult) {
      blocked(providerBlocked ?? 'the provider read produced no result');
    }
    const value = providerResult.value as { provider: string; country: string; indicator: string; observations: { date: string; value: number | null }[]; sourceUri: string; retrievedAt: string };
    check(value.provider === 'world-bank', 'the observation came from the reviewed provider');
    check(/^[a-f0-9]{64}$/.test(providerResult.provenance.responseDigest), 'the provider response digest is captured');
    check(providerResult.provenance.sourceUri?.startsWith('https://api.worldbank.org/v2/') === true, 'the provenance records the real source URI');
    check(Number.isFinite(Date.parse(providerResult.provenance.retrievedAt)), 'the retrieval timestamp is recorded');
    check(value.indicator === created.request.indicator && value.country === created.request.country, 'the provider echoes the exact requested series');
    check(value.observations.length > 0, 'the provider returned at least one observation');
    if (!value.observations.length) blocked('the provider returned no observation for the requested series; no evidence can be produced.');

    // --- 7. Evidence, digest binding, staleness, contradiction -----------------------------
    const observation = value.observations[0]!;
    const sourceId = randomUUID() as ID, evidenceId = randomUUID() as ID;
    const digest = providerResult.provenance.responseDigest;
    await store.recordSource({
      id: sourceId, workspaceId: owner.workspaceId, operationId: created.operationId,
      uri: providerResult.provenance.sourceUri, provider: providerResult.provenance.provider,
      title: 'World Bank indicator ' + value.indicator, retrievedAt: providerResult.provenance.retrievedAt, fingerprint: digest,
    });
    await store.recordEvidence({
      id: evidenceId, operationId: created.operationId, sourceId, stepAttemptId: started.attemptId,
      statement: 'World Bank Indicators API reported ' + value.indicator + ' for ' + value.country + ' in ' + observation.date + ': ' + String(observation.value) + '.',
      observedAt: new Date().toISOString(), status: 'UNVERIFIED',
      limitations: ['Provider response has not been independently reviewed'],
    });
    await db.insert(sourceSnapshots).values({
      id: randomUUID(), workspaceId, operationId: created.operationId, sourceId,
      provider: providerResult.provenance.provider, retrievedAt: providerResult.provenance.retrievedAt,
      sha256: digest, citationUri: providerResult.provenance.sourceUri, createdAt: new Date().toISOString(),
    });
    const claims = new ClaimsService(store);
    const claim = await claims.register(owner, {
      operationId: created.operationId, attemptId: started.attemptId,
      statement: 'World Bank Indicators API reported ' + value.indicator + ' for ' + value.country + ' in ' + observation.date + ' as ' + String(observation.value) + '.',
      kind: 'PROVIDER_OBSERVATION',
    });
    await expectError('INVALID_INPUT', () => claims.attach(owner, claim.id, sourceId, 'SUPPORTS'), 'support without evidence linkage');
    await expectError('INVALID_INPUT', () => claims.attach(owner, claim.id, sourceId, 'SUPPORTS', evidenceId, '0'.repeat(64)), 'support with a forged digest');
    // P22 BIS: cross-tenant access stays non-disclosing — a principal in another workspace gets
    // NOT_FOUND for the claim, never a DENIED that would confirm the claim exists.
    await expectError('NOT_FOUND', () => claims.attach(outsider, claim.id, sourceId, 'SUPPORTS', evidenceId, digest), 'cross-workspace evidence attachment is NOT_FOUND, never DENIED');
    await claims.attach(owner, claim.id, sourceId, 'SUPPORTS', evidenceId, digest);

    const policyAssessment = await claims.assess(owner, {
      claimId: claim.id, capabilityId: template.service.capabilityId as ID, policyVersion: 1, reason: 'qa-a03 structural policy evaluation',
    });
    check(policyAssessment.status === 'NEEDS_HUMAN_REVIEW', 'structural evidence alone never promotes to SUPPORTED');
    check(policyAssessment.rationale.includes('publication freshness unknown') || policyAssessment.rationale.includes('evidence-backed'), 'the assessment states the freshness limitation');
    check(policyAssessment.sourceIds.includes(sourceId), 'the assessment records the evidence-backed source');
    await expectError('DENIED', () => claims.assess(member, {
      claimId: claim.id, capabilityId: template.service.capabilityId as ID, policyVersion: 1, reason: 'qa-a03 member review attempt', reviewerDecision: 'SUPPORTED',
    }), 'an unprivileged member cannot promote a claim');
    const reviewed = await claims.assess(owner, {
      claimId: claim.id, capabilityId: template.service.capabilityId as ID, policyVersion: 1,
      reason: 'qa-a03 reviewer compared the captured provider response with the claim text', reviewerDecision: 'SUPPORTED',
    });
    check(reviewed.status === 'SUPPORTED' && reviewed.method === 'HUMAN_REVIEW', 'an authorized human review promotes the claim');

    // Stale source (backdated QA fixture, never presented as evidence).
    const staleClaim = await claims.register(owner, { operationId: created.operationId, attemptId: started.attemptId, statement: 'QA stale-source negative fixture', kind: 'QA_NEGATIVE' });
    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, sourceId));
    check(Boolean(sourceRow), 'the captured source is persisted');
    const originalPayload = sourceRow!.payload as Source;
    await db.update(sources).set({ payload: { ...originalPayload, retrievedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() } as unknown as Source }).where(eq(sources.id, sourceId));
    await claims.attach(owner, staleClaim.id, sourceId, 'SUPPORTS', evidenceId, digest);
    const stale = await claims.assess(owner, { claimId: staleClaim.id, capabilityId: template.service.capabilityId as ID, policyVersion: 1, reason: 'qa-a03 stale source policy check' });
    check(stale.status === 'STALE', 'a source older than the policy window cannot support a claim');
    await db.update(sources).set({ payload: originalPayload }).where(eq(sources.id, sourceId));

    // Contradiction.
    const contradictionClaim = await claims.register(owner, { operationId: created.operationId, attemptId: started.attemptId, statement: 'QA contradiction negative fixture', kind: 'QA_NEGATIVE' });
    await claims.attach(owner, contradictionClaim.id, sourceId, 'SUPPORTS', evidenceId, digest);
    await claims.attach(owner, contradictionClaim.id, sourceId, 'CONTRADICTS', evidenceId, digest);
    const contradiction = await claims.assess(owner, { claimId: contradictionClaim.id, capabilityId: template.service.capabilityId as ID, policyVersion: 1, reason: 'qa-a03 contradiction policy check' });
    check(contradiction.status === 'CONFLICTING', 'qualifying contradicting evidence blocks support');

    // --- 8. Traceable deliverable ----------------------------------------------------------
    const [attemptRow] = await db.select().from(attempts).where(eq(attempts.id, started.attemptId));
    check(attemptRow?.state === 'PENDING', 'the research attempt waits for the worker');
    await db.update(attempts).set({
      state: 'RUNNING',
      payload: { ...attemptRow!.payload, state: 'RUNNING' as const, startedAt: new Date().toISOString(), version: attemptRow!.payload.version + 1 },
    }).where(and(eq(attempts.id, started.attemptId), eq(attempts.state, 'PENDING')));
    const progressionState = await new StepProgression(store).complete(started.attemptId, { text: claim.statement, sourceId, evidenceId, quality: 'UNVERIFIED' }, 'UNVERIFIED');
    check(progressionState === 'AWAITING_REVIEW', 'the plan completes and requests human review');
    check((await store.getOperation(owner, created.operationId)).status === 'WAITING_APPROVAL', 'the operation waits for an explicit result review');
    const document = await new ResultAssembler(store).assemble(owner, created.operationId, created.revisionId, 'A03 indicator finding', ['qa-a03 scope'], []);
    check(document.status === 'READY_FOR_REVIEW', 'the document is READY_FOR_REVIEW with supported, cited findings');
    check(document.citations[0]?.fingerprint === digest, 'the citation preserves the provider response digest');
    check(document.citations[0]?.uri?.includes('api.worldbank.org') === true, 'the citation carries the real provider URI');
    check(document.findings.some(finding => finding.claimId === claim.id && finding.status === 'SUPPORTED' && finding.citations.length === 1), 'the reviewed claim is a supported, cited finding');
    const [approvalRow] = await db.select().from(approvals).where(and(eq(approvals.operationId, created.operationId), eq(approvals.status, 'PENDING')));
    check(approvalRow?.payload.purpose === 'RESULT_REVIEW', 'a RESULT_REVIEW approval is pending');
    const delivery = new ResultDeliveryService(store);
    await expectError('DENIED', () => delivery.deliver(owner, created.operationId, document.id, approvalRow!.id as ID), 'delivery before approval');
    const decided = await new OperationControlService(store).decideApproval(owner, approvalRow!.id as ID, 'APPROVED', created.operationId);
    check(decided.status === 'APPROVED', 'the human result review is recorded');
    const delivered = await delivery.deliver(owner, created.operationId, document.id, approvalRow!.id as ID);
    check(delivered.status === 'DELIVERABLE' && delivered.operationStatus === 'COMPLETED', 'the reviewed document is delivered as DELIVERABLE');
    check(delivered.documentId !== document.id && delivered.previousDocumentId === document.id, 'delivery appends an immutable version');

    console.log('REAL_PROVIDER_READ ' + JSON.stringify({
      operationId: created.operationId, indicator: value.indicator, country: value.country,
      observation: { date: observation.date, value: observation.value },
      sourceUri: providerResult.provenance.sourceUri, responseDigest: digest,
      retrievedAt: providerResult.provenance.retrievedAt, policyStatus: policyAssessment.status,
      claimStatus: reviewed.status, documentId: delivered.documentId, documentStatus: delivered.status,
    }));
    console.log('  PART 2 PASSED: cumulative ' + assertions + ' assertions');
    return 'PASSED';
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : error));
  }
}

partOne();
try {
  const integration = await partTwo();
  if (integration === 'BLOCKED') {
    console.log('A03 SERVICE QA PARTIAL — PART 1 PASSED (' + assertions + ' assertions), PART 2 BLOCKED.');
    console.log('This run is NOT integration evidence: the database-backed chain and the live provider were not exercised.');
    process.exit(BLOCKED);
  }
  console.log('A03 SERVICE QA PASSED: ' + assertions + ' assertions (PART 1 definition + PART 2 integration).');
  process.exit(PASS);
} catch (error: unknown) {
  if (error instanceof BlockedSignal) {
    console.log('BLOCKED: ' + error.reason);
    console.log('A03 SERVICE QA PARTIAL — PART 1 PASSED, PART 2 BLOCKED (' + assertions + ' assertions before the block).');
    console.log('This run is NOT integration evidence for the provider chain.');
    process.exit(BLOCKED);
  }
  console.error('A03 SERVICE QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(FAILED);
}
