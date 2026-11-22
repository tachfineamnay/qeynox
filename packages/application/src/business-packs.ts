import { createHash } from 'node:crypto';
import { DomainError, type CapabilityDefinition, type ID, type Principal } from '@qeynox/domain';
import type { PlanStepDraft, PlanningService } from './planning';
import type { QeyNoxStore } from '@qeynox/persistence';
import { capabilityAvailability } from './capability-availability';
import { failClosedRuntime, type RuntimeReadinessSource } from './runtime-readiness';
import {
  DELIVERABLE_SECTIONS_BY_PACK,
  computeFinancialSensitivity,
  computeProcessDiagnostics,
  type ComputedFinancialSensitivity,
  type OperationsProcessDiagnostics,
} from './business-pack-deliverables';
import {
  PACK_CONTRACT_KEYS,
  contentPackRequestSchema,
  financialAnalysisPackRequestSchema,
  marketingPackRequestSchema,
  operationsPackRequestSchema,
  packServiceConfigSchema,
  researchPackRequestSchema,
  salesPackRequestSchema,
  seoPackRequestSchema,
  strategyPackRequestSchema,
  type BusinessPackDomain,
  type ContentPackServiceConfig,
  type FinancialAnalysisPackServiceConfig,
  type MarketingPackServiceConfig,
  type OperationsPackServiceConfig,
  type PackServiceConfig,
  type ResearchPackServiceConfig,
  type SalesPackServiceConfig,
  type SeoPackServiceConfig,
  type ServiceContractMeta,
  type StrategyPackServiceConfig,
  type UnavailableExternalConnector,
} from '@qeynox/contracts';

/** Reviewed provider required by each pack's default configuration. */
export const REQUIRED_PROVIDER_BY_PACK: Readonly<Record<BusinessPackDomain, 'world-bank' | 'brave-search'>> = {
  research: 'world-bank',
  strategy: 'brave-search',
  marketing: 'brave-search',
  seo: 'brave-search',
  sales: 'brave-search',
  operations: 'brave-search',
  'financial-analysis': 'world-bank',
  content: 'brave-search',
};

/** Pack identity fixes the external-data contract; an arbitrary tool allowlist cannot substitute it. */
export function requiredToolForPack(pack: BusinessPackDomain): string {
  return REQUIRED_PROVIDER_BY_PACK[pack] === 'world-bank' ? 'world-bank:indicator@1' : 'brave-search:web@1';
}
export function assertBusinessPackProvider(pack: BusinessPackDomain, capability: CapabilityDefinition): void {
  const required = requiredToolForPack(pack);
  if (capability.allowedTools.length !== 1 || capability.allowedTools[0] !== required) throw new DomainError('NOT_CONFIGURED', 'Business pack requires its reviewed read-only provider: ' + required);
}

/**
 * Truthful external connector status derived from infra/connectors.registry.json.
 * Missing external permissions are explicitly surfaced as BLOCKED, never simulated.
 */
export const UNAVAILABLE_CONNECTORS_BY_PACK: Readonly<
  Record<BusinessPackDomain, readonly UnavailableExternalConnector[]>
> = {
  research: [],
  strategy: [
    {
      connectorId: 'google-workspace',
      purpose: 'Direct slide/document export to Google Drive or Docs',
      state: 'BLOCKED',
      blocker: 'No tool-layer OAuth connector implemented; export via downloadable JSON/HTML/PDF instead.',
    },
  ],
  marketing: [
    {
      connectorId: 'meta',
      purpose: 'Live Meta Ads campaign creation, spend, or ad-account telemetry',
      state: 'BLOCKED',
      blocker: 'Business verification and Meta Marketing API connector not provisioned.',
    },
    {
      connectorId: 'ga4',
      purpose: 'Direct Google Analytics 4 conversion funnel & attribution import',
      state: 'BLOCKED',
      blocker: 'GA4 OAuth connector and property read scope not implemented.',
    },
    {
      connectorId: 'linkedin',
      purpose: 'Automated LinkedIn campaign or company-page publishing',
      state: 'BLOCKED',
      blocker: 'Partner-gated API permissions unavailable; execution produces human-run campaign specs only.',
    },
  ],
  seo: [
    {
      connectorId: 'search-console',
      purpose: 'First-party Google Search Console impressions, CTR, and crawl-error telemetry',
      state: 'BLOCKED',
      blocker: 'Search Console OAuth property connector not implemented; audit uses live SERP evidence + caller inputs.',
    },
    {
      connectorId: 'ga4',
      purpose: 'Organic landing-page session and conversion telemetry',
      state: 'BLOCKED',
      blocker: 'GA4 OAuth property connector not implemented.',
    },
  ],
  sales: [
    {
      connectorId: 'linkedin',
      purpose: 'LinkedIn Sales Navigator scraping or automated outbound messaging',
      state: 'BLOCKED',
      blocker: 'Partner-gated API unavailable and contact scraping prohibited; role-based mapping only.',
    },
    {
      connectorId: 'google-workspace',
      purpose: 'Automated outbound Gmail sequence sending or Calendar booking',
      state: 'BLOCKED',
      blocker: 'No outbound mailbox/CRM write connector enabled.',
    },
  ],
  operations: [
    {
      connectorId: 'google-workspace',
      purpose: 'Automated SOP publishing into Google Docs / Sheets',
      state: 'BLOCKED',
      blocker: 'Workspace document write connector not implemented.',
    },
    {
      connectorId: 'github',
      purpose: 'Automated repository issue/workflow provisioning',
      state: 'BLOCKED',
      blocker: 'GitHub App installation and tool adapter not enabled.',
    },
  ],
  'financial-analysis': [
    {
      connectorId: 'stripe',
      purpose: 'Live Stripe ledger, MRR, or subscription cohort ingestion',
      state: 'BLOCKED',
      blocker: 'Stripe read/billing connector not enabled; model runs over explicit caller-supplied baseline metrics + World Bank macro series.',
    },
  ],
  content: [
    {
      connectorId: 'wordpress-woocommerce',
      purpose: 'Direct CMS draft/post publishing to WordPress',
      state: 'BLOCKED',
      blocker: 'Customer site credential vault and WordPress write adapter not implemented.',
    },
    {
      connectorId: 'linkedin',
      purpose: 'Automated social distribution',
      state: 'BLOCKED',
      blocker: 'LinkedIn publishing API unavailable; pack outputs human-reviewed drafts and distribution checklist.',
    },
  ],
};

