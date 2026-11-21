import { DomainError } from '@qeynox/domain';
import {
  type BusinessPackDomain,
  type ContentDeliverable,
  type FinancialAnalysisDeliverable,
  type FinancialAnalysisPackRequestInput,
  type MarketingDeliverable,
  type OperationsDeliverable,
  type OperationsPackRequestInput,
  type PackDeliverable,
  type ResearchDeliverable,
  type SalesDeliverable,
  type SeoDeliverable,
  type StrategyDeliverable,
  contentDeliverableSchema,
  financialAnalysisDeliverableSchema,
  marketingDeliverableSchema,
  operationsDeliverableSchema,
  researchDeliverableSchema,
  salesDeliverableSchema,
  seoDeliverableSchema,
  strategyDeliverableSchema,
} from '@qeynox/contracts';

/** Structured deliverable section descriptors surfaced in ServiceDetail.contractMeta and UI. */
export const DELIVERABLE_SECTIONS_BY_PACK: Readonly<Record<BusinessPackDomain, readonly string[]>> = {
  research: [
    'Executive Summary',
    'Observed Official Indicator Series (with source URI, timestamp & digest)',
    'Comparative Insights (observed vs interpretation)',
    'Data & Publication-Lag Limitations',
    'Recommended Next Verification Checks',
  ],
  strategy: [
    'Positioning Thesis & Selected Strategic Framework',
    'Competitor Matrix (with verifiable public evidence URIs)',
    'Strategic Options, Trade-offs & Resource Fit',
    'Unverified Market Assumptions Requiring Customer Validation',
    '90-Day Execution Priorities',
  ],
  marketing: [
    'Messaging Pillars, Target Pain & Required Proof',
    'Channel Mix, Funnel Roles, Budget Share & Kill Criteria',
    'Measurement Plan & Attribution Boundaries',
    'Market Evidence Citations',
    'Compliance & Disclosed Platform Limits (no live ad spend execution)',
    'Launch Readiness Checklist',
  ],
  seo: [
    'Live SERP Intent & Competitor Visibility Observations',
    'Audited URL Findings (separating SERP-observed vs caller-reported issues)',
    'Disclosed Telemetry Boundaries (Search Console / GA4 unavailable)',
    'Prioritized P1/P2/P3 Technical & Content Roadmap',
  ],
  sales: [
    'Account Qualification Briefs (backed by public company signals)',
    'Role-Based Stakeholder Map & Discovery Questions (no scraped personal contacts)',
    'Objection Handling Playbook & Required Proof Points',
    'Joint Mutual Action Plan (Seller / Buyer / Joint milestones)',
    'Data & Outreach Boundaries (no automated CRM/LinkedIn outreach)',
  ],
  operations: [
    'Baseline Cycle-Time & SLA Gap Summary',
    'Stage-by-Stage Bottleneck & Root-Cause Diagnosis',
    'RACI Standard Operating Procedure (Responsible, Accountable, Control, Escalation)',
    'Mandatory Approval & Audit Control Gates',
    'System Integration Boundaries',
  ],
  'financial-analysis': [
    'Deterministic Unit Economics Summary (Gross Profit, Net Cash Flow, Runway, CAC Payback)',
    'Stress-Test Scenario Sensitivity Table',
    'Official World Bank Macroeconomic Benchmark Context',
    'Explicit Caller-Supplied Input Assumptions Ledger',
    'Governance & Non-Advisory Disclaimers',
  ],
  content: [
    'Editorial Brief (Headline, Core Thesis, Target Reader Takeaway, Tone)',
    'Structured Publication Sections (Markdown + section citations)',
    'Claim-to-Citation Verification Ledger',
    'Editorial & Attribution Disclosures',
    'Manual Distribution Checklist (no auto-publishing to external CMS)',
  ],
};

// =============================================================================================
// Deterministic Computation Engines (Operations & Financial Analysis)
// =============================================================================================

export interface OperationsStageDiagnostic {
  readonly stageName: string;
  readonly ownerRole: string;
  readonly medianCycleHours: number;
  readonly cycleSharePercent: number;
  readonly manualHandoff: boolean;
  readonly errorOrReworkRatePercent: number;
  readonly bottleneckScore: number;
}

