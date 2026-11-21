import { z } from 'zod';

/**
 * MISSION A16 — Eight distinct, operator-editable business capability packs.
 *
 * Domains:
 *   1. research            — Macroeconomic & market indicator research
 *   2. strategy            — Competitive & market positioning strategy
 *   3. marketing           — Go-to-market & campaign architecture
 *   4. seo                 — Technical SEO & search-intent visibility audit
 *   5. sales               — B2B account qualification & deal playbook
 *   6. operations          — Process bottleneck diagnostic & SOP blueprint
 *   7. financial-analysis  — Unit economics, cash-flow sensitivity & macro benchmark
 *   8. content             — Evidence-backed editorial brief & authority content pack
 *
 * Every pack has:
 *   - a typed customer request contract (never a generic free-form chat prompt);
 *   - an operator-editable service configuration (displayName, specialization, allowlists, ceilings);
 *   - a typed structured deliverable output schema separating provider-observed facts from caller
 *     assumptions and analytical synthesis.
 */

export const BUSINESS_PACK_DOMAINS = [
  'research',
  'strategy',
  'marketing',
  'seo',
  'sales',
  'operations',
  'financial-analysis',
  'content',
] as const;
export type BusinessPackDomain = (typeof BUSINESS_PACK_DOMAINS)[number];
export const businessPackDomainSchema = z.enum(BUSINESS_PACK_DOMAINS);

export const SERVICE_CONTRACT_RESEARCH_PACK = 'research-pack@1' as const;
export const SERVICE_CONTRACT_STRATEGY_PACK = 'strategy-pack@1' as const;
export const SERVICE_CONTRACT_MARKETING_PACK = 'marketing-pack@1' as const;
export const SERVICE_CONTRACT_SEO_PACK = 'seo-pack@1' as const;
export const SERVICE_CONTRACT_SALES_PACK = 'sales-pack@1' as const;
export const SERVICE_CONTRACT_OPERATIONS_PACK = 'operations-pack@1' as const;
export const SERVICE_CONTRACT_FINANCIAL_PACK = 'financial-analysis-pack@1' as const;
export const SERVICE_CONTRACT_CONTENT_PACK = 'content-pack@1' as const;

export const PACK_CONTRACT_KEYS = {
  research: SERVICE_CONTRACT_RESEARCH_PACK,
  strategy: SERVICE_CONTRACT_STRATEGY_PACK,
  marketing: SERVICE_CONTRACT_MARKETING_PACK,
  seo: SERVICE_CONTRACT_SEO_PACK,
  sales: SERVICE_CONTRACT_SALES_PACK,
  operations: SERVICE_CONTRACT_OPERATIONS_PACK,
  'financial-analysis': SERVICE_CONTRACT_FINANCIAL_PACK,
  content: SERVICE_CONTRACT_CONTENT_PACK,
} as const satisfies Record<BusinessPackDomain, string>;

const configIdSchema = z.string().trim().min(4).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const objectiveSchema = z.string().trim().min(20).max(5000);
const optionalNoteSchema = z.string().trim().max(500).optional();
const countryCodeSchema = z.string().trim().min(2).max(3).regex(/^[A-Za-z]{2,3}$/);
const iso2CountrySchema = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);
const indicatorCodeSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/);
const currencyCodeSchema = z.string().trim().length(3).regex(/^[A-Za-z]{3}$/);
const hostnameSchema = z.string().trim().min(4).max(253).regex(
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/,
  'Invalid domain hostname',
);
const httpsUrlSchema = z.string().trim().max(2048).refine(value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, 'HTTPS URL without embedded credentials required');
const verifiableHttpUrlSchema = z.string().trim().max(2048).refine(value => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, 'Verifiable HTTP(S) URL without embedded credentials required');

// =============================================================================================
// 1. RESEARCH PACK (Slot 1 default) — Macroeconomic & market indicator research
// =============================================================================================

export const RESEARCH_DECISION_HORIZONS = ['QUARTERLY', 'ANNUAL', 'MULTI_YEAR'] as const;
export type ResearchDecisionHorizon = (typeof RESEARCH_DECISION_HORIZONS)[number];