function digestObject(payload: unknown): string {
  return packRequestFingerprint(JSON.stringify(payload));
}

/**
 * The pack request fingerprint of one canonical JSON text. P09: the worker recomputes it over the
 * recorded `normalizedRequestJson` to prove it recovered exactly the request the customer approved.
 */
export function packRequestFingerprint(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson).digest('hex').slice(0, 32);
}

function rejectSchemaIssues(pack: BusinessPackDomain, issues: readonly { path: PropertyKey[]; message: string }[]): never {
  const detail = issues.map(issue => (issue.path.map(String).join('.') || pack) + ': ' + issue.message).join('; ');
  throw new DomainError('INVALID_INPUT', `Invalid ${pack} service request: ${detail}`);
}

const CONTACT_SCRAPE_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/;

export interface BusinessPackPlanProposal {
  readonly pack: BusinessPackDomain;
  readonly contractKey: string;
  readonly fingerprint: string;
  readonly goalSummary: string;
  readonly normalizedConstraints: Record<string, unknown>;
  readonly steps: readonly PlanStepDraft[];
  readonly estimatedToolCalls: number;
  readonly requiresUserApproval: true;
  readonly warnings: readonly string[];
  readonly computedMetrics?: Record<string, unknown>;
}

export interface CreatedPackOperationPlan {
  readonly operationId: ID;
  readonly revisionId: ID;
  readonly proposal: BusinessPackPlanProposal;
}

function assertPlanWithinCapabilityBounds(
  pack: BusinessPackDomain,
  capability: CapabilityDefinition,
  steps: readonly PlanStepDraft[],
  estimatedToolCalls: number,
): void {
  if (steps.length > capability.maximumSteps) {
    throw new DomainError(
      'INVALID_INPUT',
      `Pack '${pack}' requires ${steps.length} steps, exceeding capability '${capability.id}' maximumSteps (${capability.maximumSteps})`,
    );
  }
  if (estimatedToolCalls > capability.maximumToolCalls) {
    throw new DomainError(
      'INVALID_INPUT',
      `Pack '${pack}' requires ${estimatedToolCalls} tool calls, exceeding capability '${capability.id}' maximumToolCalls (${capability.maximumToolCalls})`,
    );
  }
}

// =============================================================================================
// Per-pack request normalization & bounded multi-step DAG builders
// =============================================================================================