export interface OperationsProcessDiagnostics {
  readonly baselineCycleHoursTotal: number;
  readonly targetSlaHours: number;
  readonly slaDeltaHours: number;
  readonly exceedsTargetSla: boolean;
  readonly manualHandoffStageCount: number;
  readonly primaryBottleneckStage: string;
  readonly stages: readonly OperationsStageDiagnostic[];
}

export function computeProcessDiagnostics(
  workflowStages: OperationsPackRequestInput['workflowStages'],
  targetSlaHours: number,
): OperationsProcessDiagnostics {
  const rawTotal = workflowStages.reduce((sum, stage) => sum + stage.medianCycleHours, 0);
  const baselineCycleHoursTotal = Number(rawTotal.toFixed(2));
  const slaDeltaHours = Number((baselineCycleHoursTotal - targetSlaHours).toFixed(2));
  const stages: OperationsStageDiagnostic[] = workflowStages.map(stage => {
    const share = rawTotal > 0 ? Number(((stage.medianCycleHours / rawTotal) * 100).toFixed(2)) : 0;
    const errorRate = stage.errorOrReworkRatePercent ?? 0;
    const handoffPenalty = stage.manualHandoff ? 1.25 : 1;
    const reworkPenalty = 1 + errorRate / 100;
    const bottleneckScore = Number((stage.medianCycleHours * handoffPenalty * reworkPenalty).toFixed(2));
    return {
      stageName: stage.stageName.trim(),
      ownerRole: stage.ownerRole.trim(),
      medianCycleHours: Number(stage.medianCycleHours.toFixed(2)),
      cycleSharePercent: share,
      manualHandoff: stage.manualHandoff,
      errorOrReworkRatePercent: errorRate,
      bottleneckScore,
    };
  });
  const ranked = [...stages].sort((a, b) => b.bottleneckScore - a.bottleneckScore || b.medianCycleHours - a.medianCycleHours);
  return {
    baselineCycleHoursTotal,
    targetSlaHours: Number(targetSlaHours.toFixed(2)),
    slaDeltaHours,
    exceedsTargetSla: baselineCycleHoursTotal > targetSlaHours,
    manualHandoffStageCount: stages.filter(s => s.manualHandoff).length,
    primaryBottleneckStage: ranked[0]?.stageName ?? workflowStages[0]?.stageName ?? 'UNKNOWN',
    stages,
  };
}

export interface ComputedScenarioRow {
  readonly scenarioName: string;
  readonly projectedMonthlyRevenueMinor: number;
  readonly projectedGrossMarginBasisPoints: number;
  readonly projectedGrossProfitMinor: number;
  readonly projectedOpexMinor: number;
  readonly projectedMonthlyNetCashFlowMinor: number;
  readonly projectedRunwayMonths: number | null;
}

export interface ComputedFinancialSensitivity {
  readonly monthlyGrossProfitMinor: number;
  readonly monthlyNetCashFlowMinor: number;
  readonly impliedRunwayMonths: number | null;
  readonly cacPaybackMonths: number | null;
  readonly scenarios: readonly ComputedScenarioRow[];
}