export const researchPackRequestSchema = z.object({
  objective: objectiveSchema,
  primaryCountry: countryCodeSchema,
  benchmarkCountry: countryCodeSchema.optional(),
  primaryIndicator: indicatorCodeSchema,
  comparisonIndicators: z.array(indicatorCodeSchema).max(2).optional(),
  mostRecent: z.number().int().min(1).max(10).optional(),
  minObservationYear: z.number().int().min(1960).max(new Date().getUTCFullYear()).optional(),
  decisionHorizon: z.enum(RESEARCH_DECISION_HORIZONS).default('ANNUAL'),
  includeSynthesis: z.boolean().default(true),
  note: optionalNoteSchema,
}).strict();
export type ResearchPackRequestInput = z.input<typeof researchPackRequestSchema>;

export const researchDeliverableSchema = z.object({
  pack: z.literal('research'),
  schemaVersion: z.literal(1),
  executiveSummary: z.string().trim().min(20).max(4000),
  observedSeries: z.array(z.object({
    country: z.string().regex(/^[A-Z]{2,3}$/),
    indicator: z.string().regex(/^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/),
    observations: z.array(z.object({
      year: z.string().regex(/^\d{4}$/),
      value: z.number().nullable(),
      unit: z.string().trim().min(1).max(80).optional(),
    }).strict()).min(1).max(10),
    sourceUri: verifiableHttpUrlSchema,
    retrievedAt: z.string().trim().min(10).max(64),
    responseDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    publicationFreshness: z.enum(['UNKNOWN_PROVIDER_LAG', 'RECORDED']),
  }).strict()).min(1).max(6),
  comparativeInsights: z.array(z.object({
    statement: z.string().trim().min(10).max(1500),
    basis: z.enum(['OBSERVED', 'INTERPRETATION']),
    supportingIndicators: z.array(z.string().min(3).max(64)).min(1).max(6),
  }).strict()).min(1).max(12),
  dataLimitations: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
  recommendedNextChecks: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
}).strict();
export type ResearchDeliverable = z.infer<typeof researchDeliverableSchema>;

// =============================================================================================
// 2. STRATEGY PACK (Slot 2 default) — Competitive & market positioning strategy
// =============================================================================================

export const STRATEGY_FRAMEWORKS = [
  'POSITIONING_MATRIX',
  'PORTER_FIVE_FORCES',
  'MARKET_ENTRY_SCORECARD',
  'VALUE_PROPOSITION_GAP',
] as const;
export type StrategyFramework = (typeof STRATEGY_FRAMEWORKS)[number];

export const STRATEGY_HORIZONS = ['90_DAYS', '6_MONTHS', '12_MONTHS', '24_MONTHS'] as const;
export type StrategyHorizon = (typeof STRATEGY_HORIZONS)[number];

export const strategyPackRequestSchema = z.object({
  objective: objectiveSchema,
  companyOfferSummary: z.string().trim().min(20).max(1500),
  targetMarket: z.string().trim().min(3).max(200),
  competitors: z.array(z.string().trim().min(2).max(120)).min(1).max(5),
  framework: z.enum(STRATEGY_FRAMEWORKS),
  strategicHorizon: z.enum(STRATEGY_HORIZONS),
  resourceConstraints: z.array(z.string().trim().min(3).max(240)).min(1).max(6),
  note: optionalNoteSchema,
}).strict();
export type StrategyPackRequestInput = z.input<typeof strategyPackRequestSchema>;

export const strategyDeliverableSchema = z.object({
  pack: z.literal('strategy'),
  schemaVersion: z.literal(1),
  framework: z.enum(STRATEGY_FRAMEWORKS),
  positioningThesis: z.string().trim().min(20).max(3000),
  competitorMatrix: z.array(z.object({
    competitor: z.string().trim().min(2).max(120),
    observedPositioning: z.string().trim().min(10).max(1000),
    strengths: z.array(z.string().trim().min(3).max(300)).min(1).max(6),
    vulnerabilities: z.array(z.string().trim().min(3).max(300)).min(1).max(6),
    evidenceUris: z.array(verifiableHttpUrlSchema).min(1).max(5),
  }).strict()).min(1).max(5),
  strategicOptions: z.array(z.object({
    optionTitle: z.string().trim().min(5).max(200),
    tradeOffs: z.array(z.string().trim().min(5).max(400)).min(1).max(6),
    resourceFit: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    keyRisks: z.array(z.string().trim().min(5).max(400)).min(1).max(6),
  }).strict()).min(1).max(4),
  assumptionsRequiringValidation: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
  ninetyDayPriorities: z.array(z.string().trim().min(5).max(500)).min(1).max(8),
}).strict();
export type StrategyDeliverable = z.infer<typeof strategyDeliverableSchema>;