function proposeResearchPack(
  raw: unknown,
  config: ResearchPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = researchPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('research', parsed.error.issues);
  const v = parsed.data;

  const primaryCountry = v.primaryCountry.toUpperCase();
  const benchmarkCountry = v.benchmarkCountry?.toUpperCase();
  if (benchmarkCountry && benchmarkCountry === primaryCountry) {
    throw new DomainError('INVALID_INPUT', 'benchmarkCountry must differ from primaryCountry');
  }
  const primaryIndicator = v.primaryIndicator.toUpperCase();
  const comparisonIndicators = (v.comparisonIndicators ?? []).map(code => code.toUpperCase());
  const allIndicators = [primaryIndicator, ...comparisonIndicators];
  if (new Set(allIndicators).size !== allIndicators.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate indicator codes in research request');
  }

  if (config.allowedCountries) {
    for (const c of benchmarkCountry ? [primaryCountry, benchmarkCountry] : [primaryCountry]) {
      if (!config.allowedCountries.includes(c)) {
        throw new DomainError('DENIED', `Country '${c}' is outside operator-configured research scope`);
      }
    }
  }
  if (config.allowedIndicators) {
    for (const ind of allIndicators) {
      if (!config.allowedIndicators.includes(ind)) {
        throw new DomainError('DENIED', `Indicator '${ind}' is outside operator-configured research scope`);
      }
    }
  }
  const mostRecent = v.mostRecent ?? Math.min(3, config.maximumObservations);
  if (mostRecent > config.maximumObservations) {
    throw new DomainError(
      'INVALID_INPUT',
      `mostRecent (${mostRecent}) exceeds operator ceiling (${config.maximumObservations})`,
    );
  }

  const normalized = {
    pack: 'research' as const,
    objective: v.objective,
    primaryCountry,
    benchmarkCountry: benchmarkCountry ?? null,
    primaryIndicator,
    comparisonIndicators,
    mostRecent,
    minObservationYear: v.minObservationYear ?? null,
    decisionHorizon: v.decisionHorizon,
    includeSynthesis: v.includeSynthesis,
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const steps: PlanStepDraft[] = [];
  const yearNote = normalized.minObservationYear ? ` not older than ${normalized.minObservationYear}` : '';

  for (const ind of allIndicators) {
    steps.push({
      title: `[${capability.name}] Retrieve ${ind} for ${primaryCountry}`,
      description:
        `Specialization (${config.specialization}): read the ${mostRecent} most recent World Bank observations for ${ind} in ${primaryCountry}${yearNote} via world-bank:indicator@1; preserve exact URI, retrievedAt, responseDigest, and null gaps.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    });
  }
  if (benchmarkCountry) {
    steps.push({
      title: `[${capability.name}] Retrieve benchmark ${primaryIndicator} for ${benchmarkCountry}`,
      description:
        `Read the ${mostRecent} most recent World Bank observations for ${primaryIndicator} in benchmark country ${benchmarkCountry}${yearNote} via world-bank:indicator@1.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    });
  }

  const researchIndices = steps.map((_, idx) => idx);
  const estimatedToolCalls = researchIndices.length;

  if (normalized.includeSynthesis) {
    steps.push({
      title: `Synthesize ${normalized.decisionHorizon} comparative brief`,
      description:
        `Synthesize ${allIndicators.join(', ')} for ${primaryCountry}${benchmarkCountry ? ` vs ${benchmarkCountry}` : ''} against objective: "${normalized.objective}". Emit research@1 JSON separating OBSERVED values from INTERPRETATION.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: researchIndices,
    });
  }

  const verifyDeps = normalized.includeSynthesis ? [steps.length - 1] : researchIndices;
  steps.push({
    title: 'Verify official series provenance & publication-lag disclosures',
    description:
      'Audit every numeric claim against captured World Bank tool sources, verify null-gap and publication-lag disclosures, and confirm schema compliance for research@1.',
    capabilityId: capability.id,
    intent: 'VERIFY',
    dependsOnIndices: verifyDeps,
  });

  assertPlanWithinCapabilityBounds('research', capability, steps, estimatedToolCalls);

  const warnings = [
    'World Bank annual indicators carry provider publication lag; retrievedAt records retrieval time, not statistical freshness.',
    ...(normalized.minObservationYear ? [`Observations earlier than ${normalized.minObservationYear} are excluded from scope.`] : []),
  ];

  return {
    pack: 'research',
    contractKey: PACK_CONTRACT_KEYS.research,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings,
  };
}

function proposeStrategyPack(
  raw: unknown,
  config: StrategyPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = strategyPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('strategy', parsed.error.issues);
  const v = parsed.data;

  if (!config.allowedFrameworks.includes(v.framework)) {
    throw new DomainError('DENIED', `Framework '${v.framework}' is outside operator-configured strategy scope`);
  }
  if (!config.allowedHorizons.includes(v.strategicHorizon)) {
    throw new DomainError('DENIED', `Horizon '${v.strategicHorizon}' is outside operator-configured strategy scope`);
  }
  if (v.competitors.length > config.maxCompetitors) {
    throw new DomainError('INVALID_INPUT', `competitors count (${v.competitors.length}) exceeds ceiling (${config.maxCompetitors})`);
  }
  const lowerCompetitors = v.competitors.map(c => c.toLowerCase());
  if (new Set(lowerCompetitors).size !== lowerCompetitors.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate competitor names in strategy request');
  }

  const normalized = {
    pack: 'strategy' as const,
    objective: v.objective,
    companyOfferSummary: v.companyOfferSummary,
    targetMarket: v.targetMarket,
    competitors: v.competitors,
    framework: v.framework,
    strategicHorizon: v.strategicHorizon,
    resourceConstraints: v.resourceConstraints,
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const steps: PlanStepDraft[] = [
    {
      title: `[${capability.name}] Inspect public market & category demand signals`,
      description:
        `Specialization (${config.specialization}): search public web sources via brave-search:web@1 for market structure and buyer selection criteria in "${normalized.targetMarket}".`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `[${capability.name}] Gather verifiable public positioning for ${normalized.competitors.length} competitor(s)`,
      description:
        `Search public web pages via brave-search:web@1 for ${normalized.competitors.join(', ')}; record public positioning, packaging, and cited URLs without fabricating private revenue or churn numbers.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `Build ${normalized.framework} options for ${normalized.strategicHorizon} horizon`,
      description:
        `Apply ${normalized.framework} over captured market and competitor evidence subject to constraints (${normalized.resourceConstraints.join('; ')}). Produce strategy@1 structured deliverable.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [0, 1],
    },
    {
      title: 'Verify competitor citations & separate unverified market assumptions',
      description:
        'Confirm every competitor entry cites captured public URLs, reject any guaranteed-outcome language, and verify unverified market assumptions are isolated in assumptionsRequiringValidation.',
      capabilityId: capability.id,
      intent: 'VERIFY',
      dependsOnIndices: [2],
    },
  ];
  const estimatedToolCalls = Math.min(capability.maximumToolCalls, 1 + normalized.competitors.length);
  if (1 + normalized.competitors.length > capability.maximumToolCalls) {
    throw new DomainError(
      'INVALID_INPUT',
      `Strategy request with ${normalized.competitors.length} competitors requires ${1 + normalized.competitors.length} search calls, exceeding capability maximumToolCalls (${capability.maximumToolCalls})`,
    );
  }
  assertPlanWithinCapabilityBounds('strategy', capability, steps, estimatedToolCalls);

  return {
    pack: 'strategy',
    contractKey: PACK_CONTRACT_KEYS.strategy,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      'Consent scope web:search: search query terms leave this deployment to api.search.brave.com when executed.',
      'Private competitor financials are unavailable; only public web positioning is treated as observed evidence.',
      'Connector google-workspace is BLOCKED: deliverables export via QeyNox JSON/HTML/PDF rather than direct Google Slides/Docs sync.',
    ],
  };
}

function proposeMarketingPack(
  raw: unknown,
  config: MarketingPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = marketingPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('marketing', parsed.error.issues);
  const v = parsed.data;

  if (!config.allowedStages.includes(v.primaryFunnelStage)) {
    throw new DomainError('DENIED', `Funnel stage '${v.primaryFunnelStage}' is outside operator-configured marketing scope`);
  }
  if (v.candidateChannels.length > config.maxChannels) {
    throw new DomainError('INVALID_INPUT', `candidateChannels (${v.candidateChannels.length}) exceeds ceiling (${config.maxChannels})`);
  }
  if (new Set(v.candidateChannels).size !== v.candidateChannels.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate channels in candidateChannels');
  }
  for (const ch of v.candidateChannels) {
    if (!config.allowedChannels.includes(ch)) {
      throw new DomainError('DENIED', `Channel '${ch}' is outside operator-configured marketing scope`);
    }
  }

  const budgetCurrency = v.budgetCurrency.toUpperCase();
  const normalized = {
    pack: 'marketing' as const,
    objective: v.objective,
    offerDescription: v.offerDescription,
    idealCustomerProfile: v.idealCustomerProfile,
    primaryFunnelStage: v.primaryFunnelStage,
    candidateChannels: v.candidateChannels,
    monthlyMediaBudgetMinor: v.monthlyMediaBudgetMinor,
    budgetCurrency,
    campaignWindowWeeks: v.campaignWindowWeeks,
    complianceConstraints: v.complianceConstraints ?? [],
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const steps: PlanStepDraft[] = [
    {
      title: `[${capability.name}] Research category messaging & ICP benchmarks`,
      description:
        `Specialization (${config.specialization}): inspect public category positioning and buyer objections for ICP "${normalized.idealCustomerProfile}" via brave-search:web@1.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `Design ${normalized.campaignWindowWeeks}-week campaign & channel mix (${normalized.candidateChannels.join(', ')})`,
      description:
        `Allocate ${normalized.monthlyMediaBudgetMinor} minor ${budgetCurrency}/month across ${normalized.candidateChannels.join(', ')} for stage ${normalized.primaryFunnelStage}, defining messaging pillars, experiment hypotheses, and explicit kill criteria in marketing@1 JSON.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [0],
    },
    {
      title: 'Verify budget allocation sum, compliance rules & platform connector limits',
      description:
        'Verify channel budget shares sum to 100%, confirm compliance constraints are honored, reject guaranteed-ROI claims, and disclose blocked ad/analytics connectors.',
      capabilityId: capability.id,
      intent: 'VERIFY',
      dependsOnIndices: [1],
    },
  ];
  const estimatedToolCalls = 2;
  assertPlanWithinCapabilityBounds('marketing', capability, steps, estimatedToolCalls);

  return {
    pack: 'marketing',
    contractKey: PACK_CONTRACT_KEYS.marketing,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      'Consent scope web:search: search query terms leave this deployment to api.search.brave.com when executed.',
      'External connectors meta, ga4, and linkedin are BLOCKED: QeyNox produces human-executable campaign specs and never books live ad spend or reads ad-account telemetry.',
    ],
  };
}

function proposeSeoPack(
  raw: unknown,
  config: SeoPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = seoPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('seo', parsed.error.issues);
  const v = parsed.data;

  const domain = v.domain.toLowerCase();
  const country = v.country.toUpperCase();
  const searchLangParts = v.searchLang.split('-');
  const searchLang = searchLangParts.length === 2
    ? `${searchLangParts[0]!.toLowerCase()}-${searchLangParts[1]!.toUpperCase()}`
    : v.searchLang.toLowerCase();

  if (config.allowedCountries && !config.allowedCountries.includes(country)) {
    throw new DomainError('DENIED', `Country '${country}' is outside operator-configured SEO scope`);
  }
  if (config.allowedSearchLocales && !config.allowedSearchLocales.includes(searchLang)) {
    throw new DomainError('DENIED', `Search locale '${searchLang}' is outside operator-configured SEO scope`);
  }
  if (v.targetQueries.length > config.maxTargetQueries) {
    throw new DomainError('INVALID_INPUT', `targetQueries (${v.targetQueries.length}) exceeds ceiling (${config.maxTargetQueries})`);
  }
  if (v.auditedUrls.length > config.maxAuditedUrls) {
    throw new DomainError('INVALID_INPUT', `auditedUrls (${v.auditedUrls.length}) exceeds ceiling (${config.maxAuditedUrls})`);
  }
  if (new Set(v.auditedUrls).size !== v.auditedUrls.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate URLs in auditedUrls');
  }
  if (new Set(v.targetQueries.map(q => q.toLowerCase())).size !== v.targetQueries.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate queries in targetQueries');
  }
  for (const urlText of v.auditedUrls) {
    const host = new URL(urlText).hostname.toLowerCase();
    if (host !== domain && !host.endsWith('.' + domain)) {
      throw new DomainError('INVALID_INPUT', `Audited URL '${urlText}' does not belong to domain '${domain}'`);
    }
  }

  const normalized = {
    pack: 'seo' as const,
    objective: v.objective,
    domain,
    auditedUrls: v.auditedUrls,
    targetQueries: v.targetQueries,
    country,
    searchLang,
    auditFocus: v.auditFocus,
    callerReportedIssues: v.callerReportedIssues ?? [],
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const estimatedToolCalls = normalized.targetQueries.length;
  const steps: PlanStepDraft[] = [
    {
      title: `[${capability.name}] Inspect live SERP intent & visibility for ${normalized.targetQueries.length} query(ies)`,
      description:
        `Specialization (${config.specialization}): run brave-search:web@1 (country=${country}, searchLang=${searchLangParts[0]!.toLowerCase()}; requested locale ${searchLang}; country controls geography) across [${normalized.targetQueries.join('; ')}] to capture top ranking URLs, dominant intent, and whether ${domain} appears.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `Diagnose ${normalized.auditFocus} gaps across ${normalized.auditedUrls.length} URL(s) on ${domain}`,
      description:
        `Map SERP observations and caller-reported issues onto ${normalized.auditedUrls.join(', ')}; tag every finding as SERP_OBSERVED or CALLER_REPORTED and prioritize P1/P2/P3 in seo@1 JSON.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [0],
    },
    {
      title: 'Verify domain URL ownership, SERP source links & telemetry boundary disclosures',
      description:
        'Verify every finding URL belongs to the target domain, every SERP observation cites its captured Brave URI, no ranking guarantees appear, and Search Console/GA4 unavailability is explicitly stated.',
      capabilityId: capability.id,
      intent: 'VERIFY',
      dependsOnIndices: [1],
    },
  ];
  assertPlanWithinCapabilityBounds('seo', capability, steps, estimatedToolCalls);

  return {
    pack: 'seo',
    contractKey: PACK_CONTRACT_KEYS.seo,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      'Consent scope web:search: target queries and domain leave this deployment to api.search.brave.com when executed.',
      'External connectors search-console and ga4 are BLOCKED: first-party impressions, CTR, and server crawl logs are not read directly.',
    ],
  };
}

function proposeSalesPack(
  raw: unknown,
  config: SalesPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = salesPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('sales', parsed.error.issues);
  const v = parsed.data;

  if (!config.allowedMethodologies.includes(v.methodology)) {
    throw new DomainError('DENIED', `Methodology '${v.methodology}' is outside operator-configured sales scope`);
  }
  if (!config.allowedDealStages.includes(v.dealStage)) {
    throw new DomainError('DENIED', `Deal stage '${v.dealStage}' is outside operator-configured sales scope`);
  }
  if (v.targetAccounts.length > config.maxTargetAccounts) {
    throw new DomainError('INVALID_INPUT', `targetAccounts (${v.targetAccounts.length}) exceeds ceiling (${config.maxTargetAccounts})`);
  }
  if (new Set(v.targetAccounts.map(a => a.accountName.toLowerCase())).size !== v.targetAccounts.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate accountName in targetAccounts');
  }
  for (const persona of v.buyerPersonas) {
    if (CONTACT_SCRAPE_PATTERN.test(persona)) {
      throw new DomainError(
        'INVALID_INPUT',
        'buyerPersonas must specify job titles/roles only, never personal emails or phone numbers',
      );
    }
  }

  const normalized = {
    pack: 'sales' as const,
    objective: v.objective,
    sellerSolutionSummary: v.sellerSolutionSummary,
    targetAccounts: v.targetAccounts.map(a => ({
      accountName: a.accountName,
      accountDomain: a.accountDomain?.toLowerCase() ?? null,
      industry: a.industry,
    })),
    buyerPersonas: v.buyerPersonas,
    methodology: v.methodology,
    dealStage: v.dealStage,
    dealSizeBand: v.dealSizeBand,
    knownObjections: v.knownObjections ?? [],
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const estimatedToolCalls = normalized.targetAccounts.length;
  const steps: PlanStepDraft[] = [
    {
      title: `[${capability.name}] Research public account signals for ${normalized.targetAccounts.length} target account(s)`,
      description:
        `Specialization (${config.specialization}): inspect public company announcements, product footprint, and hiring/strategic initiatives for ${normalized.targetAccounts.map(a => a.accountName).join(', ')} via brave-search:web@1.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `Build ${normalized.methodology} qualification briefs, role map & mutual action plan`,
      description:
        `Construct ${normalized.methodology} qualification rationale, role-based discovery questions for [${normalized.buyerPersonas.join(', ')}], objection responses, and a ${normalized.dealSizeBand} mutual action plan in sales@1 JSON. Never invent personal contact details.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [0],
    },
    {
      title: 'Verify public signal citations & enforce zero personal-contact fabrication',
      description:
        'Audit account signal source URIs, verify zero personal emails/phone numbers appear anywhere in stakeholder maps, and confirm outbound automation boundaries are disclosed.',
      capabilityId: capability.id,
      intent: 'VERIFY',
      dependsOnIndices: [1],
    },
  ];
  assertPlanWithinCapabilityBounds('sales', capability, steps, estimatedToolCalls);

  return {
    pack: 'sales',
    contractKey: PACK_CONTRACT_KEYS.sales,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      'Consent scope web:search: target account names leave this deployment to api.search.brave.com when executed.',
      'Strict data boundary: QeyNox maps functional buyer roles only and refuses to scrape or fabricate personal email addresses or phone numbers.',
      'External connectors linkedin and google-workspace are BLOCKED: no automated outbound emails or InMails are sent.',
    ],
  };
}

function proposeOperationsPack(
  raw: unknown,
  config: OperationsPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = operationsPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('operations', parsed.error.issues);
  const v = parsed.data;

  if (!config.allowedProcessDomains.includes(v.processDomain)) {
    throw new DomainError('DENIED', `Process domain '${v.processDomain}' is outside operator-configured operations scope`);
  }
  if (v.workflowStages.length > config.maxWorkflowStages) {
    throw new DomainError('INVALID_INPUT', `workflowStages (${v.workflowStages.length}) exceeds ceiling (${config.maxWorkflowStages})`);
  }
  if (new Set(v.workflowStages.map(s => s.stageName.toLowerCase())).size !== v.workflowStages.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate stageName in workflowStages');
  }

  const diagnostics: OperationsProcessDiagnostics = computeProcessDiagnostics(v.workflowStages, v.targetSlaHours);
  const normalized = {
    pack: 'operations' as const,
    objective: v.objective,
    processName: v.processName,
    processDomain: v.processDomain,
    workflowStages: v.workflowStages,
    targetSlaHours: v.targetSlaHours,
    complianceOrControlRequirements: v.complianceOrControlRequirements ?? [],
    includeExternalBenchmarks: v.includeExternalBenchmarks,
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const steps: PlanStepDraft[] = [];
  let estimatedToolCalls = 0;
  if (normalized.includeExternalBenchmarks) {
    steps.push({
      title: `[${capability.name}] Retrieve public ${normalized.processDomain} operational benchmarks`,
      description:
        `Specialization (${config.specialization}): query public operational control and cycle-time practices for ${normalized.processDomain} via brave-search:web@1.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    });
    estimatedToolCalls = 1;
  }

  const analyzeDeps = steps.length > 0 ? [0] : [];
  steps.push({
    title: `Diagnose bottlenecks (${diagnostics.baselineCycleHoursTotal}h vs ${diagnostics.targetSlaHours}h SLA) & draft RACI SOP`,
    description:
      `Analyze ${normalized.workflowStages.length} stages (primary bottleneck: "${diagnostics.primaryBottleneckStage}", manual handoffs: ${diagnostics.manualHandoffStageCount}) and produce RACI SOP steps and control gates in operations@1 JSON.`,
    capabilityId: capability.id,
    intent: 'ANALYZE',
    dependsOnIndices: analyzeDeps,
  });
  steps.push({
    title: 'Reconcile cycle-time math, control gates & escalation triggers',
    description:
      `Verify baselineCycleHoursTotal equals ${diagnostics.baselineCycleHoursTotal}h, sequential SOP numbering, mandatory control gates, and honest system integration limits.`,
    capabilityId: capability.id,
    intent: 'VERIFY',
    dependsOnIndices: [steps.length - 1],
  });

  assertPlanWithinCapabilityBounds('operations', capability, steps, estimatedToolCalls);

  return {
    pack: 'operations',
    contractKey: PACK_CONTRACT_KEYS.operations,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      ...(normalized.includeExternalBenchmarks
        ? ['Consent scope web:search: generic process-domain benchmark terms leave this deployment to api.search.brave.com; internal stage metrics stay local unless embedded in objective.']
        : ['External benchmark search disabled by caller; blueprint uses caller-supplied workflow telemetry only.']),
      'External connectors google-workspace and github are BLOCKED: SOPs and control gates are delivered as structured artifacts, not pushed into external ticketing or docs.',
    ],
    computedMetrics: {
      baselineCycleHoursTotal: diagnostics.baselineCycleHoursTotal,
      targetSlaHours: diagnostics.targetSlaHours,
      slaDeltaHours: diagnostics.slaDeltaHours,
      exceedsTargetSla: diagnostics.exceedsTargetSla,
      primaryBottleneckStage: diagnostics.primaryBottleneckStage,
      manualHandoffStageCount: diagnostics.manualHandoffStageCount,
    },
  };
}