export function computeFinancialSensitivity(
  baseline: FinancialAnalysisPackRequestInput['baselineMetrics'],
  scenarios: FinancialAnalysisPackRequestInput['scenarios'],
): ComputedFinancialSensitivity {
  const monthlyGrossProfitMinor = Math.round((baseline.monthlyRevenueMinor * baseline.grossMarginBasisPoints) / 10_000);
  const monthlyNetCashFlowMinor = monthlyGrossProfitMinor - baseline.monthlyFixedOpexMinor;
  const impliedRunwayMonths = monthlyNetCashFlowMinor < 0
    ? Number((baseline.cashReserveMinor / Math.abs(monthlyNetCashFlowMinor)).toFixed(2))
    : null;

  let cacPaybackMonths: number | null = null;
  if (
    baseline.customerAcquisitionCostMinor !== undefined &&
    baseline.averageRevenuePerAccountMinor !== undefined &&
    baseline.averageRevenuePerAccountMinor > 0 &&
    baseline.grossMarginBasisPoints > 0
  ) {
    const monthlyGrossProfitPerAccount = (baseline.averageRevenuePerAccountMinor * baseline.grossMarginBasisPoints) / 10_000;
    if (monthlyGrossProfitPerAccount > 0) {
      cacPaybackMonths = Number((baseline.customerAcquisitionCostMinor / monthlyGrossProfitPerAccount).toFixed(2));
    }
  }

  const computedScenarios: ComputedScenarioRow[] = scenarios.map(scenario => {
    const projectedMonthlyRevenueMinor = Math.max(
      0,
      Math.round((baseline.monthlyRevenueMinor * (10_000 + scenario.revenueDeltaBasisPoints)) / 10_000),
    );
    const projectedGrossMarginBasisPoints = Math.min(
      10_000,
      Math.max(0, baseline.grossMarginBasisPoints + scenario.grossMarginDeltaBasisPoints),
    );
    const projectedGrossProfitMinor = Math.round(
      (projectedMonthlyRevenueMinor * projectedGrossMarginBasisPoints) / 10_000,
    );
    const projectedOpexMinor = Math.max(
      0,
      Math.round((baseline.monthlyFixedOpexMinor * (10_000 + scenario.opexDeltaBasisPoints)) / 10_000),
    );
    const projectedMonthlyNetCashFlowMinor = projectedGrossProfitMinor - projectedOpexMinor;
    const projectedRunwayMonths = projectedMonthlyNetCashFlowMinor < 0
      ? Number((baseline.cashReserveMinor / Math.abs(projectedMonthlyNetCashFlowMinor)).toFixed(2))
      : null;
    return {
      scenarioName: scenario.name.trim(),
      projectedMonthlyRevenueMinor,
      projectedGrossMarginBasisPoints,
      projectedGrossProfitMinor,
      projectedOpexMinor,
      projectedMonthlyNetCashFlowMinor,
      projectedRunwayMonths,
    };
  });

  return {
    monthlyGrossProfitMinor,
    monthlyNetCashFlowMinor,
    impliedRunwayMonths,
    cacPaybackMonths,
    scenarios: computedScenarios,
  };
}

// =============================================================================================
// Deliverable Validation & Domain Integrity Rules
// =============================================================================================

export interface DeliverableValidationContext {
  /** Optional allowlist of source URIs actually captured through ToolBroker in this operation. */
  readonly capturedSourceUris?: readonly string[];
  /** Optional expected competitors for strategy deliverables. */
  readonly expectedCompetitors?: readonly string[];
  /** Optional expected channels & budget for marketing deliverables. */
  readonly expectedChannels?: readonly string[];
  readonly monthlyMediaBudgetMinor?: number;
  /** Optional deterministic operations diagnostics to verify arithmetic consistency. */
  readonly expectedDiagnostics?: OperationsProcessDiagnostics;
  /** Optional deterministic financial sensitivity to verify arithmetic consistency. */
  readonly expectedSensitivity?: ComputedFinancialSensitivity;
}