// =============================================================================================
// 3. MARKETING PACK (Slot 3 default) — Go-to-market & campaign architecture
// =============================================================================================

export const MARKETING_CHANNELS = [
  'ORGANIC_SEARCH',
  'PAID_SEARCH',
  'LINKEDIN_ORGANIC',
  'PAID_SOCIAL',
  'EMAIL_NURTURE',
  'PARTNER_CO_MARKETING',
  'WEBINAR_EVENTS',
] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

export const MARKETING_FUNNEL_STAGES = [
  'PROBLEM_AWARE',
  'SOLUTION_AWARE',
  'PRODUCT_EVALUATION',
  'CUSTOMER_EXPANSION',
] as const;
export type MarketingFunnelStage = (typeof MARKETING_FUNNEL_STAGES)[number];

export const marketingPackRequestSchema = z.object({
  objective: objectiveSchema,
  offerDescription: z.string().trim().min(20).max(1500),
  idealCustomerProfile: z.string().trim().min(15).max(1000),
  primaryFunnelStage: z.enum(MARKETING_FUNNEL_STAGES),
  candidateChannels: z.array(z.enum(MARKETING_CHANNELS)).min(1).max(5),
  monthlyMediaBudgetMinor: z.number().int().min(0).max(1_000_000_000),
  budgetCurrency: currencyCodeSchema,
  campaignWindowWeeks: z.number().int().min(2).max(52),
  complianceConstraints: z.array(z.string().trim().min(3).max(240)).max(5).optional(),
  note: optionalNoteSchema,
}).strict();
export type MarketingPackRequestInput = z.input<typeof marketingPackRequestSchema>;

export const marketingDeliverableSchema = z.object({
  pack: z.literal('marketing'),
  schemaVersion: z.literal(1),
  messagingPillars: z.array(z.object({
    pillar: z.string().trim().min(3).max(160),
    targetPain: z.string().trim().min(5).max(400),
    proofRequired: z.string().trim().min(5).max(400),
    copyAngle: z.string().trim().min(10).max(600),
  }).strict()).min(1).max(5),
  channelPlan: z.array(z.object({
    channel: z.enum(MARKETING_CHANNELS),
    funnelStage: z.enum(MARKETING_FUNNEL_STAGES),
    roleInMix: z.string().trim().min(5).max(400),
    budgetSharePercent: z.number().min(0).max(100),
    experimentHypothesis: z.string().trim().min(10).max(500),
    killCriterion: z.string().trim().min(5).max(400),
  }).strict()).min(1).max(5),
  measurementPlan: z.array(z.object({
    metricName: z.string().trim().min(2).max(120),
    dataSourceNote: z.string().trim().min(5).max(300),
    targetDefinition: z.string().trim().min(5).max(300),
  }).strict()).min(1).max(8),
  marketEvidenceUris: z.array(verifiableHttpUrlSchema).min(1).max(8),
  complianceAndPlatformLimits: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
  launchChecklist: z.array(z.string().trim().min(5).max(400)).min(1).max(10),
}).strict();
export type MarketingDeliverable = z.infer<typeof marketingDeliverableSchema>;

// =============================================================================================
// 4. SEO PACK (Slot 4 default) — Technical SEO & search-intent visibility audit
// =============================================================================================

export const SEO_AUDIT_FOCUSES = [
  'SERP_INTENT_GAP',
  'ON_PAGE_ARCHITECTURE',
  'CONTENT_CONSOLIDATION',
  'FULL_AUDIT',
] as const;
export type SeoAuditFocus = (typeof SEO_AUDIT_FOCUSES)[number];

export const seoPackRequestSchema = z.object({
  objective: objectiveSchema,
  domain: hostnameSchema,
  auditedUrls: z.array(httpsUrlSchema).min(1).max(10),
  targetQueries: z.array(z.string().trim().min(2).max(120)).min(1).max(8),
  country: iso2CountrySchema,
  searchLang: z.string().trim().min(2).max(5).regex(/^[a-zA-Z]{2}(?:-[a-zA-Z]{2})?$/),
  auditFocus: z.enum(SEO_AUDIT_FOCUSES).default('FULL_AUDIT'),
  callerReportedIssues: z.array(z.string().trim().min(3).max(300)).max(5).optional(),
  note: optionalNoteSchema,
}).strict();
export type SeoPackRequestInput = z.input<typeof seoPackRequestSchema>;