function proposeFinancialAnalysisPack(
  raw: unknown,
  config: FinancialAnalysisPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = financialAnalysisPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('financial-analysis', parsed.error.issues);
  const v = parsed.data;

  const reportingCurrency = v.reportingCurrency.toUpperCase();
  const benchmarkCountry = v.benchmarkCountry.toUpperCase();
  const macroIndicator = v.macroIndicator.toUpperCase();

  if (!config.allowedCurrencies.includes(reportingCurrency)) {
    throw new DomainError('DENIED', `Currency '${reportingCurrency}' is outside operator-configured financial analysis scope`);
  }
  if (config.allowedCountries && !config.allowedCountries.includes(benchmarkCountry)) {
    throw new DomainError('DENIED', `Benchmark country '${benchmarkCountry}' is outside operator-configured financial analysis scope`);
  }
  if (config.allowedMacroIndicators && !config.allowedMacroIndicators.includes(macroIndicator)) {
    throw new DomainError('DENIED', `Macro indicator '${macroIndicator}' is outside operator-configured financial analysis scope`);
  }
  if (v.scenarios.length > config.maxScenarios) {
    throw new DomainError('INVALID_INPUT', `scenarios (${v.scenarios.length}) exceeds ceiling (${config.maxScenarios})`);
  }
  if (new Set(v.scenarios.map(s => s.name.toLowerCase())).size !== v.scenarios.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate scenario names in scenarios');
  }

  const sensitivity: ComputedFinancialSensitivity = computeFinancialSensitivity(v.baselineMetrics, v.scenarios);
  const normalized = {
    pack: 'financial-analysis' as const,
    objective: v.objective,
    reportingCurrency,
    benchmarkCountry,
    macroIndicator,
    baselineMetrics: v.baselineMetrics,
    scenarios: v.scenarios,
    horizonMonths: v.horizonMonths,
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const steps: PlanStepDraft[] = [
    {
      title: `[${capability.name}] Retrieve official ${macroIndicator} benchmark for ${benchmarkCountry}`,
      description:
        `Specialization (${config.specialization}): read the most recent official World Bank series for ${macroIndicator} in ${benchmarkCountry} via world-bank:indicator@1 to anchor macro context.`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `Model ${normalized.horizonMonths}-month unit economics & ${normalized.scenarios.length} stress scenario(s)`,
      description:
        `Compute unit economics in ${reportingCurrency} (baseline grossProfit=${sensitivity.monthlyGrossProfitMinor}, netCashFlow=${sensitivity.monthlyNetCashFlowMinor}, runway=${sensitivity.impliedRunwayMonths ?? 'cash-positive'}) and ${normalized.scenarios.map(s => s.name).join(', ')} in financial-analysis@1 JSON.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [0],
    },
    {
      title: 'Reconcile deterministic cash-flow arithmetic, World Bank citation & non-advisory disclaimers',
      description:
        'Verify every unit-economics and scenario figure matches deterministic calculation, confirm caller-supplied inputs are disclosed as unverified ledger assumptions, and enforce non-audit/non-investment-advice governance.',
      capabilityId: capability.id,
      intent: 'VERIFY',
      dependsOnIndices: [1],
    },
  ];
  const estimatedToolCalls = 1;
  assertPlanWithinCapabilityBounds('financial-analysis', capability, steps, estimatedToolCalls);

  return {
    pack: 'financial-analysis',
    contractKey: PACK_CONTRACT_KEYS['financial-analysis'],
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      'Caller-supplied revenue, margin, opex, and cash figures are modeled as unverified customer inputs; only the World Bank macro series is externally retrieved.',
      'External connector stripe is BLOCKED: live billing/MRR ledger ingestion is unavailable.',
      'Analytical output only: this deliverable is not a statutory audit, tax opinion, or regulated investment advice.',
    ],
    computedMetrics: {
      reportingCurrency,
      monthlyGrossProfitMinor: sensitivity.monthlyGrossProfitMinor,
      monthlyNetCashFlowMinor: sensitivity.monthlyNetCashFlowMinor,
      impliedRunwayMonths: sensitivity.impliedRunwayMonths,
      cacPaybackMonths: sensitivity.cacPaybackMonths,
      scenarios: sensitivity.scenarios,
    },
  };
}

function proposeContentPack(
  raw: unknown,
  config: ContentPackServiceConfig,
  capability: CapabilityDefinition,
): BusinessPackPlanProposal {
  const parsed = contentPackRequestSchema.safeParse(raw);
  if (!parsed.success) rejectSchemaIssues('content', parsed.error.issues);
  const v = parsed.data;

  if (!config.allowedFormats.includes(v.contentFormat)) {
    throw new DomainError('DENIED', `Content format '${v.contentFormat}' is outside operator-configured content scope`);
  }
  if (!config.allowedLocales.includes(v.language)) {
    throw new DomainError('DENIED', `Language '${v.language}' is outside operator-configured content scope`);
  }
  if (v.referenceQueries.length > config.maxReferenceQueries) {
    throw new DomainError(
      'INVALID_INPUT',
      `referenceQueries (${v.referenceQueries.length}) exceeds ceiling (${config.maxReferenceQueries})`,
    );
  }
  if (new Set(v.referenceQueries.map(q => q.toLowerCase())).size !== v.referenceQueries.length) {
    throw new DomainError('INVALID_INPUT', 'Duplicate queries in referenceQueries');
  }

  const normalized = {
    pack: 'content' as const,
    objective: v.objective,
    topic: v.topic,
    contentFormat: v.contentFormat,
    targetAudience: v.targetAudience,
    language: v.language,
    toneProfile: v.toneProfile,
    referenceQueries: v.referenceQueries,
    targetWordCount: v.targetWordCount,
    editorialExclusions: v.editorialExclusions ?? [],
    includeFullDraft: v.includeFullDraft,
    note: v.note ?? null,
  };
  const fingerprint = digestObject(normalized);

  const estimatedToolCalls = normalized.referenceQueries.length;
  const steps: PlanStepDraft[] = [
    {
      title: `[${capability.name}] Gather verifiable reference sources across ${normalized.referenceQueries.length} query(ies)`,
      description:
        `Specialization (${config.specialization}): search authoritative public sources via brave-search:web@1 (searchLang=${normalized.language}) for [${normalized.referenceQueries.join('; ')}].`,
      capabilityId: capability.id,
      intent: 'RESEARCH',
      dependsOnIndices: [],
    },
    {
      title: `Architect ${normalized.contentFormat} editorial brief & section outline (${normalized.language.toUpperCase()})`,
      description:
        `Design headline, core thesis, reader takeaway, and section outline in ${normalized.language.toUpperCase()} (${normalized.toneProfile} tone, ~${normalized.targetWordCount} words) tailored to "${normalized.targetAudience}".`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [0],
    },
  ];
  if (normalized.includeFullDraft) {
    steps.push({
      title: `Draft publication-ready sections & claim-to-citation ledger (${normalized.language.toUpperCase()})`,
      description:
        `Write full Markdown sections in ${normalized.language.toUpperCase()} honoring exclusions (${normalized.editorialExclusions.join('; ') || 'none'}) and bind every factual assertion in claimCitationLedger inside content@1 JSON.`,
      capabilityId: capability.id,
      intent: 'ANALYZE',
      dependsOnIndices: [1],
    });
  }
  steps.push({
    title: 'Verify citation ledger, editorial exclusions & zero fabricated quotes',
    description:
      'Audit every factual claim in claimCitationLedger against captured Brave Search URIs, confirm zero invented expert quotes, and verify compliance with editorial exclusions.',
    capabilityId: capability.id,
    intent: 'VERIFY',
    dependsOnIndices: [steps.length - 1],
  });

  assertPlanWithinCapabilityBounds('content', capability, steps, estimatedToolCalls);

  return {
    pack: 'content',
    contractKey: PACK_CONTRACT_KEYS.content,
    fingerprint,
    goalSummary: `[${config.displayName}] ${normalized.objective}`,
    normalizedConstraints: normalized,
    steps,
    estimatedToolCalls,
    requiresUserApproval: true,
    warnings: [
      'Consent scope web:search: reference queries leave this deployment to api.search.brave.com when executed.',
      'External connectors wordpress-woocommerce and linkedin are BLOCKED: QeyNox delivers verified drafts and never auto-publishes to external CMS or social accounts.',
    ],
  };
}

export function buildPackPlanProposal(
  config: PackServiceConfig,
  capability: CapabilityDefinition,
  rawInput: unknown,
): BusinessPackPlanProposal {
  assertBusinessPackProvider(config.pack, capability);
  switch (config.pack) {
    case 'research':
      return proposeResearchPack(rawInput, config, capability);
    case 'strategy':
      return proposeStrategyPack(rawInput, config, capability);
    case 'marketing':
      return proposeMarketingPack(rawInput, config, capability);
    case 'seo':
      return proposeSeoPack(rawInput, config, capability);
    case 'sales':
      return proposeSalesPack(rawInput, config, capability);
    case 'operations':
      return proposeOperationsPack(rawInput, config, capability);
    case 'financial-analysis':
      return proposeFinancialAnalysisPack(rawInput, config, capability);
    case 'content':
      return proposeContentPack(rawInput, config, capability);
  }
}

export function buildServiceContractMeta(config: PackServiceConfig): ServiceContractMeta {
  const deliverableSections = [...DELIVERABLE_SECTIONS_BY_PACK[config.pack]];
  switch (config.pack) {
    case 'research':
      return {
        pack: 'research',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          ...(config.allowedCountries ? { allowedCountries: config.allowedCountries } : {}),
          ...(config.allowedIndicators ? { allowedIndicators: config.allowedIndicators } : {}),
          maximumObservations: config.maximumObservations,
        },
      };
    case 'strategy':
      return {
        pack: 'strategy',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          allowedFrameworks: config.allowedFrameworks,
          allowedHorizons: config.allowedHorizons,
          maxCompetitors: config.maxCompetitors,
        },
      };
    case 'marketing':
      return {
        pack: 'marketing',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          allowedChannels: config.allowedChannels,
          allowedStages: config.allowedStages,
          maxChannels: config.maxChannels,
        },
      };
    case 'seo':
      return {
        pack: 'seo',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          ...(config.allowedCountries ? { allowedCountries: config.allowedCountries } : {}),
          ...(config.allowedSearchLocales ? { allowedSearchLocales: config.allowedSearchLocales } : {}),
          maxTargetQueries: config.maxTargetQueries,
          maxAuditedUrls: config.maxAuditedUrls,
        },
      };
    case 'sales':
      return {
        pack: 'sales',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          allowedMethodologies: config.allowedMethodologies,
          allowedDealStages: config.allowedDealStages,
          maxTargetAccounts: config.maxTargetAccounts,
        },
      };
    case 'operations':
      return {
        pack: 'operations',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          allowedProcessDomains: config.allowedProcessDomains,
          maxWorkflowStages: config.maxWorkflowStages,
        },
      };
    case 'financial-analysis':
      return {
        pack: 'financial-analysis',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          ...(config.allowedCountries ? { allowedCountries: config.allowedCountries } : {}),
          ...(config.allowedMacroIndicators ? { allowedMacroIndicators: config.allowedMacroIndicators } : {}),
          allowedCurrencies: config.allowedCurrencies,
          maxScenarios: config.maxScenarios,
        },
      };
    case 'content':
      return {
        pack: 'content',
        displayName: config.displayName,
        specialization: config.specialization,
        deliverableSections,
        options: {
          allowedFormats: config.allowedFormats,
          allowedLocales: config.allowedLocales,
          maxReferenceQueries: config.maxReferenceQueries,
        },
      };
  }
}

export function parsePackServiceConfig(raw: unknown): PackServiceConfig {
  const parsed = packServiceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => (issue.path.join('.') || 'service') + ': ' + issue.message)
      .join('; ');
    throw new DomainError('NOT_CONFIGURED', 'Invalid business pack service configuration: ' + detail);
  }
  return parsed.data;
}

/**
 * Stateful application service for one operator-configured business capability pack.
 * Reads live capability configuration from QeyNoxStore on every call so operator edits to capability
 * names, step/tool bounds, and verification policies take effect immediately without code changes.
 */
export class BusinessPackService {
  constructor(
    private readonly store: QeyNoxStore,
    readonly config: PackServiceConfig,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
  ) {}

  get contractKey(): string {
    return PACK_CONTRACT_KEYS[this.config.pack];
  }

  async capability(): Promise<CapabilityDefinition> {
    const found = await this.store.getCapability(this.config.capabilityId as ID);
    if (!found) {
      throw new DomainError('NOT_CONFIGURED', `Capability is not configured: ${this.config.capabilityId}`);
    }
    if (found.status !== 'ACTIVE') {
      throw new DomainError(
        'NOT_CONFIGURED',
        `Capability '${found.id}' is not ACTIVE (current status: ${found.status})`,
      );
    }
    return found;
  }

  async availability(): Promise<{
    readonly operationalState: string;
    readonly executable: boolean;
    readonly blockers: readonly string[];
  }> {
    const definition = await this.store.getCapability(this.config.capabilityId as ID);
    if (!definition) {
      return { operationalState: 'BLOCKED', executable: false, blockers: ['CAPABILITY_NOT_CONFIGURED'] };
    }
    const index = await capabilityAvailability(this.store, [definition], this.runtime);
    const entry = index.byCapabilityId.get(definition.id);
    const blockers: string[] = [];
    if (!entry?.providerReady) blockers.push('PROVIDER_NOT_CONFIGURED');
    if (!entry?.profileReady) blockers.push('PROFILE_NOT_CONFIGURED');
    if (!entry?.policyReady) blockers.push('POLICY_NOT_CONFIGURED');
    if (this.runtime().overallState !== 'OPERATIONAL') blockers.push('RUNTIME_NOT_OPERATIONAL');
    return {
      operationalState: entry?.operationalState ?? 'BLOCKED',
      executable: entry?.isExecutable === true,
      blockers,
    };
  }

  contractMeta(): ServiceContractMeta {
    return buildServiceContractMeta(this.config);
  }

  async propose(rawInput: unknown): Promise<BusinessPackPlanProposal> {
    const cap = await this.capability();
    return buildPackPlanProposal(this.config, cap, rawInput);
  }

  async createPlan(
    actor: Principal,
    rawInput: unknown,
    planning: PlanningService,
  ): Promise<CreatedPackOperationPlan> {
    const proposal = await this.propose(rawInput);
    const title = this.config.displayName;
    const constraints = [
      `contract:${proposal.contractKey}`,
      `pack:${proposal.pack}`,
      `specialization:${this.config.specialization}`,
      `fingerprint:${proposal.fingerprint}`,
    ];
    // P09: record the validated, normalized request with the operation so the worker can recover it
    // (and prove it via the fingerprint) when it executes the pack's business steps.
    const operation = await this.store.createOperation(actor, title, proposal.goalSummary, constraints, {
      contractKey: proposal.contractKey,
      pack: proposal.pack,
      capabilityId: this.config.capabilityId as ID,
      fingerprint: proposal.fingerprint,
      normalizedRequestJson: JSON.stringify(proposal.normalizedConstraints),
    });
    const created = await planning.create(actor, operation.id, operation.version, proposal.steps);
    return { operationId: operation.id, revisionId: created.revision.id, proposal };
  }
}