const GUARANTEED_OUTCOME_PATTERN = /\bguaranteed?\s+(roi|revenue|return|returns|ranking|rankings|first[- ]page|#1\s+position|profit|conversions?)\b/i;
const PERSONAL_EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_NUMBER_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/;
const FINANCIAL_ADVICE_CLAIM_PATTERN = /\b(certified\s+audit\s+opinion|personalized\s+investment\s+advice|formal\s+tax\s+opinion|buy\s+or\s+sell\s+securities)\b/i;

function assertNoGuaranteedOutcomes(serialized: string, pack: BusinessPackDomain): void {
  if (GUARANTEED_OUTCOME_PATTERN.test(serialized)) {
    throw new DomainError(
      'INVALID_INPUT',
      `Pack '${pack}' deliverable rejected: contains prohibited guaranteed-outcome claim`,
    );
  }
}

function assertCapturedUris(uris: readonly string[], captured: readonly string[] | undefined, pack: BusinessPackDomain): void {
  if (!captured) return;
  const allowed = new Set(captured);
  for (const uri of uris) {
    if (!allowed.has(uri)) {
      throw new DomainError(
        'INVALID_INPUT',
        `Pack '${pack}' deliverable cites unverified URI not present in captured ToolBroker sources: ${uri}`,
      );
    }
  }
}

function hostMatchesDomain(urlText: string, expectedDomain: string): boolean {
  try {
    const host = new URL(urlText).hostname.toLowerCase();
    const target = expectedDomain.toLowerCase();
    return host === target || host.endsWith('.' + target);
  } catch {
    return false;
  }
}

export function validatePackDeliverable(
  pack: BusinessPackDomain,
  candidate: unknown,
  context: DeliverableValidationContext = {},
): PackDeliverable {
  const schemas = {
    research: researchDeliverableSchema,
    strategy: strategyDeliverableSchema,
    marketing: marketingDeliverableSchema,
    seo: seoDeliverableSchema,
    sales: salesDeliverableSchema,
    operations: operationsDeliverableSchema,
    'financial-analysis': financialAnalysisDeliverableSchema,
    content: contentDeliverableSchema,
  } as const;

  const parsed = schemas[pack].safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => (issue.path.join('.') || pack) + ': ' + issue.message)
      .join('; ');
    throw new DomainError('INVALID_INPUT', `Invalid '${pack}' structured deliverable: ${detail}`);
  }

  const deliverable = parsed.data as PackDeliverable;
  const serialized = JSON.stringify(deliverable);
  assertNoGuaranteedOutcomes(serialized, pack);

  switch (deliverable.pack) {
    case 'research': {
      assertCapturedUris(
        deliverable.observedSeries.map(series => series.sourceUri),
        context.capturedSourceUris,
        'research',
      );
      break;
    }
    case 'strategy': {
      assertCapturedUris(
        deliverable.competitorMatrix.flatMap(entry => entry.evidenceUris),
        context.capturedSourceUris,
        'strategy',
      );
      if (context.expectedCompetitors) {
        const expected = new Set(context.expectedCompetitors.map(name => name.toLowerCase()));
        for (const row of deliverable.competitorMatrix) {
          if (!expected.has(row.competitor.toLowerCase())) {
            throw new DomainError(
              'INVALID_INPUT',
              `Strategy deliverable references competitor outside requested scope: ${row.competitor}`,
            );
          }
        }
      }
      break;
    }
    case 'marketing': {
      assertCapturedUris(deliverable.marketEvidenceUris, context.capturedSourceUris, 'marketing');
      const totalShare = deliverable.channelPlan.reduce((sum, item) => sum + item.budgetSharePercent, 0);
      const zeroBudget = context.monthlyMediaBudgetMinor === 0;
      if (!zeroBudget && Math.abs(totalShare - 100) > 0.5) {
        throw new DomainError(
          'INVALID_INPUT',
          `Marketing channelPlan budgetSharePercent must sum to 100% (got ${totalShare.toFixed(2)}%)`,
        );
      }
      if (context.expectedChannels) {
        const allowed = new Set(context.expectedChannels);
        for (const item of deliverable.channelPlan) {
          if (!allowed.has(item.channel)) {
            throw new DomainError(
              'INVALID_INPUT',
              `Marketing deliverable includes unrequested channel: ${item.channel}`,
            );
          }
        }
      }
      break;
    }
    case 'seo': {
      assertCapturedUris(
        deliverable.serpObservations.map(obs => obs.sourceUri),
        context.capturedSourceUris,
        'seo',
      );
      for (const finding of deliverable.urlFindings) {
        if (!hostMatchesDomain(finding.url, deliverable.domain)) {
          throw new DomainError(
            'INVALID_INPUT',
            `SEO finding URL '${finding.url}' does not belong to audited domain '${deliverable.domain}'`,
          );
        }
      }
      break;
    }
    case 'sales': {
      assertCapturedUris(
        deliverable.accountBriefs.flatMap(brief => brief.sourceUris),
        context.capturedSourceUris,
        'sales',
      );
      const roleAndAccountText = JSON.stringify({
        stakeholderRoleMap: deliverable.stakeholderRoleMap,
        accountBriefs: deliverable.accountBriefs,
      });
      if (PERSONAL_EMAIL_PATTERN.test(roleAndAccountText) || PHONE_NUMBER_PATTERN.test(roleAndAccountText)) {
        throw new DomainError(
          'INVALID_INPUT',
          'Sales deliverable rejected: contains personal email or phone contact data; role-based mapping only',
        );
      }
      for (let idx = 0; idx < deliverable.mutualActionPlan.length; idx++) {
        if (deliverable.mutualActionPlan[idx]?.stepOrder !== idx + 1) {
          throw new DomainError(
            'INVALID_INPUT',
            'Sales deliverable mutualActionPlan stepOrder must be sequential starting at 1',
          );
        }
      }
      break;
    }
    case 'operations': {
      if (deliverable.benchmarkReferenceUris?.length) {
        assertCapturedUris(deliverable.benchmarkReferenceUris, context.capturedSourceUris, 'operations');
      }
      for (let idx = 0; idx < deliverable.sopSteps.length; idx++) {
        if (deliverable.sopSteps[idx]?.stepNumber !== idx + 1) {
          throw new DomainError(
            'INVALID_INPUT',
            'Operations deliverable sopSteps stepNumber must be sequential starting at 1',
          );
        }
      }
      if (context.expectedDiagnostics) {
        if (Math.abs(deliverable.baselineCycleHoursTotal - context.expectedDiagnostics.baselineCycleHoursTotal) > 0.05) {
          throw new DomainError(
            'INVALID_INPUT',
            `Operations deliverable baselineCycleHoursTotal (${deliverable.baselineCycleHoursTotal}) mismatches computed stage sum (${context.expectedDiagnostics.baselineCycleHoursTotal})`,
          );
        }
        if (Math.abs(deliverable.targetSlaHours - context.expectedDiagnostics.targetSlaHours) > 0.05) {
          throw new DomainError(
            'INVALID_INPUT',
            `Operations deliverable targetSlaHours (${deliverable.targetSlaHours}) mismatches requested SLA (${context.expectedDiagnostics.targetSlaHours})`,
          );
        }
      }
      break;
    }
    case 'financial-analysis': {
      assertCapturedUris([deliverable.macroBenchmarkContext.sourceUri], context.capturedSourceUris, 'financial-analysis');
      if (FINANCIAL_ADVICE_CLAIM_PATTERN.test(serialized)) {
        throw new DomainError(
          'INVALID_INPUT',
          'Financial analysis deliverable rejected: claims formal audit, tax opinion, or investment advice',
        );
      }
      if (context.expectedSensitivity) {
        const summary = deliverable.unitEconomicsSummary;
        const expected = context.expectedSensitivity;
        if (
          summary.monthlyGrossProfitMinor !== expected.monthlyGrossProfitMinor ||
          summary.monthlyNetCashFlowMinor !== expected.monthlyNetCashFlowMinor
        ) {
          throw new DomainError(
            'INVALID_INPUT',
            'Financial analysis deliverable unitEconomicsSummary mismatches deterministic baseline calculation',
          );
        }
        const expectedByName = new Map(expected.scenarios.map(row => [row.scenarioName.toLowerCase(), row]));
        for (const row of deliverable.scenarioTable) {
          const match = expectedByName.get(row.scenarioName.toLowerCase());
          if (!match) {
            throw new DomainError(
              'INVALID_INPUT',
              `Financial analysis deliverable includes unexpected scenario '${row.scenarioName}'`,
            );
          }
          if (
            row.projectedMonthlyRevenueMinor !== match.projectedMonthlyRevenueMinor ||
            row.projectedMonthlyNetCashFlowMinor !== match.projectedMonthlyNetCashFlowMinor
          ) {
            throw new DomainError(
              'INVALID_INPUT',
              `Financial analysis scenario '${row.scenarioName}' arithmetic mismatches deterministic sensitivity engine`,
            );
          }
        }
      }
      break;
    }
    case 'content': {
      const ledgerUris = deliverable.claimCitationLedger.map(row => row.sourceUri);
      const sectionUris = deliverable.structuredSections.flatMap(sec => sec.citedSourceUris);
      assertCapturedUris([...ledgerUris, ...sectionUris], context.capturedSourceUris, 'content');
      break;
    }
  }

  return deliverable;
}

