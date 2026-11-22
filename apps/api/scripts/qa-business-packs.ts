import { prepareQaPackStep } from './qa-pack-step';
/**
 * MISSION A16 — Eight Business Capability Packs QA (pure contract matrix + isolated PostgreSQL + real HTTP).
 *
 * Verifies all eight distinct, operator-editable business capability packs:
 *   1. research            (Slot 1 · research-pack@1 · world-bank:indicator@1)
 *   2. strategy            (Slot 2 · strategy-pack@1 · brave-search:web@1)
 *   3. marketing           (Slot 3 · marketing-pack@1 · brave-search:web@1)
 *   4. seo                 (Slot 4 · seo-pack@1 · brave-search:web@1)
 *   5. sales               (Slot 5 · sales-pack@1 · brave-search:web@1)
 *   6. operations          (Slot 6 · operations-pack@1 · brave-search:web@1)
 *   7. financial-analysis  (Slot 7 · financial-analysis-pack@1 · world-bank:indicator@1)
 *   8. content             (Slot 8 · content-pack@1 · brave-search:web@1)
 *
 * Run: pnpm qa:business-packs   (uses QEYNOX_QA_DATABASE_URL for PART 2; disposable QA DB only)
 * Exit: 0 PASS · 3 BLOCKED (PART 1 passed, no disposable DB for PART 2) · 1 FAILED
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  BUSINESS_PACK_DOMAINS,
  PACK_CONTRACT_KEYS,
  SERVICE_CONTRACT_CONTENT_PACK,
  SERVICE_CONTRACT_FINANCIAL_PACK,
  SERVICE_CONTRACT_MARKETING_PACK,
  SERVICE_CONTRACT_OPERATIONS_PACK,
  SERVICE_CONTRACT_RESEARCH_PACK,
  SERVICE_CONTRACT_SALES_PACK,
  SERVICE_CONTRACT_SEO_PACK,
  SERVICE_CONTRACT_STRATEGY_PACK,
  applyConfigurationSchema,
  packServiceConfigSchema,
  serviceDetailSchema,
  serviceListSchema,
  servicePreviewResultSchema,
  serviceRequestEnvelopeSchema,
  serviceRequestResultSchema,
  serviceValidationReportSchema,
  type BusinessPackDomain,
  type ConfigurationEntry,
  type PackDeliverable,
  type PackServiceConfig,
} from '@qeynox/contracts';
import { DomainError, type CapabilityDefinition, type ID, type Principal } from '@qeynox/domain';
import type { EngineOutcome, EnginePort } from '@qeynox/engine';
import {
  QeyNoxStore,
  approvals,
  attempts,
  claims,
  connectDatabase,
  identityMemberships,
  identityUsers,
  identityWorkspaces,
  platformAdminAssignments,
  resultDocuments,
  runMigrations,
  sourceSnapshots,
} from '@qeynox/persistence';
import { CapabilityRegistry, PlanProposalService } from '@qeynox/roles';
import {
  BraveSearchConnector,
  EgressPolicy,
  PgToolLedger,
  ToolBroker,
  ToolRegistry,
  braveSearchManifest,
  type ConnectorCall,
  type PermissionContext,
} from '@qeynox/tools';
import {
  CapabilityCatalogueService,
  ClaimsService,
  CommerceService,
  ConfigurationService,
  DELIVERABLE_SECTIONS_BY_PACK,
  OperationControlService,
  OperationExecutionService,
  REQUIRED_PROVIDER_BY_PACK,
  ResultAssembler,
  ResultDeliveryService,
  StepProgression,
  UNAVAILABLE_CONNECTORS_BY_PACK,
  buildPackPlanProposal,
  computeFinancialSensitivity,
  computeProcessDiagnostics,
  exportHtml,
  exportJson,
  extractStructuredDeliverableFromJson,
  projectDeliverableToResultSummary,
  validatePackDeliverable,
  validateServiceConfiguration,
  type RuntimeReadiness,
} from '@qeynox/application';
import { AppModule } from '../src/app.module';
import { peekWorkspaceBudget } from '../src/pilot/pilot.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import { seedQaBetaGrant } from './qa-beta-fixture';
import { VALID_PACK_REQUESTS, buildValidDeliverables } from './qa-pack-fixtures';
import { makeRuntimeReadiness as qaRuntimeFixture } from '@qeynox/application';
// A21.07 QA fixture (test infrastructure only): this suite exercises launches, not runtime probing.
// The launch gate itself is proven against real probes in qa:runtime-verification.
const qaVerifiedRuntime = () => qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-fixture:qa-business-packs', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-fixture:qa-business-packs' });

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const suiteBundlePath = resolve(repoRoot, 'infra/operator/a16-business-packs.json');
const standalonePackPaths = [
  'infra/operator/packs/01-research.json',
  'infra/operator/packs/02-strategy.json',
  'infra/operator/packs/03-marketing.json',
  'infra/operator/packs/04-seo.json',
  'infra/operator/packs/05-sales.json',
  'infra/operator/packs/06-operations.json',
  'infra/operator/packs/07-financial-analysis.json',
  'infra/operator/packs/08-content.json',
].map(rel => resolve(repoRoot, rel));

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

function expectSyncDomainError(code: string, run: () => unknown, label: string): void {
  assertions++;
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error(`EXPECTED ${code} for ${label}, got ${error instanceof DomainError ? error.code : String(error)}`);
  }
  throw new Error(`EXPECTED ${code} for ${label}, but no error was thrown`);
}

async function expectAsyncDomainError(code: string, run: () => Promise<unknown>, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error(`EXPECTED ${code} for ${label}, got ${error instanceof DomainError ? error.code : String(error)}`);
  }
  throw new Error(`EXPECTED ${code} for ${label}, but no error was thrown`);
}

function capabilityFromBundle(entries: readonly ConfigurationEntry[]): CapabilityDefinition {
  const entry = entries.find(e => e.domain === 'BUSINESS_CAPABILITY');
  if (!entry || entry.domain !== 'BUSINESS_CAPABILITY') throw new Error('Missing BUSINESS_CAPABILITY entry');
  return {
    id: `capability-slot-${String(entry.slot)}-v${String(entry.version)}` as ID,
    slot: entry.slot as CapabilityDefinition['slot'],
    version: entry.version,
    status: entry.status,
    name: entry.name,
    purpose: entry.purpose,
    scope: entry.scope,
    allowedTools: entry.allowedTools,
    privacyScopes: entry.privacyScopes,
    inputSchemaVersion: entry.inputSchemaVersion,
    outputSchemaVersion: entry.outputSchemaVersion,
    maximumSteps: entry.maximumSteps,
    maximumToolCalls: entry.maximumToolCalls,
  };
}

// A21.07: built through the labelled QA builder so the fixture carries a full VERIFIED record.
const OPERATIONAL_RUNTIME: RuntimeReadiness = qaRuntimeFixture({ engineVerifiedLive: true, engineEvidence: 'qa-a16-fixture', orchestratorVerifiedLive: true, orchestratorEvidence: 'qa-a16-fixture' });

// =============================================================================================
// PART 1 — Pure Contract, Bundle, Planning DAG, Math & Deliverable Verification (Zero DB)
// =============================================================================================

console.log('— PART 1: operator bundles, typed request contracts, DAG planners, math & deliverable validators —');

const standaloneBundles = standalonePackPaths.map(filePath => {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
    idempotencyKey: string;
    service: unknown;
    entries: unknown[];
  };
  const parsedEntries = applyConfigurationSchema.parse({
    idempotencyKey: raw.idempotencyKey,
    entries: raw.entries,
  });
  const parsedService = packServiceConfigSchema.parse(raw.service);
  return { filePath, entries: parsedEntries.entries, service: parsedService };
});

check(standaloneBundles.length === 8, '8 standalone operator pack bundles loaded and validated');
const seenDomains = new Set(standaloneBundles.map(b => b.service.pack));
const seenSlots = new Set<number>();
const seenOffers = new Set<string>();
for (const domain of BUSINESS_PACK_DOMAINS) {
  check(seenDomains.has(domain), `standalone bundle exists for domain '${domain}'`);
}

for (const bundle of standaloneBundles) {
  const cap = capabilityFromBundle(bundle.entries);
  seenSlots.add(cap.slot);
  seenOffers.add(bundle.service.offerId);
  check(cap.maximumSteps >= 3 && cap.maximumSteps <= 10, `${bundle.service.pack} has bounded maximumSteps`);
  check(cap.maximumToolCalls >= 1 && cap.maximumToolCalls <= 10, `${bundle.service.pack} has bounded maximumToolCalls`);
  const profile = bundle.entries.find(e => e.domain === 'AGENT_PROFILE');
  check(profile?.domain === 'AGENT_PROFILE' && profile.slot === cap.slot, `${bundle.service.pack} has matching AGENT_PROFILE slot`);
  check(
    profile?.domain === 'AGENT_PROFILE' && profile.systemInstructions.includes(`${bundle.service.pack}@1`),
    `${bundle.service.pack} agent instructions mandate versioned ${bundle.service.pack}@1 JSON deliverable`,
  );
  const policy = bundle.entries.find(e => e.domain === 'VERIFICATION_POLICY');
  check(policy?.domain === 'VERIFICATION_POLICY' && policy.humanReviewRequired === true, `${bundle.service.pack} mandates humanReviewRequired=true`);
  const expectedProvider = REQUIRED_PROVIDER_BY_PACK[bundle.service.pack];
  check(
    policy?.domain === 'VERIFICATION_POLICY' && policy.approvedProviders.includes(expectedProvider),
    `${bundle.service.pack} verification policy approves ${expectedProvider}`,
  );
  if (expectedProvider === 'brave-search') {
    check(cap.privacyScopes.includes('web:search'), `${bundle.service.pack} declares web:search consent scope`);
  }
}
check(seenSlots.size === 8, 'all 8 capability slots (1..8) are uniquely assigned across the 8 packs');
check(seenOffers.size === 8, 'all 8 RaaS offerIds are unique across the 8 packs');

const suiteRaw = JSON.parse(readFileSync(suiteBundlePath, 'utf8')) as {
  idempotencyKey: string;
  services: unknown[];
  entries: unknown[];
};
const parsedSuiteApply = applyConfigurationSchema.parse({
  idempotencyKey: suiteRaw.idempotencyKey,
  entries: suiteRaw.entries,
});
const parsedSuiteServices = suiteRaw.services.map(s => packServiceConfigSchema.parse(s));
check(parsedSuiteServices.length === 8, 'a16-business-packs.json registers all 8 pack service configs');
check(parsedSuiteApply.entries.some(e => e.domain === 'SOUL_PROFILE'), 'suite bundle includes SOUL_PROFILE');
check(parsedSuiteApply.entries.some(e => e.domain === 'PILOT_PROFILE'), 'suite bundle includes PILOT_PROFILE');

// Test normalization, envelopes, planning DAGs, allowlists & ceilings across all 8 packs
for (const bundle of standaloneBundles) {
  const pack = bundle.service.pack;
  const cap = capabilityFromBundle(bundle.entries);
  const validInput = VALID_PACK_REQUESTS[pack];
  const contractKey = PACK_CONTRACT_KEYS[pack];

  // Envelope acceptance & mismatch rejection
  const envOk = serviceRequestEnvelopeSchema.safeParse({ service: contractKey, input: validInput });
  check(envOk.success, `serviceRequestEnvelopeSchema accepts valid '${contractKey}' request`);
  const envWrongShape = serviceRequestEnvelopeSchema.safeParse({ service: contractKey, input: { objective: 'too short' } });
  check(!envWrongShape.success, `serviceRequestEnvelopeSchema rejects malformed '${contractKey}' request`);

  // Plan proposal DAG & determinism
  const proposal1 = buildPackPlanProposal(bundle.service, cap, validInput);
  const proposal2 = buildPackPlanProposal(bundle.service, cap, validInput);
  check(proposal1.fingerprint === proposal2.fingerprint, `${pack} request fingerprint is deterministic`);
  check(proposal1.steps.length >= 3 && proposal1.steps.length <= cap.maximumSteps, `${pack} plan has bounded multi-step DAG`);
  check(proposal1.estimatedToolCalls <= cap.maximumToolCalls, `${pack} estimatedToolCalls respects capability ceiling`);
  check(proposal1.requiresUserApproval === true, `${pack} plan requires explicit user approval`);
  check(proposal1.steps[0]!.title.includes(cap.name ?? ''), `${pack} plan step carries live operator capability name`);
  check(proposal1.steps[0]!.description.includes(bundle.service.specialization), `${pack} plan step carries live operator specialization`);
  check(proposal1.steps.at(-1)!.intent === 'VERIFY', `${pack} plan ends with an explicit VERIFY step`);
  check(proposal1.steps.every(s => s.intent !== 'EXTERNAL_ACTION'), `${pack} plan never schedules unreviewed EXTERNAL_ACTION steps`);

  // Verify capability step ceiling fails closed rather than truncating
  const tightStepCap: CapabilityDefinition = { ...cap, maximumSteps: 1 };
  expectSyncDomainError(
    'INVALID_INPUT',
    () => buildPackPlanProposal(bundle.service, tightStepCap, validInput),
    `${pack} refuses when plan steps exceed capability.maximumSteps`,
  );
  if (proposal1.estimatedToolCalls > 0) {
    const zeroToolCap: CapabilityDefinition = { ...cap, maximumToolCalls: 0 };
    expectSyncDomainError(
      'INVALID_INPUT',
      () => buildPackPlanProposal(bundle.service, zeroToolCap, validInput),
      `${pack} refuses when tool calls exceed capability.maximumToolCalls`,
    );
  }
}

// Pack-specific DAG & domain guard assertions
{
  const researchBundle = standaloneBundles.find(b => b.service.pack === 'research')!;
  const researchCap = capabilityFromBundle(researchBundle.entries);
  const resPlan = buildPackPlanProposal(researchBundle.service, researchCap, VALID_PACK_REQUESTS.research);
  // 2 indicators for MA + 1 benchmark for FR = 3 parallel RESEARCH steps -> 1 fan-in ANALYZE ([0,1,2]) -> 1 VERIFY ([3])
  check(resPlan.steps.length === 5, 'research pack with comparison + benchmark builds 5-step fan-in DAG');
  check(
    JSON.stringify(resPlan.steps[3]!.dependsOnIndices) === JSON.stringify([0, 1, 2]),
    'research ANALYZE step fans in all 3 parallel RESEARCH steps',
  );
  expectSyncDomainError(
    'DENIED',
    () => buildPackPlanProposal(researchBundle.service, researchCap, { ...(VALID_PACK_REQUESTS.research as object), primaryCountry: 'ZZZ' }),
    'research pack denies unallowed country',
  );
  expectSyncDomainError(
    'INVALID_INPUT',
    () => buildPackPlanProposal(researchBundle.service, researchCap, { ...(VALID_PACK_REQUESTS.research as object), benchmarkCountry: 'MA' }),
    'research pack rejects identical primary and benchmark country',
  );

  const strategyBundle = standaloneBundles.find(b => b.service.pack === 'strategy')!;
  const strategyCap = capabilityFromBundle(strategyBundle.entries);
  const stratPlan = buildPackPlanProposal(strategyBundle.service, strategyCap, VALID_PACK_REQUESTS.strategy);
  check(
    stratPlan.steps[0]!.intent === 'RESEARCH' &&
      stratPlan.steps[1]!.intent === 'RESEARCH' &&
      JSON.stringify(stratPlan.steps[2]!.dependsOnIndices) === JSON.stringify([0, 1]),
    'strategy pack builds parallel market + competitor RESEARCH branches fanning into ANALYZE',
  );
  const narrowedStrategy: PackServiceConfig = {
    ...(strategyBundle.service as Extract<PackServiceConfig, { pack: 'strategy' }>),
    allowedFrameworks: ['PORTER_FIVE_FORCES'],
  };
  expectSyncDomainError(
    'DENIED',
    () => buildPackPlanProposal(narrowedStrategy, strategyCap, VALID_PACK_REQUESTS.strategy),
    'strategy pack enforces operator allowedFrameworks',
  );

  const marketingBundle = standaloneBundles.find(b => b.service.pack === 'marketing')!;
  const marketingCap = capabilityFromBundle(marketingBundle.entries);
  expectSyncDomainError(
    'INVALID_INPUT',
    () => buildPackPlanProposal(marketingBundle.service, marketingCap, {
      ...(VALID_PACK_REQUESTS.marketing as object),
      candidateChannels: ['ORGANIC_SEARCH', 'ORGANIC_SEARCH'],
    }),
    'marketing pack rejects duplicate channels',
  );

  const seoBundle = standaloneBundles.find(b => b.service.pack === 'seo')!;
  const seoCap = capabilityFromBundle(seoBundle.entries);
  expectSyncDomainError(
    'INVALID_INPUT',
    () => buildPackPlanProposal(seoBundle.service, seoCap, {
      ...(VALID_PACK_REQUESTS.seo as object),
      auditedUrls: ['https://other-domain.example.com/page'],
    }),
    'seo pack rejects auditedUrls outside target domain',
  );
  expectSyncDomainError(
    'DENIED',
    () => buildPackPlanProposal(seoBundle.service, seoCap, {
      ...(VALID_PACK_REQUESTS.seo as object),
      country: 'BR',
    }),
    'seo pack denies country outside operator allowlist',
  );

  const salesBundle = standaloneBundles.find(b => b.service.pack === 'sales')!;
  const salesCap = capabilityFromBundle(salesBundle.entries);
  expectSyncDomainError(
    'INVALID_INPUT',
    () => buildPackPlanProposal(salesBundle.service, salesCap, {
      ...(VALID_PACK_REQUESTS.sales as object),
      buyerPersonas: ['jane.doe@atlas-group.example'],
    }),
    'sales pack rejects personal email in buyerPersonas',
  );

  const opsBundle = standaloneBundles.find(b => b.service.pack === 'operations')!;
  const opsCap = capabilityFromBundle(opsBundle.entries);
  const opsWithBench = buildPackPlanProposal(opsBundle.service, opsCap, VALID_PACK_REQUESTS.operations);
  const opsLocalOnly = buildPackPlanProposal(opsBundle.service, opsCap, {
    ...(VALID_PACK_REQUESTS.operations as object),
    includeExternalBenchmarks: false,
  });
  check(opsWithBench.steps.length === 3 && opsWithBench.estimatedToolCalls === 1, 'operations with benchmarks has 3 steps and 1 tool call');
  check(opsLocalOnly.steps.length === 2 && opsLocalOnly.estimatedToolCalls === 0, 'operations without benchmarks has 2 steps and 0 tool calls');
  check(
    opsWithBench.computedMetrics?.['baselineCycleHoursTotal'] === 56 &&
      opsWithBench.computedMetrics?.['exceedsTargetSla'] === true &&
      opsWithBench.computedMetrics?.['primaryBottleneckStage'] === 'Security & Egress Review',
    'operations deterministic diagnostics compute exact cycle sum, SLA breach, and bottleneck stage',
  );

  const finBundle = standaloneBundles.find(b => b.service.pack === 'financial-analysis')!;
  const finCap = capabilityFromBundle(finBundle.entries);
  const finPlan = buildPackPlanProposal(finBundle.service, finCap, VALID_PACK_REQUESTS['financial-analysis']);
  check(
    finPlan.computedMetrics?.['monthlyGrossProfitMinor'] === 8_000_000 &&
      finPlan.computedMetrics?.['monthlyNetCashFlowMinor'] === -2_500_000 &&
      finPlan.computedMetrics?.['impliedRunwayMonths'] === 24 &&
      finPlan.computedMetrics?.['cacPaybackMonths'] === 5,
    'financial-analysis deterministic engine computes exact gross profit, burn, 24m runway, and 5m CAC payback',
  );
  expectSyncDomainError(
    'DENIED',
    () => buildPackPlanProposal(finBundle.service, finCap, {
      ...(VALID_PACK_REQUESTS['financial-analysis'] as object),
      reportingCurrency: 'JPY',
    }),
    'financial-analysis pack denies currency outside operator allowlist',
  );

  const contentBundle = standaloneBundles.find(b => b.service.pack === 'content')!;
  const contentCap = capabilityFromBundle(contentBundle.entries);
  const contentFull = buildPackPlanProposal(contentBundle.service, contentCap, VALID_PACK_REQUESTS.content);
  const contentBriefOnly = buildPackPlanProposal(contentBundle.service, contentCap, {
    ...(VALID_PACK_REQUESTS.content as object),
    includeFullDraft: false,
  });
  check(contentFull.steps.length === 4 && contentBriefOnly.steps.length === 3, 'content pack toggles full-draft ANALYZE step cleanly');
}

// Structured deliverable validation & anti-fabrication rejection across all 8 packs
const validDeliverables = buildValidDeliverables();
const expectedOpsDiag = computeProcessDiagnostics(
  (VALID_PACK_REQUESTS.operations as { workflowStages: Parameters<typeof computeProcessDiagnostics>[0] }).workflowStages,
  48,
);
const expectedFinSens = computeFinancialSensitivity(
  (VALID_PACK_REQUESTS['financial-analysis'] as { baselineMetrics: Parameters<typeof computeFinancialSensitivity>[0] }).baselineMetrics,
  (VALID_PACK_REQUESTS['financial-analysis'] as { scenarios: Parameters<typeof computeFinancialSensitivity>[1] }).scenarios,
);

for (const pack of BUSINESS_PACK_DOMAINS) {
  check(DELIVERABLE_SECTIONS_BY_PACK[pack].length >= 4, `${pack} declares structured deliverable sections`);
  const { deliverable, capturedUris } = validDeliverables[pack];
  const fencedJson = '```json\n' + JSON.stringify(deliverable, null, 2) + '\n```';
  const parsed = extractStructuredDeliverableFromJson(pack, fencedJson, {
    capturedSourceUris: capturedUris,
    ...(pack === 'operations' ? { expectedDiagnostics: expectedOpsDiag } : {}),
    ...(pack === 'financial-analysis' ? { expectedSensitivity: expectedFinSens } : {}),
  });
  check(parsed.pack === pack, `extractStructuredDeliverableFromJson validates '${pack}' deliverable`);
  const projected = projectDeliverableToResultSummary(parsed);
  check(projected.title.length > 10 && projected.limitations.length >= 1 && projected.nextActions.length >= 1, `${pack} deliverable projects cleanly to ResultDocument summary`);

  // Uncaptured URI must be rejected
  expectSyncDomainError(
    'INVALID_INPUT',
    () => validatePackDeliverable(pack, deliverable, { capturedSourceUris: ['https://unrelated.example.org/only'] }),
    `${pack} deliverable rejects uncaptured source URI`,
  );
}

// Domain-specific anti-fabrication checks
expectSyncDomainError(
  'INVALID_INPUT',
  () => validatePackDeliverable('sales', {
    ...validDeliverables.sales.deliverable,
    stakeholderRoleMap: [{
      roleTitle: 'COO — reach directly at john.smith@atlas-group.example',
      primaryEvaluationCriteria: ['Speed'],
      discoveryQuestions: ['When can we meet?'],
    }],
  }),
  'sales deliverable validator rejects personal email addresses',
);
expectSyncDomainError(
  'INVALID_INPUT',
  () => validatePackDeliverable('marketing', {
    ...validDeliverables.marketing.deliverable,
    messagingPillars: [{
      pillar: 'Guaranteed ROI within 14 days',
      targetPain: 'Slow pipeline',
      proofRequired: 'Case study',
      copyAngle: 'We deliver guaranteed ROI for every SaaS buyer.',
    }],
  }),
  'marketing deliverable validator rejects guaranteed-ROI claims',
);
expectSyncDomainError(
  'INVALID_INPUT',
  () => validatePackDeliverable('seo', {
    ...validDeliverables.seo.deliverable,
    urlFindings: [{
      url: 'https://foreign-domain.example.org/services',
      issueCategory: 'METADATA',
      finding: 'Missing meta description tag on main page',
      evidenceBasis: 'SERP_OBSERVED',
      priority: 'P2',
      remediation: 'Add concise meta description matching commercial search intent.',
    }],
  }),
  'seo deliverable validator rejects URLs outside audited domain',
);
expectSyncDomainError(
  'INVALID_INPUT',
  () => validatePackDeliverable(
    'operations',
    { ...validDeliverables.operations.deliverable, baselineCycleHoursTotal: 999 },
    { expectedDiagnostics: expectedOpsDiag },
  ),
  'operations deliverable validator rejects cycle-time arithmetic mismatch',
);
expectSyncDomainError(
  'INVALID_INPUT',
  () => validatePackDeliverable(
    'financial-analysis',
    {
      ...validDeliverables['financial-analysis'].deliverable,
      unitEconomicsSummary: {
        ...(validDeliverables['financial-analysis'].deliverable as Extract<PackDeliverable, { pack: 'financial-analysis' }>).unitEconomicsSummary,
        monthlyNetCashFlowMinor: 999_999,
      },
    },
    { expectedSensitivity: expectedFinSens },
  ),
  'financial-analysis deliverable validator rejects net-cash-flow arithmetic drift',
);

console.log(`  PART 1 PASSED: ${assertions} assertions`);

// =============================================================================================
// PART 2 — Isolated PostgreSQL, Operator Editability, Validator, Pilot, HTTP API & Execution
// =============================================================================================

console.log('— PART 2: isolated DB, operator customization, validator, Pilot, real HTTP API & execution —');

const qa = await createIsolatedQaDatabase();
process.env.DATABASE_URL = qa.url;
process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
process.env.QEYNOX_SERVICE_CATALOG_PATH = suiteBundlePath;
process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
process.env.QEYNOX_BRAVE_SEARCH_ENABLED = 'false';
delete process.env.QEYNOX_BRAVE_SEARCH_API_KEY;
process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';

let app: INestApplication | undefined;
let connection: ReturnType<typeof connectDatabase> | undefined;

try {
  const mig = await runMigrations(qa.url);
  check(mig.applied.length === mig.total && mig.total > 0, 'all migrations applied cleanly on disposable QA database');

  connection = connectDatabase(qa.url);
  const db = connection.db;
  const store = new QeyNoxStore(db);

  // Create Workspace A (configured operator workspace) and Workspace B (isolated tenant)
  const operatorId = randomUUID();
  const memberId = randomUUID();
  const foreignUserId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();

  await db.insert(identityUsers).values([
    { id: operatorId, email: `qa-a16-op-${operatorId}@example.invalid` },
    { id: memberId, email: `qa-a16-mem-${memberId}@example.invalid` },
    { id: foreignUserId, email: `qa-a16-foreign-${foreignUserId}@example.invalid` },
  ]);
  await db.insert(identityWorkspaces).values([
    { id: workspaceA, name: 'QA A16 Primary Workspace', createdBy: operatorId },
    { id: workspaceB, name: 'QA A16 Foreign Workspace', createdBy: foreignUserId },
  ]);
  await db.insert(identityMemberships).values([
    { id: randomUUID(), userId: operatorId, workspaceId: workspaceA, role: 'OWNER', status: 'ACTIVE' },
    { id: randomUUID(), userId: memberId, workspaceId: workspaceA, role: 'MEMBER', status: 'ACTIVE' },
    { id: randomUUID(), userId: foreignUserId, workspaceId: workspaceB, role: 'OWNER', status: 'ACTIVE' },
  ]);
  // A21.02: launches and provider spend require an ACTIVE beta grant (explicit QA precondition).
  await seedQaBetaGrant(db, workspaceA);

  const operator: Principal = { userId: operatorId as ID, workspaceId: workspaceA as ID, roles: ['OWNER', 'ADMIN'] };
  const member: Principal = { userId: memberId as ID, workspaceId: workspaceA as ID, roles: ['MEMBER'] };
  process.env.QEYNOX_OPERATOR_USER_IDS = operatorId;

  // --- 1. Apply unified 8-pack suite via ConfigurationService & verify idempotency ------------
  const configService = new ConfigurationService(store);
  const applied = await configService.apply(operator, {
    idempotencyKey: parsedSuiteApply.idempotencyKey,
    entries: parsedSuiteApply.entries,
  });
  check(applied.changes.length === 37 && !applied.alreadyApplied, 'applied all 37 configuration entries for the 8-pack suite');

  const replayed = await configService.apply(operator, {
    idempotencyKey: parsedSuiteApply.idempotencyKey,
    entries: parsedSuiteApply.entries,
  });
  check(replayed.alreadyApplied === true, 'replaying suite configuration with same idempotencyKey is idempotent');

  // --- 2. Capability catalogue across all 8 slots (unattested vs operational runtime) ---------
  const unattestedCapCatalogue = new CapabilityCatalogueService(store);
  const unattestedCaps = await unattestedCapCatalogue.list(member);
  check(unattestedCaps.slots.length === 8, 'capability catalogue exposes all 8 slots');
  check(unattestedCaps.slots.every(s => s.capability !== null && s.status === 'ACTIVE'), 'all 8 slots are configured and ACTIVE');
  check(unattestedCaps.slots.every(s => s.available === false && s.capability?.isExecutable === false), 'without attested runtime no slot claims executable');

  const attestedCapCatalogue = new CapabilityCatalogueService(store, () => OPERATIONAL_RUNTIME);
  const attestedCaps = await attestedCapCatalogue.list(member);
  check(attestedCaps.slots.every(s => s.operationalState === 'OPERATIONAL' && s.available === true), 'with attested runtime and configured providers/profiles/policies all 8 slots are OPERATIONAL');

  // --- 3. Service configuration validator across all 8 packs ----------------------------------
  for (const svc of parsedSuiteServices) {
    const expectedProvider = REQUIRED_PROVIDER_BY_PACK[svc.pack];
    const report = await validateServiceConfiguration(store, {
      workspaceId: workspaceA,
      capabilityId: svc.capabilityId,
      offerId: svc.offerId,
      expectedProvider,
      maximumIterations: 5,
    });
    check(
      report.valid === true && report.findings.filter(f => f.severity === 'BLOCKER').length === 0,
      `validateServiceConfiguration passes for '${svc.pack}' (${svc.offerId}, provider=${expectedProvider})`,
    );
  }

  // Defect detection: provider mismatch & missing consent scope
  const mismatchReport = await validateServiceConfiguration(store, {
    workspaceId: workspaceA,
    capabilityId: 'capability-slot-2-v1',
    offerId: 'offer-strategy-pack-v1',
    expectedProvider: 'world-bank',
    maximumIterations: 5,
  });
  check(
    !mismatchReport.valid && mismatchReport.findings.some(f => f.code === 'POLICY_PROVIDER_MISMATCH'),
    'validator catches provider mismatch on Brave-backed pack when validated against world-bank',
  );

  // --- 4. Operator editability of names, specialization & allowlists (live v2 update) ---------
  await configService.apply(operator, {
    idempotencyKey: 'qa-a16-operator-customization-slot2-v2',
    entries: [
      {
        domain: 'BUSINESS_CAPABILITY',
        slot: 2,
        version: 2,
        status: 'ACTIVE',
        name: 'MENA & EU FinTech Positioning Practice',
        purpose: 'Operator-customized strategic positioning capability focused on regulated FinTech and payment institutions.',
        scope: ['fintech-positioning', 'regulatory-market-entry'],
        allowedTools: ['brave-search:web@1'],
        privacyScopes: ['web:search'],
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
        maximumSteps: 5,
        maximumToolCalls: 6,
      },
      {
        domain: 'AGENT_PROFILE',
        slot: 2,
        version: 2,
        status: 'ACTIVE',
        title: 'MENA & EU FinTech Strategy Lead',
        systemInstructions: 'You are the operator-customized FinTech Strategy Lead (Slot 2). Cite all public sources via brave-search:web@1 and emit valid strategy@1 JSON.',
        skillRefs: ['strategy:fintech-market-entry'],
        allowedTools: ['brave-search:web@1'],
        permittedContextKeys: ['goal:statement', 'step:input', 'prior:summaries'],
        maxOutputTokens: 3200,
        maxIterations: 5,
      },
      {
        domain: 'VERIFICATION_POLICY',
        capabilityId: 'capability-slot-2-v2',
        version: 1,
        status: 'ACTIVE',
        minimumSources: 2,
        maxAgeDays: 180,
        approvedProviders: ['brave-search'],
        humanReviewRequired: true,
        validFrom: '2026-01-01T00:00:00.000Z',
      },
      {
        domain: 'RAAS_OFFER',
        offerId: 'offer-strategy-pack-v1',
        version: 2,
        status: 'ACTIVE',
        label: 'FinTech & Payments Market Entry Dossier (Operator v2)',
        capabilityIds: ['capability-slot-2-v2'],
        deliverableSchemaVersion: 1,
        scope: ['Regulated FinTech competitor positioning', 'Market Entry Scorecard'],
        exclusions: ['Not legal licensing advice'],
        regions: ['EMEA'],
        locales: ['en', 'fr'],
        termsVersion: '2026-11-a16-v2',
        currency: 'EUR',
        amountMinor: 39000,
        taxPolicy: 'CONFIGURED',
        isExplicitlyFree: false,
      },
    ],
  });

  const customizedStrategyConfig = packServiceConfigSchema.parse({
    pack: 'strategy',
    capabilityId: 'capability-slot-2-v2',
    offerId: 'offer-strategy-pack-v1',
    budgetPolicyId: 'budget-business-packs-suite-v1',
    displayName: 'FinTech & Payments Market Entry Dossier',
    specialization: 'Regulated FinTech positioning across EU PSD3 and Bank Al-Maghrib payment frameworks',
    allowedFrameworks: ['MARKET_ENTRY_SCORECARD'],
    allowedHorizons: ['90_DAYS', '6_MONTHS'],
    maxCompetitors: 3,
  });
  const capSlot2V2 = await store.getCapability('capability-slot-2-v2' as ID);
  check(capSlot2V2?.name === 'MENA & EU FinTech Positioning Practice', 'operator v2 capability rename persisted and active');
  expectSyncDomainError(
    'DENIED',
    () => buildPackPlanProposal(customizedStrategyConfig, capSlot2V2, VALID_PACK_REQUESTS.strategy),
    'operator narrowed allowedFrameworks immediately denies POSITIONING_MATRIX',
  );
  const customPlan = buildPackPlanProposal(customizedStrategyConfig, capSlot2V2, {
    ...(VALID_PACK_REQUESTS.strategy as object),
    framework: 'MARKET_ENTRY_SCORECARD',
  });
  check(
    customPlan.steps[0]!.title.includes('MENA & EU FinTech Positioning Practice') &&
      customPlan.steps[0]!.description.includes('Bank Al-Maghrib') &&
      customPlan.goalSummary.includes('FinTech & Payments Market Entry Dossier'),
    'operator-edited capability name, displayName, and specialization propagate into generated plans',
  );

  // Restore Slot 2 v1 compatibility by publishing v3 matching suite capabilityId or re-pointing suite catalog for HTTP test:
  // Let's publish offer v3 covering capability-slot-2-v2? Even better: let's check how clean it is to write an updated temp catalog or publish capability-slot-2-v1 back? Wait: capability-slot-2-v2 superseded v1 on slot 2!
  // That's a real invariant (`capability_active_slot_unique`)! So let's write a disposable temp catalog JSON in /tmp pointing slot 2 at capability-slot-2-v2 with the operator's customized displayName & specialization — proving the HTTP API serves the operator-customized v2 pack live!
  const customizedCatalogPath = `/tmp/qa-a16-catalog-${randomUUID()}.json`;
  const customizedSuiteServices = parsedSuiteServices.map(s =>
    s.pack === 'strategy' ? customizedStrategyConfig : s,
  );
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(customizedCatalogPath, JSON.stringify({ services: customizedSuiteServices }, null, 2));
  process.env.QEYNOX_SERVICE_CATALOG_PATH = customizedCatalogPath;

  // --- 5. Pilot Planner multi-slot composition across active 8-pack capabilities --------------
  const activeCaps = (await store.getCapabilities()).filter(c => c.status === 'ACTIVE');
  check(activeCaps.length === 8, 'exactly 8 ACTIVE capabilities (one per slot 1..8) after v2 supersession');
  const capRegistry = new CapabilityRegistry(activeCaps);
  const crossPackOp = await store.createOperation(
    operator,
    'Cross-pack expansion assessment',
    'Assess Morocco macro indicators, model 12-month unit economics, and define FinTech market entry options',
    ['Public evidence only'],
  );
  const multiSlotProposalOutput = {
    summary: 'Three-slot cross-pack plan combining Research (Slot 1), Financial Analysis (Slot 7), and FinTech Strategy (Slot 2).',
    deliverables: ['Macro brief', 'Unit economics table', 'FinTech market entry options'],
    assumptions: ['World Bank and Brave Search providers enabled'],
    questions: [] as string[],
    steps: [
      {
        title: 'Retrieve Morocco macro indicators',
        description: 'Read official GDP and inflation series via Slot 1.',
        capabilityId: 'capability-slot-1-v1',
        intent: 'RESEARCH',
        dependsOnIndices: [] as number[],
        expectedDeliverable: 'Official series snapshot',
      },
      {
        title: 'Model 12-month unit economics & runway',
        description: 'Run sensitivity scenarios anchored to macro series via Slot 7.',
        capabilityId: 'capability-slot-7-v1',
        intent: 'ANALYZE',
        dependsOnIndices: [0],
        expectedDeliverable: 'Sensitivity table',
      },
      {
        title: 'Synthesize FinTech market entry scorecard',
        description: 'Evaluate competitive entry trade-offs via operator-customized Slot 2.',
        capabilityId: 'capability-slot-2-v2',
        intent: 'ANALYZE',
        dependsOnIndices: [0, 1],
        expectedDeliverable: 'Market entry dossier',
      },
    ],
  };
  const scriptedPilotEngine: EnginePort = {
    isAvailable: () => ({ available: true, reason: 'READY' }),
    async invoke(): Promise<EngineOutcome> {
      return {
        status: 'COMPLETED',
        engine: 'qa-scripted-pilot',
        content: JSON.stringify(multiSlotProposalOutput),
        proposedTools: [],
        receivedAt: new Date().toISOString(),
      };
    },
  };
  const pilotProfile = {
    id: 'profile-pilot-v1' as ID,
    role: 'pilot' as const,
    version: 1,
    title: 'QeyNox Multi-Capability Mission Pilot',
    systemInstructions: 'Decompose across active slots.',
    skillRefs: [],
    allowedTools: [],
    permittedContextKeys: [],
    maxOutputTokens: 2048,
    maxIterations: 2,
  };
  const pilotService = new PlanProposalService(scriptedPilotEngine, async () => pilotProfile, capRegistry, {
    peekBudget: actor => peekWorkspaceBudget(store, actor),
  });
  const pilotResult = await pilotService.proposePlan(
    operator,
    crossPackOp,
    { statement: 'Cross-pack expansion assessment', constraints: [] },
    { attemptKey: 'qa-a16-pilot-multislot-1', locale: 'en' },
  );
  check(
    pilotResult.source === 'AI' && pilotResult.reason === 'OK' && pilotResult.steps.length === 3,
    'Pilot Planner composes valid multi-slot DAG across Research (Slot 1) -> Financial (Slot 7) -> Customized Strategy (Slot 2)',
  );
  check(pilotResult.budget.configured === true && pilotResult.budget.maxMoneyMinor === 12000, 'Pilot reads active suite budget policy');

  // --- 6. Real NestJS HTTP API across all 8 packs ---------------------------------------------
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  const base = `http://127.0.0.1:${String(port)}`;

  async function http(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: json };
  }

  // Register HTTP users in two isolated workspaces and grant Platform Admin to httpAdmin for Control validation check
  const regA = await http('/v1/auth/register', {
    body: { email: 'qa-a16-http-a@example.invalid', password: 'qa-a16-strong-password-1', workspaceName: 'QA A16 HTTP Tenant A' },
  });
  check(regA.status === 201, 'registered HTTP Tenant A');
  const authA = regA.body as { token: string; userId: string; workspaceId: string };
  const headersA = { authorization: `Bearer ${authA.token}`, 'x-qeynox-workspace': authA.workspaceId };
  await seedQaBetaGrant(db, authA.workspaceId);

  const regB = await http('/v1/auth/register', {
    body: { email: 'qa-a16-http-b@example.invalid', password: 'qa-a16-strong-password-2', workspaceName: 'QA A16 HTTP Tenant B' },
  });
  check(regB.status === 201, 'registered HTTP Tenant B');
  const authB = regB.body as { token: string; userId: string; workspaceId: string };
  const headersB = { authorization: `Bearer ${authB.token}`, 'x-qeynox-workspace': authB.workspaceId };

  // Apply budget policy for Tenant A so validate-service over HTTP also sees Tenant A's budget
  process.env.QEYNOX_OPERATOR_USER_IDS = `${operatorId},${authA.userId}`;
  await configService.apply(
    { userId: authA.userId as ID, workspaceId: authA.workspaceId as ID, roles: ['OWNER'] },
    {
      idempotencyKey: 'qa-a16-http-tenant-a-budget',
      entries: [parsedSuiteApply.entries.find(e => e.domain === 'BUDGET_POLICY')!],
    },
  );

  // GET /v1/capabilities
  const capsHttp = await http('/v1/capabilities', { headers: headersA });
  check(capsHttp.status === 200 && (capsHttp.body as { slots: unknown[] }).slots.length === 8, 'GET /v1/capabilities returns all 8 active slots');

  // GET /v1/services
  const listHttp = await http('/v1/services', { headers: headersA });
  check(listHttp.status === 200, 'GET /v1/services returns 200');
  const listedServices = serviceListSchema.parse(listHttp.body);
  check(listedServices.length === 8, 'GET /v1/services returns all 8 published RaaS offers');
  check(listedServices.every(s => s.requestable === true && s.contractKey !== null), 'all 8 offers are bound to typed request contracts');

  const strategyListed = listedServices.find(s => s.offerId === 'offer-strategy-pack-v1')!;
  check(
    strategyListed.displayName === 'FinTech & Payments Market Entry Dossier' &&
      strategyListed.specialization?.includes('Bank Al-Maghrib') === true &&
      strategyListed.amountMinor === 39000,
    'GET /v1/services surfaces live operator-customized displayName, specialization, and v2 offer price',
  );

  // Count operations before previews to prove preview is 100% side-effect free
  const opsCountBeforePreview = Number(
    (await connection.pool.query('SELECT count(*)::text AS n FROM operations')).rows[0].n,
  );

  // Exercise GET /v1/services/:offerId and POST /v1/services/:offerId/preview for ALL 8 offers
  for (const summary of listedServices) {
    const detailHttp = await http(`/v1/services/${encodeURIComponent(summary.offerId)}`, { headers: headersA });
    check(detailHttp.status === 200, `GET /v1/services/${summary.offerId} returns 200`);
    const detail = serviceDetailSchema.parse(detailHttp.body);
    const pack = detail.packDomain!;
    check(Boolean(pack) && detail.contractMeta?.pack === pack, `${summary.offerId} detail carries typed contractMeta for '${pack}'`);
    check(detail.deployment !== null, `${summary.offerId} detail carries truthful deployment probe`);

    const expectedProvider = REQUIRED_PROVIDER_BY_PACK[pack];
    check(detail.deployment?.requiredProvider === expectedProvider, `${summary.offerId} deployment names requiredProvider=${expectedProvider}`);
    if (expectedProvider === 'brave-search') {
      // QEYNOX_BRAVE_SEARCH_ENABLED is false and QEYNOX_BRAVE_SEARCH_API_KEY is unset right now!
      check(
        detail.deployment?.braveSearchEnabled === false &&
          detail.deployment?.braveSearchKeyConfigured === false &&
          detail.deployment?.providerSwitchReady === false &&
          detail.deployment?.consentScopesRequired?.includes('web:search') === true,
        `${summary.offerId} truthfully reports Brave Search switch & key as false without pretending permission exists`,
      );
    } else {
      check(
        detail.deployment?.worldBankEnabled === true && detail.deployment?.providerSwitchReady === true,
        `${summary.offerId} truthfully reports World Bank switch ready`,
      );
    }

    const expectedBlocked = UNAVAILABLE_CONNECTORS_BY_PACK[pack].map(c => c.connectorId);
    const actualBlocked = (detail.deployment?.unavailableExternalConnectors ?? []).map(c => c.connectorId);
    check(
      JSON.stringify(actualBlocked) === JSON.stringify(expectedBlocked),
      `${summary.offerId} discloses exact BLOCKED external connectors (${expectedBlocked.join(', ') || 'none'})`,
    );

    const requestInput = pack === 'strategy'
      ? { ...(VALID_PACK_REQUESTS.strategy as object), framework: 'MARKET_ENTRY_SCORECARD' }
      : VALID_PACK_REQUESTS[pack];

    // Wrong contract discriminator must fail with 400 INVALID_INPUT
    const wrongDisc = await http(`/v1/services/${encodeURIComponent(summary.offerId)}/preview`, {
      headers: headersA,
      body: {
        service: pack === 'research' ? SERVICE_CONTRACT_SEO_PACK : SERVICE_CONTRACT_RESEARCH_PACK,
        input: pack === 'research' ? VALID_PACK_REQUESTS.seo : VALID_PACK_REQUESTS.research,
      },
    });
    check(wrongDisc.status === 400, `${summary.offerId} rejects mismatched contract discriminator on preview`);

    // Valid preview
    const previewHttp = await http(`/v1/services/${encodeURIComponent(summary.offerId)}/preview`, {
      headers: headersA,
      body: { service: detail.contractKey, input: requestInput },
    });
    check(previewHttp.status === 201, `POST /v1/services/${summary.offerId}/preview returns 201`);
    const preview = servicePreviewResultSchema.parse(previewHttp.body);
    check(preview.packDomain === pack && preview.steps.length >= 3, `${summary.offerId} preview returns bounded multi-step DAG`);
  }

  const opsCountAfterPreview = Number(
    (await connection.pool.query('SELECT count(*)::text AS n FROM operations')).rows[0].n,
  );
  check(opsCountAfterPreview === opsCountBeforePreview, 'POST /v1/services/:offerId/preview persisted zero operations across all 8 packs');

  // Verify secret non-leakage when QEYNOX_BRAVE_SEARCH_API_KEY is set
  const fakeSecretValue = 'bsa-SUPER-SECRET-DO-NOT-ECHO-998877';
  process.env.QEYNOX_BRAVE_SEARCH_ENABLED = 'true';
  process.env.QEYNOX_BRAVE_SEARCH_API_KEY = fakeSecretValue;
  const seoDetailWithSecret = await http('/v1/services/offer-seo-pack-v1', { headers: headersA });
  const rawSeoBody = JSON.stringify(seoDetailWithSecret.body);
  check(!rawSeoBody.includes(fakeSecretValue), 'deployment probe NEVER leaks QEYNOX_BRAVE_SEARCH_API_KEY value');
  check(
    (seoDetailWithSecret.body as { deployment: { braveSearchKeyConfigured: boolean; providerSwitchReady: boolean } }).deployment.braveSearchKeyConfigured === true &&
      (seoDetailWithSecret.body as { deployment: { providerSwitchReady: boolean } }).deployment.providerSwitchReady === true,
    'deployment probe echoes boolean braveSearchKeyConfigured=true when key is present',
  );

  // Submit real service requests over HTTP for ALL 8 packs + verify commercial quote behavior & tenant isolation
  const commerce = new CommerceService(store);
  const actorA: Principal = { userId: authA.userId as ID, workspaceId: authA.workspaceId as ID, roles: ['OWNER'] };
  const createdOperationsByPack = new Map<BusinessPackDomain, { operationId: ID; revisionId: ID }>();

  for (const summary of listedServices) {
    const pack = summary.packDomain!;
    const requestInput = pack === 'strategy'
      ? { ...(VALID_PACK_REQUESTS.strategy as object), framework: 'MARKET_ENTRY_SCORECARD' }
      : VALID_PACK_REQUESTS[pack];
    const reqHttp = await http(`/v1/services/${encodeURIComponent(summary.offerId)}/requests`, {
      headers: headersA,
      body: { service: summary.contractKey, input: requestInput },
    });
    check(reqHttp.status === 201, `POST /v1/services/${summary.offerId}/requests creates mission (201)`);
    const created = serviceRequestResultSchema.parse(reqHttp.body);
    createdOperationsByPack.set(pack, {
      operationId: created.operationId as ID,
      revisionId: created.revisionId as ID,
    });

    const opA = await store.getOperation(actorA, created.operationId as ID);
    check(opA.status === 'READY', `${pack} requested operation lands in READY awaiting quote & approval`);

    // Cross-tenant isolation: Tenant B cannot read Tenant A's created operation
    const foreignRead = await http(`/v1/operations/${encodeURIComponent(created.operationId)}`, { headers: headersB });
    check(foreignRead.status === 404, `Tenant B is isolated from Tenant A's '${pack}' operation (404)`);

    // Commercial quote & acceptance truthfulness
    const quoted = (await commerce.quote(
      actorA,
      created.operationId as ID,
      summary.offerId,
      created.revisionId as ID,
    )) as { id: ID; amountMinor: number };
    const accepted = await commerce.accept(actorA, quoted.id, `qa-a16-accept-${pack}`);
    if (summary.isExplicitlyFree) {
      check(accepted.state === 'AUTHORIZED', `explicitly-free pack '${pack}' authorizes on quote acceptance`);
    } else {
      check(
        accepted.state === 'PAYMENT_REQUIRED' && quoted.amountMinor === summary.amountMinor,
        `priced pack '${pack}' (${String(summary.amountMinor)} EUR minor) transitions to PAYMENT_REQUIRED and never bypasses payment`,
      );
    }
  }
  check(createdOperationsByPack.size === 8, 'all 8 business packs created real operations and commercial quotes');

  // Platform Control validate-service over HTTP for both 'world-bank' and 'brave-search'
  await db.insert(platformAdminAssignments).values({
    id: randomUUID(),
    userId: authA.userId,
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    grantedBy: authA.userId,
    grantReason: 'QA A16 platform service validation test',
  });
  // Customer bearer token must be rejected on platform route (ADR-0002 separation)
  const customerTokenOnPlatform = await http('/v1/platform/configuration/validate-service', {
    headers: { authorization: headersA.authorization },
    body: {
      workspaceId: authA.workspaceId,
      capabilityId: 'capability-slot-7-v1',
      offerId: 'offer-financial-pack-v1',
      expectedProvider: 'world-bank',
    },
  });
  check(customerTokenOnPlatform.status === 401 || customerTokenOnPlatform.status === 403, 'customer session token is rejected on Platform Control validate-service');

  const platLogin = await http('/v1/platform/auth/login', {
    body: { email: 'qa-a16-http-a@example.invalid', password: 'qa-a16-strong-password-1' },
  });
  check(platLogin.status === 201, 'platform admin signed in via /v1/platform/auth/login');
  const platHeaders = { authorization: `Bearer ${(platLogin.body as { token: string }).token}` };

  const valWbHttp = await http('/v1/platform/configuration/validate-service', {
    headers: platHeaders,
    body: {
      workspaceId: authA.workspaceId,
      capabilityId: 'capability-slot-7-v1',
      offerId: 'offer-financial-pack-v1',
      expectedProvider: 'world-bank',
    },
  });
  check(valWbHttp.status === 201 && serviceValidationReportSchema.parse(valWbHttp.body).valid === true, 'Platform validate-service HTTP succeeds for world-bank pack (Slot 7)');

  const valBraveHttp = await http('/v1/platform/configuration/validate-service', {
    headers: platHeaders,
    body: {
      workspaceId: authA.workspaceId,
      capabilityId: 'capability-slot-4-v1',
      offerId: 'offer-seo-pack-v1',
      expectedProvider: 'brave-search',
    },
  });
  check(valBraveHttp.status === 201 && serviceValidationReportSchema.parse(valBraveHttp.body).valid === true, 'Platform validate-service HTTP succeeds for brave-search pack (Slot 4)');

  // --- 7. End-to-end ToolBroker + Claims + Human Review + Deliverable Assembly & Export -------
  // Execute the authorized Operations Pack (Slot 6) operation end-to-end using a local fake fetch
  // for Brave Search so ToolBroker captures real provenance & digest without external internet!
  const opsTarget = createdOperationsByPack.get('operations')!;
  const fakeBravePayload = {
    web: {
      results: [
        {
          title: 'Enterprise Onboarding SLA & Control Gate Benchmarks',
          url: 'https://example-public-source.org/enterprise-ops-benchmark',
          description: 'Pre-attested security and egress checklists cut enterprise onboarding rework.',
        },
      ],
    },
  };
  const localBraveConnector = new BraveSearchConnector(
    ['capability-slot-6-v1' as ID],
    new EgressPolicy({ attested: true, allowedHosts: ['api.search.brave.com'] }),
    'qa-local-key',
    {
      async get() {
        return { status: 200, body: JSON.stringify(fakeBravePayload) };
      },
    },
  );
  const localToolRegistry = new ToolRegistry();
  localToolRegistry.registerBundle({ connector: localBraveConnector, manifest: braveSearchManifest });
  const broker = new ToolBroker(localToolRegistry, new PgToolLedger(db));

  const execService = new OperationExecutionService(store, qaVerifiedRuntime);
  const opBeforeStart = await store.getOperation(actorA, opsTarget.operationId);
  await execService.start(actorA, opsTarget.operationId, opBeforeStart.version, 'qa-a16-ops-start-1');
  const opAfterStart = await store.getOperation(actorA, opsTarget.operationId);
  check(opAfterStart.status === 'RUNNING', 'authorized Operations Pack mission launched into RUNNING');

  // Step 0: RESEARCH via ToolBroker (brave-search:web@1)
  const pendingStep0 = (await db.select().from(attempts).where(eq(attempts.operationId, opsTarget.operationId)))[0]!;
  const toolCall: ConnectorCall = {
    operationId: opsTarget.operationId,
    planRevisionId: opsTarget.revisionId,
    stepAttemptId: pendingStep0.id as ID,
    capabilityId: 'capability-slot-6-v1' as ID,
    connectorId: 'brave-search',
    toolName: 'web',
    version: '1',
    input: { query: 'customer onboarding control gate cycle time benchmark', count: 3 },
    idempotencyKey: 'qa-a16-ops-tool-1',
    intentId: randomUUID() as ID,
  };
  const permission: PermissionContext = {
    principal: actorA,
    operationId: opsTarget.operationId,
    planRevisionId: opsTarget.revisionId,
    stepAttemptId: pendingStep0.id as ID,
    capabilityId: 'capability-slot-6-v1' as ID,
    profileId: 'profile-business-6-v1' as ID,
    profileVersion: 1,
    allowedConnectorTools: ['brave-search:web@1'],
    consentScopes: ['web:search'],
    approvedRequests: [],
    remainingCostUnits: 100,
    remainingToolCalls: 2,
  };
  const toolResult = await broker.invoke(toolCall, permission);
  const sourceId = randomUUID() as ID;
  const evidenceId = randomUUID() as ID;
  const responseDigest = toolResult.provenance.responseDigest;
  const citedBenchmarkUrl = 'https://example-public-source.org/enterprise-ops-benchmark';

  await store.recordSource({
    id: sourceId,
    workspaceId: actorA.workspaceId,
    operationId: opsTarget.operationId,
    uri: citedBenchmarkUrl,
    provider: 'brave-search',
    title: 'Enterprise Onboarding SLA & Control Gate Benchmarks',
    retrievedAt: toolResult.provenance.retrievedAt,
    fingerprint: responseDigest,
  });
  await store.recordEvidence({
    id: evidenceId,
    operationId: opsTarget.operationId,
    sourceId,
    stepAttemptId: pendingStep0.id as ID,
    statement: 'Public benchmark documents pre-attested security and egress checklists reducing onboarding rework.',
    observedAt: new Date().toISOString(),
    status: 'UNVERIFIED',
    limitations: ['External benchmark requires internal validation against tenant workflow'],
  });
  await db.insert(sourceSnapshots).values({
    id: randomUUID(),
    workspaceId: actorA.workspaceId,
    operationId: opsTarget.operationId,
    sourceId,
    provider: 'brave-search',
    retrievedAt: toolResult.provenance.retrievedAt,
    sha256: responseDigest,
    citationUri: citedBenchmarkUrl,
    createdAt: new Date().toISOString(),
  });

  // Validate structured operations@1 deliverable against captured source URI & deterministic diagnostics
  const validatedOpsDeliverable = validatePackDeliverable(
    'operations',
    validDeliverables.operations.deliverable,
    { capturedSourceUris: [citedBenchmarkUrl], expectedDiagnostics: expectedOpsDiag },
  );
  const projectedOps = projectDeliverableToResultSummary(validatedOpsDeliverable);

  // Register claim, bind to evidence digest, evaluate against Slot 6 verification policy, and complete human review
  const claimsService = new ClaimsService(store);
  const claim = await claimsService.register(actorA, {
    operationId: opsTarget.operationId,
    attemptId: pendingStep0.id as ID,
    statement: `${projectedOps.title}: baseline 56h vs 48h SLA; primary bottleneck Security & Egress Review (57.14%) backed by benchmark.`,
    kind: 'PROVIDER_OBSERVATION',
  });
  await claimsService.attach(actorA, claim.id, sourceId, 'SUPPORTS', evidenceId, responseDigest);
  const autoAssess = await claimsService.assess(actorA, {
    claimId: claim.id,
    capabilityId: 'capability-slot-6-v1' as ID,
    policyVersion: 1,
    reason: 'Automated Slot 6 policy check',
  });
  check(autoAssess.status === 'NEEDS_HUMAN_REVIEW', 'Slot 6 verification policy requires human review before SUPPORTED');

  const reviewedClaim = await claimsService.assess(actorA, {
    claimId: claim.id,
    capabilityId: 'capability-slot-6-v1' as ID,
    policyVersion: 1,
    reason: 'Operations owner verified cycle-time math and benchmark citation',
    reviewerDecision: 'SUPPORTED',
  });
  check(reviewedClaim.status === 'SUPPORTED', 'human reviewer promoted Operations Pack claim to SUPPORTED');

  // Progress all 3 DAG steps (RESEARCH -> ANALYZE -> VERIFY) to AWAITING_REVIEW
  const progression = new StepProgression(store);
  let lastProgressionState = '';
  for (let stepPass = 0; stepPass < 3; stepPass++) {
    const attemptRows = await db
      .select()
      .from(attempts)
      .where(and(eq(attempts.operationId, opsTarget.operationId), eq(attempts.state, 'PENDING')));
    check(attemptRows.length === 1, `Operations DAG pass ${String(stepPass + 1)} has 1 runnable attempt`);
    const currentAttempt = attemptRows[0]!;
    await db
      .update(attempts)
      .set({
        state: 'RUNNING',
        payload: { ...currentAttempt.payload, state: 'RUNNING', startedAt: new Date().toISOString(), version: currentAttempt.payload.version + 1 },
      })
      .where(eq(attempts.id, currentAttempt.id));
    const finalStep = await prepareQaPackStep(store, actorA, currentAttempt.payload, validatedOpsDeliverable);
    if (finalStep.businessDeliverable) {
      check(finalStep.claimIds.length > 0, 'final Operations output registers domain claims');
      for (const claimId of finalStep.claimIds) {
        const reviewedFinal = await claimsService.assess(actorA, { claimId, capabilityId: 'capability-slot-6-v1' as ID, policyVersion: 1, reason: 'QA human review of final domain claim and captured evidence', reviewerDecision: 'SUPPORTED' });
        check(reviewedFinal.status === 'SUPPORTED', 'final Operations claim is human-reviewed');
      }
    }
    lastProgressionState = await progression.complete(
      currentAttempt.id as ID,
      { text: JSON.stringify(validatedOpsDeliverable), sourceId, evidenceId, quality: 'UNVERIFIED', ...(finalStep.businessDeliverable ? { businessDeliverable: finalStep.businessDeliverable } : {}) },
      'UNVERIFIED',
    );
  }
  check(lastProgressionState === 'AWAITING_REVIEW', 'Operations 3-step DAG completed into AWAITING_REVIEW');

  // Assemble ResultDocument, approve RESULT_REVIEW gate, deliver immutable version & export JSON/HTML
  const approvalRows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.operationId, opsTarget.operationId), eq(approvals.status, 'PENDING')));
  check(approvalRows.length === 1 && approvalRows[0]!.payload.purpose === 'RESULT_REVIEW', 'RESULT_REVIEW approval gate created');

  const assembler = new ResultAssembler(store);
  const assembledDoc = await assembler.assemble(
    actorA,
    opsTarget.operationId,
    opsTarget.revisionId,
    projectedOps.title,
    [...projectedOps.scope],
    [...projectedOps.nextActions],
  );
  check(assembledDoc.status === 'READY_FOR_REVIEW', 'assembled Operations Pack ResultDocument is READY_FOR_REVIEW');

  const controls = new OperationControlService(store);
  await expectAsyncDomainError(
    'DENIED',
    () => new ResultDeliveryService(store).deliver(actorA, opsTarget.operationId, assembledDoc.id, approvalRows[0]!.id as ID),
    'cannot deliver Operations Pack result before human RESULT_REVIEW approval',
  );
  await controls.decideApproval(actorA, approvalRows[0]!.id as ID, 'APPROVED', opsTarget.operationId);
  const delivered = await new ResultDeliveryService(store).deliver(
    actorA,
    opsTarget.operationId,
    assembledDoc.id,
    approvalRows[0]!.id as ID,
  );
  check(delivered.status === 'DELIVERABLE' && delivered.operationStatus === 'COMPLETED', 'Operations Pack deliverable released and operation COMPLETED');

  const releasedRow = (await db.select().from(resultDocuments).where(eq(resultDocuments.id, delivered.documentId)))[0]!;
  const exportedJson = new TextDecoder().decode(exportJson(releasedRow.document as never));
  const exportedHtml = new TextDecoder().decode(exportHtml(releasedRow.document as never));
  check(
    exportedJson.includes(citedBenchmarkUrl) &&
      exportedJson.includes(responseDigest) &&
      exportedHtml.includes('Enterprise Workspace &amp; Security Onboarding'),
    'exported JSON and HTML deliverables preserve citation URI, SHA-256 digest, and escaped title',
  );

  unlinkSync(customizedCatalogPath);
  console.log(`  PART 2 PASSED: cumulative ${assertions} assertions`);
  console.log(`A16 BUSINESS CAPABILITY PACKS QA PASSED: ${assertions} assertions across all 8 packs.`);
} catch (error: unknown) {
  console.error('A16 BUSINESS CAPABILITY PACKS QA FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await qa.drop().catch(() => undefined);
}