export const seoDeliverableSchema = z.object({
  pack: z.literal('seo'),
  schemaVersion: z.literal(1),
  domain: hostnameSchema,
  serpObservations: z.array(z.object({
    query: z.string().trim().min(2).max(120),
    dominantIntent: z.enum(['INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL']),
    domainObservedInTopResults: z.boolean(),
    topCompetitorUrls: z.array(verifiableHttpUrlSchema).max(5),
    sourceUri: verifiableHttpUrlSchema,
  }).strict()).min(1).max(8),
  urlFindings: z.array(z.object({
    url: httpsUrlSchema,
    issueCategory: z.enum(['INDEXATION', 'INTENT_MISMATCH', 'METADATA', 'INTERNAL_LINKING', 'CONTENT_DEPTH']),
    finding: z.string().trim().min(10).max(800),
    evidenceBasis: z.enum(['SERP_OBSERVED', 'CALLER_REPORTED']),
    priority: z.enum(['P1', 'P2', 'P3']),
    remediation: z.string().trim().min(10).max(800),
  }).strict()).min(1).max(20),
  telemetryLimitations: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
  prioritizedRoadmap: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
}).strict();
export type SeoDeliverable = z.infer<typeof seoDeliverableSchema>;

// =============================================================================================
// 5. SALES PACK (Slot 5 default) — B2B account qualification & deal playbook
// =============================================================================================

export const SALES_METHODOLOGIES = ['MEDDPICC', 'SPICED', 'BANT_ENTERPRISE', 'VALUE_SELLING'] as const;
export type SalesMethodology = (typeof SALES_METHODOLOGIES)[number];

export const SALES_DEAL_STAGES = [
  'PROSPECTING_QUALIFICATION',
  'DISCOVERY',
  'SOLUTION_VALIDATION',
  'COMMERCIAL_NEGOTIATION',
] as const;
export type SalesDealStage = (typeof SALES_DEAL_STAGES)[number];

export const SALES_DEAL_SIZE_BANDS = ['SMB', 'MID_MARKET', 'ENTERPRISE'] as const;
export type SalesDealSizeBand = (typeof SALES_DEAL_SIZE_BANDS)[number];

export const salesTargetAccountSchema = z.object({
  accountName: z.string().trim().min(2).max(120),
  accountDomain: hostnameSchema.optional(),
  industry: z.string().trim().min(2).max(80),
}).strict();

export const salesPackRequestSchema = z.object({
  objective: objectiveSchema,
  sellerSolutionSummary: z.string().trim().min(20).max(1500),
  targetAccounts: z.array(salesTargetAccountSchema).min(1).max(3),
  buyerPersonas: z.array(z.string().trim().min(2).max(80)).min(1).max(5),
  methodology: z.enum(SALES_METHODOLOGIES),
  dealStage: z.enum(SALES_DEAL_STAGES),
  dealSizeBand: z.enum(SALES_DEAL_SIZE_BANDS),
  knownObjections: z.array(z.string().trim().min(3).max(240)).max(5).optional(),
  note: optionalNoteSchema,
}).strict();
export type SalesPackRequestInput = z.input<typeof salesPackRequestSchema>;

export const salesDeliverableSchema = z.object({
  pack: z.literal('sales'),
  schemaVersion: z.literal(1),
  methodology: z.enum(SALES_METHODOLOGIES),
  accountBriefs: z.array(z.object({
    accountName: z.string().trim().min(2).max(120),
    observedSignals: z.array(z.string().trim().min(5).max(500)).min(1).max(8),
    qualificationScoreRationale: z.string().trim().min(10).max(800),
    fitRisks: z.array(z.string().trim().min(5).max(400)).min(1).max(6),
    sourceUris: z.array(verifiableHttpUrlSchema).min(1).max(5),
  }).strict()).min(1).max(3),
  stakeholderRoleMap: z.array(z.object({
    roleTitle: z.string().trim().min(2).max(80),
    primaryEvaluationCriteria: z.array(z.string().trim().min(3).max(300)).min(1).max(6),
    discoveryQuestions: z.array(z.string().trim().min(10).max(400)).min(1).max(6),
  }).strict()).min(1).max(5),
  objectionPlaybook: z.array(z.object({
    objection: z.string().trim().min(5).max(300),
    responseFramework: z.string().trim().min(10).max(800),
    proofPointRequired: z.string().trim().min(5).max(400),
  }).strict()).min(1).max(8),
  mutualActionPlan: z.array(z.object({
    stepOrder: z.number().int().min(1).max(20),
    milestone: z.string().trim().min(5).max(300),
    ownerSide: z.enum(['SELLER', 'BUYER', 'JOINT']),
    exitCriterion: z.string().trim().min(5).max(300),
  }).strict()).min(1).max(10),
  dataAndOutreachBoundaries: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
}).strict();
export type SalesDeliverable = z.infer<typeof salesDeliverableSchema>;