/** Extracts a JSON deliverable payload from raw agent output (raw JSON or ```json fenced block) and validates it. */
export function extractStructuredDeliverableFromJson(
  pack: BusinessPackDomain,
  rawText: string,
  context: DeliverableValidationContext = {},
): PackDeliverable {
  const trimmed = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const jsonCandidate = fenced?.[1]?.trim() ?? trimmed;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonCandidate);
  } catch {
    throw new DomainError('INVALID_INPUT', `Agent output for '${pack}' pack is not valid structured JSON`);
  }
  return validatePackDeliverable(pack, parsedJson, context);
}

export interface DeliverableResultProjection {
  readonly title: string;
  readonly scope: readonly string[];
  readonly observedClaimStatements: readonly { statement: string; sourceUri?: string }[];
  readonly analyticalStatements: readonly string[];
  readonly limitations: readonly string[];
  readonly nextActions: readonly string[];
}

/** Projects a validated PackDeliverable into structured claims, limitations and next actions for ResultDocument assembly. */
export function projectDeliverableToResultSummary(deliverable: PackDeliverable): DeliverableResultProjection {
  switch (deliverable.pack) {
    case 'research':
      return mapResearchDeliverable(deliverable);
    case 'strategy':
      return mapStrategyDeliverable(deliverable);
    case 'marketing':
      return mapMarketingDeliverable(deliverable);
    case 'seo':
      return mapSeoDeliverable(deliverable);
    case 'sales':
      return mapSalesDeliverable(deliverable);
    case 'operations':
      return mapOperationsDeliverable(deliverable);
    case 'financial-analysis':
      return mapFinancialDeliverable(deliverable);
    case 'content':
      return mapContentDeliverable(deliverable);
  }
}

function mapResearchDeliverable(d: ResearchDeliverable): DeliverableResultProjection {
  return {
    title: `Macroeconomic & Market Indicator Brief (${d.observedSeries.map(s => `${s.country}:${s.indicator}`).join(', ')})`,
    scope: d.observedSeries.map(s => `${s.country} · ${s.indicator} (${s.observations.length} obs)`),
    observedClaimStatements: d.observedSeries.map(s => ({
      statement: `${s.country} ${s.indicator}: ${s.observations.map(o => `${o.year}=${o.value ?? 'null'}`).join(', ')}`,
      sourceUri: s.sourceUri,
    })),
    analyticalStatements: d.comparativeInsights.map(c => c.statement),
    limitations: d.dataLimitations,
    nextActions: d.recommendedNextChecks,
  };
}

function mapStrategyDeliverable(d: StrategyDeliverable): DeliverableResultProjection {
  return {
    title: `Competitive & Positioning Strategy (${d.framework})`,
    scope: d.competitorMatrix.map(c => `Competitor: ${c.competitor}`),
    observedClaimStatements: d.competitorMatrix.map(c => ({
      statement: `${c.competitor}: ${c.observedPositioning}`,
      ...(c.evidenceUris[0] ? { sourceUri: c.evidenceUris[0] } : {}),
    })),
    analyticalStatements: [d.positioningThesis, ...d.strategicOptions.map(o => `${o.optionTitle} (${o.resourceFit} fit)`)],
    limitations: d.assumptionsRequiringValidation,
    nextActions: d.ninetyDayPriorities,
  };
}

function mapMarketingDeliverable(d: MarketingDeliverable): DeliverableResultProjection {
  return {
    title: 'Go-To-Market & Campaign Architecture Plan',
    scope: d.channelPlan.map(c => `${c.channel} (${c.budgetSharePercent}%)`),
    observedClaimStatements: d.marketEvidenceUris.map(uri => ({
      statement: `Public market positioning & category benchmark inspected at ${uri}`,
      sourceUri: uri,
    })),
    analyticalStatements: d.messagingPillars.map(p => `${p.pillar}: ${p.copyAngle}`),
    limitations: d.complianceAndPlatformLimits,
    nextActions: d.launchChecklist,
  };
}