// =============================================================================================
// 6. OPERATIONS PACK (Slot 6 default) — Process bottleneck diagnostic & SOP blueprint
// =============================================================================================

export const OPERATIONS_PROCESS_DOMAINS = [
  'CUSTOMER_ONBOARDING',
  'ORDER_TO_CASH',
  'INCIDENT_MANAGEMENT',
  'PROCUREMENT_APPROVAL',
  'SERVICE_DELIVERY',
  'QUALITY_ASSURANCE',
] as const;
export type OperationsProcessDomain = (typeof OPERATIONS_PROCESS_DOMAINS)[number];

export const operationsWorkflowStageSchema = z.object({
  stageName: z.string().trim().min(2).max(120),
  ownerRole: z.string().trim().min(2).max(80),
  medianCycleHours: z.number().min(0).max(8760),
  errorOrReworkRatePercent: z.number().min(0).max(100).optional(),
  manualHandoff: z.boolean(),
}).strict();

export const operationsPackRequestSchema = z.object({
  objective: objectiveSchema,
  processName: z.string().trim().min(3).max(160),
  processDomain: z.enum(OPERATIONS_PROCESS_DOMAINS),
  workflowStages: z.array(operationsWorkflowStageSchema).min(2).max(12),
  targetSlaHours: z.number().positive().max(8760),
  complianceOrControlRequirements: z.array(z.string().trim().min(3).max(240)).max(6).optional(),
  includeExternalBenchmarks: z.boolean().default(true),
  note: optionalNoteSchema,
}).strict();
export type OperationsPackRequestInput = z.input<typeof operationsPackRequestSchema>;

export const operationsDeliverableSchema = z.object({
  pack: z.literal('operations'),
  schemaVersion: z.literal(1),
  processName: z.string().trim().min(3).max(160),
  baselineCycleHoursTotal: z.number().min(0).max(105_120),
  targetSlaHours: z.number().positive().max(8760),
  bottleneckDiagnosis: z.array(z.object({
    stageName: z.string().trim().min(2).max(120),
    cycleSharePercent: z.number().min(0).max(100),
    rootCauseHypothesis: z.string().trim().min(10).max(600),
    riskLevel: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    remediationAction: z.string().trim().min(10).max(600),
  }).strict()).min(1).max(12),
  sopSteps: z.array(z.object({
    stepNumber: z.number().int().min(1).max(30),
    procedure: z.string().trim().min(10).max(800),
    responsibleRole: z.string().trim().min(2).max(80),
    accountableRole: z.string().trim().min(2).max(80),
    controlCheck: z.string().trim().min(5).max(400),
    escalationTrigger: z.string().trim().min(5).max(400),
  }).strict()).min(2).max(20),
  controlGates: z.array(z.object({
    gateName: z.string().trim().min(3).max(160),
    requiredBeforeStage: z.string().trim().min(2).max(120),
    approverRole: z.string().trim().min(2).max(80),
    auditArtifact: z.string().trim().min(3).max(240),
  }).strict()).min(1).max(10),
  benchmarkReferenceUris: z.array(verifiableHttpUrlSchema).max(6).optional(),
  systemIntegrationLimits: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
}).strict();
export type OperationsDeliverable = z.infer<typeof operationsDeliverableSchema>;

// =============================================================================================
// 7. FINANCIAL ANALYSIS PACK (Slot 7 default) — Unit economics, sensitivity & macro benchmark
// =============================================================================================

export const financialBaselineMetricsSchema = z.object({
  monthlyRevenueMinor: z.number().int().min(0).max(1_000_000_000_000),
  /** Basis points: 0..10000 where 7500 = 75.00% gross margin. */
  grossMarginBasisPoints: z.number().int().min(0).max(10_000),
  monthlyFixedOpexMinor: z.number().int().min(0).max(1_000_000_000_000),
  cashReserveMinor: z.number().int().min(0).max(1_000_000_000_000),
  customerAcquisitionCostMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
  averageRevenuePerAccountMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
  monthlyLogoChurnBasisPoints: z.number().int().min(0).max(10_000).optional(),
}).strict();

export const financialScenarioInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Basis points delta vs baseline revenue, e.g. -2000 = -20%, +1500 = +15%. */
  revenueDeltaBasisPoints: z.number().int().min(-10_000).max(50_000),
  opexDeltaBasisPoints: z.number().int().min(-9000).max(50_000),
  grossMarginDeltaBasisPoints: z.number().int().min(-5000).max(5000),
}).strict();

export const financialAnalysisPackRequestSchema = z.object({
  objective: objectiveSchema,
  reportingCurrency: currencyCodeSchema,
  benchmarkCountry: countryCodeSchema,
  macroIndicator: indicatorCodeSchema,
  baselineMetrics: financialBaselineMetricsSchema,
  scenarios: z.array(financialScenarioInputSchema).min(1).max(4),
  horizonMonths: z.number().int().min(3).max(36),
  note: optionalNoteSchema,
}).strict();
export type FinancialAnalysisPackRequestInput = z.input<typeof financialAnalysisPackRequestSchema>;

export const financialAnalysisDeliverableSchema = z.object({
  pack: z.literal('financial-analysis'),
  schemaVersion: z.literal(1),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  unitEconomicsSummary: z.object({
    monthlyGrossProfitMinor: z.number().int(),
    monthlyNetCashFlowMinor: z.number().int(),
    impliedRunwayMonths: z.number().nonnegative().nullable(),
    cacPaybackMonths: z.number().nonnegative().nullable(),
    basisNote: z.string().trim().min(5).max(500),
  }).strict(),
  scenarioTable: z.array(z.object({
    scenarioName: z.string().trim().min(2).max(80),
    projectedMonthlyRevenueMinor: z.number().int().nonnegative(),
    projectedMonthlyNetCashFlowMinor: z.number().int(),
    projectedRunwayMonths: z.number().nonnegative().nullable(),
    keySensitivityDriver: z.string().trim().min(5).max(400),
  }).strict()).min(1).max(4),
  macroBenchmarkContext: z.object({
    country: z.string().regex(/^[A-Z]{2,3}$/),
    indicator: z.string().regex(/^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/),
    latestObservedYear: z.string().regex(/^\d{4}$/),
    latestObservedValue: z.number().nullable(),
    sourceUri: verifiableHttpUrlSchema,
    interpretation: z.string().trim().min(10).max(1000),
  }).strict(),
  callerAssumptionsDisclosed: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
  governanceAndAdvisoryDisclaimers: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
}).strict();
export type FinancialAnalysisDeliverable = z.infer<typeof financialAnalysisDeliverableSchema>;

// =============================================================================================
// 8. CONTENT PACK (Slot 8 default) — Evidence-backed editorial brief & authority content pack
// =============================================================================================

export const CONTENT_FORMATS = [
  'EXECUTIVE_BRIEF',
  'TECHNICAL_ARTICLE',
  'WHITEPAPER_OUTLINE',
  'COMPARISON_GUIDE',
  'CASE_STUDY_FRAMEWORK',
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const CONTENT_TONE_PROFILES = [
  'ANALYTICAL',
  'EXECUTIVE_DIRECT',
  'TECHNICAL_PRACTITIONER',
] as const;
export type ContentToneProfile = (typeof CONTENT_TONE_PROFILES)[number];

export const CONTENT_LANGUAGES = ['en', 'fr'] as const;
export type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];

export const contentPackRequestSchema = z.object({
  objective: objectiveSchema,
  topic: z.string().trim().min(5).max(200),
  contentFormat: z.enum(CONTENT_FORMATS),
  targetAudience: z.string().trim().min(5).max(300),
  language: z.enum(CONTENT_LANGUAGES),
  toneProfile: z.enum(CONTENT_TONE_PROFILES).default('ANALYTICAL'),
  referenceQueries: z.array(z.string().trim().min(3).max(120)).min(1).max(4),
  targetWordCount: z.number().int().min(400).max(4000),
  editorialExclusions: z.array(z.string().trim().min(3).max(240)).max(5).optional(),
  includeFullDraft: z.boolean().default(true),
  note: optionalNoteSchema,
}).strict();
export type ContentPackRequestInput = z.input<typeof contentPackRequestSchema>;