function mapSeoDeliverable(d: SeoDeliverable): DeliverableResultProjection {
  return {
    title: `Technical SEO & Search Visibility Audit (${d.domain})`,
    scope: [`Domain: ${d.domain}`, ...d.serpObservations.map(s => `Query: ${s.query}`)],
    observedClaimStatements: d.serpObservations.map(s => ({
      statement: `Query "${s.query}" (${s.dominantIntent}): domain in top results=${s.domainObservedInTopResults}`,
      sourceUri: s.sourceUri,
    })),
    analyticalStatements: d.urlFindings.map(f => `[${f.priority}] ${f.url} (${f.evidenceBasis}): ${f.finding}`),
    limitations: d.telemetryLimitations,
    nextActions: d.prioritizedRoadmap,
  };
}

function mapSalesDeliverable(d: SalesDeliverable): DeliverableResultProjection {
  return {
    title: `B2B Account Qualification & Deal Playbook (${d.methodology})`,
    scope: d.accountBriefs.map(a => `Account: ${a.accountName}`),
    observedClaimStatements: d.accountBriefs.map(a => ({
      statement: `${a.accountName}: ${a.observedSignals.join('; ')}`,
      ...(a.sourceUris[0] ? { sourceUri: a.sourceUris[0] } : {}),
    })),
    analyticalStatements: d.objectionPlaybook.map(o => `${o.objection} -> ${o.responseFramework}`),
    limitations: d.dataAndOutreachBoundaries,
    nextActions: d.mutualActionPlan.map(m => `Step ${m.stepOrder} (${m.ownerSide}): ${m.milestone}`),
  };
}

function mapOperationsDeliverable(d: OperationsDeliverable): DeliverableResultProjection {
  return {
    title: `Process Bottleneck Diagnostic & SOP Blueprint (${d.processName})`,
    scope: [`Baseline: ${d.baselineCycleHoursTotal}h`, `Target SLA: ${d.targetSlaHours}h`],
    observedClaimStatements: (d.benchmarkReferenceUris ?? []).map(uri => ({
      statement: `External process benchmark inspected at ${uri}`,
      sourceUri: uri,
    })),
    analyticalStatements: d.bottleneckDiagnosis.map(b => `${b.stageName} (${b.cycleSharePercent}%): ${b.remediationAction}`),
    limitations: d.systemIntegrationLimits,
    nextActions: d.sopSteps.map(s => `SOP ${s.stepNumber} [${s.responsibleRole}]: ${s.procedure}`),
  };
}

function mapFinancialDeliverable(d: FinancialAnalysisDeliverable): DeliverableResultProjection {
  return {
    title: `Unit Economics & Cash-Flow Sensitivity Analysis (${d.reportingCurrency})`,
    scope: [
      `Currency: ${d.reportingCurrency}`,
      `Benchmark: ${d.macroBenchmarkContext.country} · ${d.macroBenchmarkContext.indicator}`,
    ],
    observedClaimStatements: [{
      statement: `Official World Bank series ${d.macroBenchmarkContext.country} ${d.macroBenchmarkContext.indicator} (${d.macroBenchmarkContext.latestObservedYear}): ${d.macroBenchmarkContext.latestObservedValue ?? 'null'}`,
      sourceUri: d.macroBenchmarkContext.sourceUri,
    }],
    analyticalStatements: d.scenarioTable.map(
      s => `Scenario ${s.scenarioName}: rev=${s.projectedMonthlyRevenueMinor}, netCashFlow=${s.projectedMonthlyNetCashFlowMinor}, runway=${s.projectedRunwayMonths ?? 'cash-positive'}`,
    ),
    limitations: [...d.callerAssumptionsDisclosed, ...d.governanceAndAdvisoryDisclaimers],
    nextActions: d.scenarioTable.map(s => `Monitor ${s.scenarioName} driver: ${s.keySensitivityDriver}`),
  };
}

function mapContentDeliverable(d: ContentDeliverable): DeliverableResultProjection {
  return {
    title: `Editorial Brief & Authority Content Pack: ${d.editorialBrief.headline}`,
    scope: [`Format: ${d.contentFormat}`, `Language: ${d.language.toUpperCase()}`],
    observedClaimStatements: d.claimCitationLedger.map(c => ({
      statement: c.factualStatement,
      sourceUri: c.sourceUri,
    })),
    analyticalStatements: d.structuredSections.map(s => `${s.heading}: ${s.summary}`),
    limitations: d.editorialDisclosures,
    nextActions: d.distributionChecklist,
  };
}