export const contentDeliverableSchema = z.object({
  pack: z.literal('content'),
  schemaVersion: z.literal(1),
  contentFormat: z.enum(CONTENT_FORMATS),
  language: z.enum(CONTENT_LANGUAGES),
  editorialBrief: z.object({
    headline: z.string().trim().min(5).max(200),
    coreThesis: z.string().trim().min(15).max(1000),
    targetReaderTakeaway: z.string().trim().min(10).max(600),
    toneProfile: z.enum(CONTENT_TONE_PROFILES),
  }).strict(),
  structuredSections: z.array(z.object({
    heading: z.string().trim().min(3).max(160),
    summary: z.string().trim().min(10).max(600),
    bodyMarkdown: z.string().trim().min(20).max(8000),
    citedSourceUris: z.array(verifiableHttpUrlSchema).max(6),
  }).strict()).min(1).max(10),
  claimCitationLedger: z.array(z.object({
    factualStatement: z.string().trim().min(10).max(600),
    sourceUri: verifiableHttpUrlSchema,
    verificationNote: z.string().trim().min(5).max(300),
  }).strict()).min(1).max(20),
  editorialDisclosures: z.array(z.string().trim().min(5).max(500)).min(1).max(10),
  distributionChecklist: z.array(z.string().trim().min(5).max(400)).min(1).max(10),
}).strict();
export type ContentDeliverable = z.infer<typeof contentDeliverableSchema>;

/** Discriminated union of all eight structured pack deliverables. */
export const packDeliverableEnvelopeSchema = z.discriminatedUnion('pack', [
  researchDeliverableSchema,
  strategyDeliverableSchema,
  marketingDeliverableSchema,
  seoDeliverableSchema,
  salesDeliverableSchema,
  operationsDeliverableSchema,
  financialAnalysisDeliverableSchema,
  contentDeliverableSchema,
]);
export type PackDeliverable = z.infer<typeof packDeliverableEnvelopeSchema>;

// =============================================================================================
// Operator-editable service pack configuration schemas (service / services in operator JSON)
// =============================================================================================

const baseEditablePackConfig = {
  capabilityId: configIdSchema,
  offerId: configIdSchema,
  budgetPolicyId: configIdSchema,
  /** Operator-editable customer-facing name for this service pack specialization. */
  displayName: z.string().trim().min(3).max(160),
  /** Operator-editable domain specialization description carried into catalogue & plans. */
  specialization: z.string().trim().min(10).max(600),
};

export const researchPackServiceConfigSchema = z.object({
  pack: z.literal('research'),
  ...baseEditablePackConfig,
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2,3}$/)).min(1).max(64).optional(),
  allowedIndicators: z.array(z.string().regex(/^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/)).min(1).max(64).optional(),
  maximumObservations: z.number().int().min(1).max(10).default(5),
}).strict();

export const strategyPackServiceConfigSchema = z.object({
  pack: z.literal('strategy'),
  ...baseEditablePackConfig,
  allowedFrameworks: z.array(z.enum(STRATEGY_FRAMEWORKS)).min(1).max(4).default([...STRATEGY_FRAMEWORKS]),
  allowedHorizons: z.array(z.enum(STRATEGY_HORIZONS)).min(1).max(4).default([...STRATEGY_HORIZONS]),
  maxCompetitors: z.number().int().min(1).max(5).default(4),
}).strict();

export const marketingPackServiceConfigSchema = z.object({
  pack: z.literal('marketing'),
  ...baseEditablePackConfig,
  allowedChannels: z.array(z.enum(MARKETING_CHANNELS)).min(1).max(7).default([...MARKETING_CHANNELS]),
  allowedStages: z.array(z.enum(MARKETING_FUNNEL_STAGES)).min(1).max(4).default([...MARKETING_FUNNEL_STAGES]),
  maxChannels: z.number().int().min(1).max(5).default(4),
}).strict();

export const seoPackServiceConfigSchema = z.object({
  pack: z.literal('seo'),
  ...baseEditablePackConfig,
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(64).optional(),
  allowedSearchLocales: z.array(z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/)).min(1).max(20).optional(),
  maxTargetQueries: z.number().int().min(1).max(8).default(5),
  maxAuditedUrls: z.number().int().min(1).max(10).default(5),
}).strict();

export const salesPackServiceConfigSchema = z.object({
  pack: z.literal('sales'),
  ...baseEditablePackConfig,
  allowedMethodologies: z.array(z.enum(SALES_METHODOLOGIES)).min(1).max(4).default([...SALES_METHODOLOGIES]),
  allowedDealStages: z.array(z.enum(SALES_DEAL_STAGES)).min(1).max(4).default([...SALES_DEAL_STAGES]),
  maxTargetAccounts: z.number().int().min(1).max(3).default(3),
}).strict();

export const operationsPackServiceConfigSchema = z.object({
  pack: z.literal('operations'),
  ...baseEditablePackConfig,
  allowedProcessDomains: z.array(z.enum(OPERATIONS_PROCESS_DOMAINS)).min(1).max(6).default([...OPERATIONS_PROCESS_DOMAINS]),
  maxWorkflowStages: z.number().int().min(2).max(12).default(8),
}).strict();

export const financialAnalysisPackServiceConfigSchema = z.object({
  pack: z.literal('financial-analysis'),
  ...baseEditablePackConfig,
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2,3}$/)).min(1).max(64).optional(),
  allowedMacroIndicators: z.array(z.string().regex(/^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/)).min(1).max(64).optional(),
  allowedCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(20).default(['EUR', 'USD', 'GBP', 'MAD']),
  maxScenarios: z.number().int().min(1).max(4).default(3),
}).strict();

export const contentPackServiceConfigSchema = z.object({
  pack: z.literal('content'),
  ...baseEditablePackConfig,
  allowedFormats: z.array(z.enum(CONTENT_FORMATS)).min(1).max(5).default([...CONTENT_FORMATS]),
  allowedLocales: z.array(z.enum(CONTENT_LANGUAGES)).min(1).max(2).default(['en', 'fr']),
  maxReferenceQueries: z.number().int().min(1).max(4).default(3),
}).strict();

export const packServiceConfigSchema = z.discriminatedUnion('pack', [
  researchPackServiceConfigSchema,
  strategyPackServiceConfigSchema,
  marketingPackServiceConfigSchema,
  seoPackServiceConfigSchema,
  salesPackServiceConfigSchema,
  operationsPackServiceConfigSchema,
  financialAnalysisPackServiceConfigSchema,
  contentPackServiceConfigSchema,
]);
export type PackServiceConfig = z.infer<typeof packServiceConfigSchema>;
export type ResearchPackServiceConfig = z.infer<typeof researchPackServiceConfigSchema>;
export type StrategyPackServiceConfig = z.infer<typeof strategyPackServiceConfigSchema>;
export type MarketingPackServiceConfig = z.infer<typeof marketingPackServiceConfigSchema>;
export type SeoPackServiceConfig = z.infer<typeof seoPackServiceConfigSchema>;
export type SalesPackServiceConfig = z.infer<typeof salesPackServiceConfigSchema>;
export type OperationsPackServiceConfig = z.infer<typeof operationsPackServiceConfigSchema>;
export type FinancialAnalysisPackServiceConfig = z.infer<typeof financialAnalysisPackServiceConfigSchema>;
export type ContentPackServiceConfig = z.infer<typeof contentPackServiceConfigSchema>;

/** Truthful declaration of a blocked/unavailable external connector relevant to a business pack. */
export const unavailableExternalConnectorSchema = z.object({
  connectorId: z.string(),
  purpose: z.string(),
  state: z.literal('BLOCKED'),
  blocker: z.string(),
});
export type UnavailableExternalConnector = z.infer<typeof unavailableExternalConnectorSchema>;

/** Read-only operator-editable metadata & constraints exposed on ServiceDetail for dynamic forms. */
export const serviceContractMetaSchema = z.object({
  pack: businessPackDomainSchema,
  displayName: z.string(),
  specialization: z.string(),
  deliverableSections: z.array(z.string()),
  options: z.record(z.string(), z.union([z.array(z.string()), z.number(), z.boolean()])),
});
export type ServiceContractMeta = z.infer<typeof serviceContractMetaSchema>;
