/**
 * Canonical, valid customer requests for the eight A16 business packs.
 *
 * Shared by `qa:business-packs` (A16) and `qa:beta-execution` (A21.03) so both suites exercise the
 * exact same typed request contracts. QA fixtures only; never imported by application code.
 */
import type { BusinessPackDomain, PackDeliverable } from '@qeynox/contracts';

// Canonical valid customer requests for all 8 business packs
export const VALID_PACK_REQUESTS: Readonly<Record<BusinessPackDomain, unknown>> = {
  research: {
    objective: 'Compare Morocco and France macroeconomic inflation and GDP per capita across the last 3 years',
    primaryCountry: 'ma',
    benchmarkCountry: 'fr',
    primaryIndicator: 'ny.gdp.pcap.cd',
    comparisonIndicators: ['fp.cpi.totl.zg'],
    mostRecent: 3,
    minObservationYear: 2021,
    decisionHorizon: 'ANNUAL',
    includeSynthesis: true,
    note: 'Board regional expansion review',
  },
  strategy: {
    objective: 'Define QeyNox European mid-market positioning and 90-day competitive differentiation options',
    companyOfferSummary: 'Audited RaaS business operations platform with deterministic budgets and human review gates',
    targetMarket: 'European regulated mid-market financial and professional services',
    competitors: ['AcmeOps Cloud', 'BetaAgent Enterprise'],
    framework: 'POSITIONING_MATRIX',
    strategicHorizon: '90_DAYS',
    resourceConstraints: ['Lean 3-person enterprise GTM team', 'Zero outbound cold-spam policy'],
  },
  marketing: {
    objective: 'Architect an 8-week B2B launch campaign with strict channel kill criteria and zero ad-platform hype',
    offerDescription: 'Evidence-backed RaaS service catalogue for strategy, finance, SEO, and operations teams',
    idealCustomerProfile: 'COOs, Heads of Operations, and Finance Directors at 100-1000 employee European firms',
    primaryFunnelStage: 'SOLUTION_AWARE',
    candidateChannels: ['ORGANIC_SEARCH', 'LINKEDIN_ORGANIC', 'WEBINAR_EVENTS'],
    monthlyMediaBudgetMinor: 600_000,
    budgetCurrency: 'eur',
    campaignWindowWeeks: 8,
    complianceConstraints: ['GDPR explicit consent required', 'No competitor trademark bidding'],
  },
  seo: {
    objective: 'Audit search intent gaps and technical URL structure for our core commercial pages in France',
    domain: 'qeynox.example.com',
    auditedUrls: [
      'https://qeynox.example.com/services',
      'https://qeynox.example.com/security',
    ],
    targetQueries: [
      'audited ai business operations platform',
      'verified raas workflow governance',
    ],
    country: 'fr',
    searchLang: 'fr-fr',
    auditFocus: 'FULL_AUDIT',
    callerReportedIssues: ['Missing canonical link on localized service pages'],
  },
  sales: {
    objective: 'Prepare MEDDPICC qualification briefs, functional stakeholder questions, and a joint mutual action plan',
    sellerSolutionSummary: 'Audited business service execution with hard budget ceilings and source-bound verification',
    targetAccounts: [
      { accountName: 'Atlas Industrial Group', accountDomain: 'atlas-group.example', industry: 'Manufacturing' },
      { accountName: 'Meridian FinServ', accountDomain: 'meridian.example', industry: 'Financial Services' },
    ],
    buyerPersonas: ['Chief Operating Officer', 'Head of Information Security', 'VP Finance'],
    methodology: 'MEDDPICC',
    dealStage: 'DISCOVERY',
    dealSizeBand: 'ENTERPRISE',
    knownObjections: ['Security & data egress review cycle time'],
  },
  operations: {
    objective: 'Reduce enterprise customer onboarding cycle time below the 48-hour SLA while preserving audit controls',
    processName: 'Enterprise Workspace & Security Onboarding',
    processDomain: 'CUSTOMER_ONBOARDING',
    workflowStages: [
      { stageName: 'Contract & Scope Check', ownerRole: 'Deal Desk', medianCycleHours: 10, errorOrReworkRatePercent: 10, manualHandoff: true },
      { stageName: 'Security & Egress Review', ownerRole: 'Security Lead', medianCycleHours: 32, errorOrReworkRatePercent: 25, manualHandoff: true },
      { stageName: 'Workspace Provisioning', ownerRole: 'Platform Ops', medianCycleHours: 14, errorOrReworkRatePercent: 5, manualHandoff: false },
    ],
    targetSlaHours: 48,
    complianceOrControlRequirements: ['Dual approval required before activating outbound connectors'],
    includeExternalBenchmarks: true,
  },
  'financial-analysis': {
    objective: 'Evaluate baseline burn, runway, CAC payback, and downside revenue scenarios anchored to France CPI',
    reportingCurrency: 'eur',
    benchmarkCountry: 'fr',
    macroIndicator: 'fp.cpi.totl.zg',
    baselineMetrics: {
      monthlyRevenueMinor: 10_000_000,
      grossMarginBasisPoints: 8000,
      monthlyFixedOpexMinor: 10_500_000,
      cashReserveMinor: 60_000_000,
      customerAcquisitionCostMinor: 400_000,
      averageRevenuePerAccountMinor: 100_000,
    },
    scenarios: [
      { name: 'Downside -20% Revenue', revenueDeltaBasisPoints: -2000, opexDeltaBasisPoints: 0, grossMarginDeltaBasisPoints: -500 },
      { name: 'Cost Discipline -15% Opex', revenueDeltaBasisPoints: 0, opexDeltaBasisPoints: -1500, grossMarginDeltaBasisPoints: 0 },
    ],
    horizonMonths: 12,
  },
  content: {
    objective: 'Produce a bilingual-ready French executive brief on verifiable AI governance with a strict citation ledger',
    topic: 'Gouvernance vérifiable des opérations assistées par IA en entreprise',
    contentFormat: 'EXECUTIVE_BRIEF',
    targetAudience: 'Directeurs des opérations, RSSI et directions financières',
    language: 'fr',
    toneProfile: 'EXECUTIVE_DIRECT',
    referenceQueries: [
      'cadre gestion des risques ia entreprise auditabilite',
      'controle humain validation preuves automatisation',
    ],
    targetWordCount: 1200,
    editorialExclusions: ['Aucun superlatif marketing non sourcé', 'Aucune statistique inventée'],
    includeFullDraft: true,
  },
};

// Canonical valid structured deliverables for all 8 packs
export function buildValidDeliverables(): Record<BusinessPackDomain, { deliverable: PackDeliverable; capturedUris: string[] }> {
  const wbUri = 'https://api.worldbank.org/v2/country/MA/indicator/NY.GDP.PCAP.CD?format=json&per_page=3';
  const wbFrCpiUri = 'https://api.worldbank.org/v2/country/FR/indicator/FP.CPI.TOTL.ZG?format=json&per_page=3';
  const braveUri1 = 'https://example-public-source.org/enterprise-ops-benchmark';
  const braveUri2 = 'https://example-public-source.org/competitor-positioning-notes';

  return {
    research: {
      capturedUris: [wbUri],
      deliverable: {
        pack: 'research',
        schemaVersion: 1,
        executiveSummary: 'Official World Bank series show steady nominal GDP per capita progression in Morocco across captured years, subject to standard annual publication lag.',
        observedSeries: [{
          country: 'MA',
          indicator: 'NY.GDP.PCAP.CD',
          observations: [
            { year: '2023', value: 3672.1, unit: 'Current US$' },
            { year: '2022', value: 3442.0, unit: 'Current US$' },
          ],
          sourceUri: wbUri,
          retrievedAt: '2026-11-21T01:00:00.000Z',
          responseDigest: 'a'.repeat(64),
          publicationFreshness: 'UNKNOWN_PROVIDER_LAG',
        }],
        comparativeInsights: [{
          statement: 'Observed nominal GDP per capita increased between 2022 and 2023 in the official series.',
          basis: 'OBSERVED',
          supportingIndicators: ['NY.GDP.PCAP.CD'],
        }],
        dataLimitations: ['Annual World Bank series carries publication lag; sub-annual revisions are not captured.'],
        recommendedNextChecks: ['Cross-check national statistical bulletin before committing multi-year capital budgets.'],
      },
    },
    strategy: {
      capturedUris: [braveUri1, braveUri2],
      deliverable: {
        pack: 'strategy',
        schemaVersion: 1,
        framework: 'POSITIONING_MATRIX',
        positioningThesis: 'Differentiate on provable execution auditability, deterministic budget ceilings, and explicit human review rather than autonomous black-box promises.',
        competitorMatrix: [
          {
            competitor: 'AcmeOps Cloud',
            observedPositioning: 'Positions around rapid no-code workflow templates for SMB teams.',
            strengths: ['Fast self-serve template onboarding'],
            vulnerabilities: ['No source-digest claim verification or hard budget ledger'],
            evidenceUris: [braveUri1],
          },
          {
            competitor: 'BetaAgent Enterprise',
            observedPositioning: 'Markets autonomous multi-agent chat assistants for general enterprise knowledge.',
            strengths: ['Broad horizontal messaging'],
            vulnerabilities: ['Opaque cost ceilings and unverified third-party claims'],
            evidenceUris: [braveUri2],
          },
        ],
        strategicOptions: [{
          optionTitle: 'Compliance-First Mid-Market Wedge',
          tradeOffs: ['Longer security review on initial deals vs higher retention and audit trust'],
          resourceFit: 'HIGH',
          keyRisks: ['Requires crisp buyer education around connector boundaries'],
        }],
        assumptionsRequiringValidation: ['Private competitor net retention and enterprise discount bands are not publicly observable.'],
        ninetyDayPriorities: ['Publish transparent service pack scope cards and run 10 COO discovery interviews.'],
      },
    },
    marketing: {
      capturedUris: [braveUri1],
      deliverable: {
        pack: 'marketing',
        schemaVersion: 1,
        messagingPillars: [{
          pillar: 'Verifiable Deliverables Over Chat Noise',
          targetPain: 'Operations leaders cannot sign off on unverified AI prose without source digests.',
          proofRequired: 'Live ResultDocument export showing SHA-256 citation digests and approval records.',
          copyAngle: 'Every claim bound to a captured source, reviewed by your team before release.',
        }],
        channelPlan: [
          {
            channel: 'ORGANIC_SEARCH',
            funnelStage: 'SOLUTION_AWARE',
            roleInMix: 'Capture high-intent governance and audited operations queries.',
            budgetSharePercent: 40,
            experimentHypothesis: 'Comparison guides on auditable RaaS will convert technical evaluators into scoped trials.',
            killCriterion: 'Pause topic cluster if qualified mission requests remain zero after 6 published guides.',
          },
          {
            channel: 'LINKEDIN_ORGANIC',
            funnelStage: 'SOLUTION_AWARE',
            roleInMix: 'Executive education on fail-closed AI budgeting and verification.',
            budgetSharePercent: 25,
            experimentHypothesis: 'Founder & operator teardown posts drive direct service catalogue visits.',
            killCriterion: 'Rework format if engaged executive visits fall below threshold after 4 weeks.',
          },
          {
            channel: 'WEBINAR_EVENTS',
            funnelStage: 'PRODUCT_EVALUATION',
            roleInMix: 'Live walkthrough of real pack planning, quoting, and verification gates.',
            budgetSharePercent: 35,
            experimentHypothesis: 'Interactive architecture walkthroughs shorten enterprise evaluation cycles.',
            killCriterion: 'Discontinue series if fewer than 15 target-ICP registrants attend two consecutive sessions.',
          },
        ],
        measurementPlan: [{
          metricName: 'Scoped Service Requests Created',
          dataSourceNote: 'Measured in QeyNox commercial_orders and operations tables (GA4 connector BLOCKED).',
          targetDefinition: 'Authenticated workspace service requests reaching READY plan state.',
        }],
        marketEvidenceUris: [braveUri1],
        complianceAndPlatformLimits: [
          'Connectors meta, ga4, and linkedin are BLOCKED: human marketing operators execute external posts and ad spend manually.',
        ],
        launchChecklist: ['Approve messaging proof points with legal and security leads before launch.'],
      },
    },
    seo: {
      capturedUris: [braveUri1],
      deliverable: {
        pack: 'seo',
        schemaVersion: 1,
        domain: 'qeynox.example.com',
        serpObservations: [{
          query: 'audited ai business operations platform',
          dominantIntent: 'COMMERCIAL',
          domainObservedInTopResults: false,
          topCompetitorUrls: [braveUri1],
          sourceUri: braveUri1,
        }],
        urlFindings: [{
          url: 'https://qeynox.example.com/services',
          issueCategory: 'INTENT_MISMATCH',
          finding: 'Top commercial SERP results foreground concrete pack deliverables and governance architecture; audited URL lacks structured pack comparison headings.',
          evidenceBasis: 'SERP_OBSERVED',
          priority: 'P1',
          remediation: 'Add explicit H2 sections per business capability pack with scope, exclusions, and deliverable schemas.',
        }],
        telemetryLimitations: [
          'Connectors search-console and ga4 are BLOCKED: impression, click-through, and server crawl-log metrics were not read.',
        ],
        prioritizedRoadmap: ['P1: Deploy canonical link tags and structured service pack headings on /services.'],
      },
    },
    sales: {
      capturedUris: [braveUri1],
      deliverable: {
        pack: 'sales',
        schemaVersion: 1,
        methodology: 'MEDDPICC',
        accountBriefs: [{
          accountName: 'Atlas Industrial Group',
          observedSignals: ['Publicly announced European supply-chain digitization and audit standardization initiative.'],
          qualificationScoreRationale: 'Strong Metrics and Paper Process alignment due to strict internal compliance gates.',
          fitRisks: ['Multi-entity procurement cycle requires early security architecture sign-off.'],
          sourceUris: [braveUri1],
        }],
        stakeholderRoleMap: [{
          roleTitle: 'Chief Operating Officer',
          primaryEvaluationCriteria: ['Cycle-time predictability', 'Audit trail completeness', 'Hard cost ceilings'],
          discoveryQuestions: ['Which cross-functional workflows currently stall awaiting manual compliance verification?'],
        }],
        objectionPlaybook: [{
          objection: 'Security & data egress review cycle time',
          responseFramework: 'Demonstrate fail-closed EgressPolicy host allowlists, consent scopes, and zero unreviewed external connectors.',
          proofPointRequired: 'Live Control console service validation report and connector registry manifest.',
        }],
        mutualActionPlan: [
          {
            stepOrder: 1,
            milestone: 'Technical & Egress Architecture Review',
            ownerSide: 'JOINT',
            exitCriterion: 'Security Lead confirms allowed provider hosts and privacyScopes.',
          },
          {
            stepOrder: 2,
            milestone: 'Scoped Pilot Pack Execution & Deliverable Sign-Off',
            ownerSide: 'BUYER',
            exitCriterion: 'Executive sponsor reviews and approves ResultDocument v1.',
          },
        ],
        dataAndOutreachBoundaries: [
          'Strict role-based mapping only: zero personal email addresses or phone numbers are scraped or fabricated.',
          'Connectors linkedin and google-workspace are BLOCKED: all account outreach is executed manually by the seller.',
        ],
      },
    },
    operations: {
      capturedUris: [braveUri1],
      deliverable: {
        pack: 'operations',
        schemaVersion: 1,
        processName: 'Enterprise Workspace & Security Onboarding',
        baselineCycleHoursTotal: 56,
        targetSlaHours: 48,
        bottleneckDiagnosis: [{
          stageName: 'Security & Egress Review',
          cycleSharePercent: 57.14,
          rootCauseHypothesis: 'Manual ad-hoc questionnaire back-and-forth without pre-attested connector manifests causes 25% rework.',
          riskLevel: 'HIGH',
          remediationAction: 'Standardize pre-filled connector & egress attestation package at Contract Intake.',
        }],
        sopSteps: [
          {
            stepNumber: 1,
            procedure: 'Validate signed commercial scope and attach pre-attested EgressPolicy checklist.',
            responsibleRole: 'Deal Desk',
            accountableRole: 'Head of Operations',
            controlCheck: 'Verify offerId, termsVersion, and workspace budget ceiling.',
            escalationTrigger: 'Escalate within 4 hours if custom connector permissions are requested.',
          },
          {
            stepNumber: 2,
            procedure: 'Review outbound provider allowlist and record security sign-off artifact.',
            responsibleRole: 'Security Lead',
            accountableRole: 'CISO',
            controlCheck: 'Confirm privacyScopes match approved tenant data classification.',
            escalationTrigger: 'Block provisioning if any unreviewed connector appears.',
          },
        ],
        controlGates: [{
          gateName: 'Pre-Provisioning Egress Sign-Off',
          requiredBeforeStage: 'Workspace Provisioning',
          approverRole: 'Security Lead',
          auditArtifact: 'Signed Egress & Connector Attestation Record',
        }],
        benchmarkReferenceUris: [braveUri1],
        systemIntegrationLimits: [
          'Connectors google-workspace and github are BLOCKED: SOPs and control gates are exported as QeyNox deliverables rather than auto-created tickets.',
        ],
      },
    },
    'financial-analysis': {
      capturedUris: [wbFrCpiUri],
      deliverable: {
        pack: 'financial-analysis',
        schemaVersion: 1,
        reportingCurrency: 'EUR',
        unitEconomicsSummary: {
          monthlyGrossProfitMinor: 8_000_000,
          monthlyNetCashFlowMinor: -2_500_000,
          impliedRunwayMonths: 24,
          cacPaybackMonths: 5,
          basisNote: 'Computed deterministically over caller-supplied minor-unit baseline inputs.',
        },
        scenarioTable: [
          {
            scenarioName: 'Downside -20% Revenue',
            projectedMonthlyRevenueMinor: 8_000_000,
            projectedMonthlyNetCashFlowMinor: -4_500_000,
            projectedRunwayMonths: 13.33,
            keySensitivityDriver: 'Combined -20% top-line contraction and -500 bps gross margin compression nearly halves cash runway.',
          },
          {
            scenarioName: 'Cost Discipline -15% Opex',
            projectedMonthlyRevenueMinor: 10_000_000,
            projectedMonthlyNetCashFlowMinor: -925_000,
            projectedRunwayMonths: 64.86,
            keySensitivityDriver: '15% fixed opex reduction cuts net monthly burn by 63% without revenue growth assumptions.',
          },
        ],
        macroBenchmarkContext: {
          country: 'FR',
          indicator: 'FP.CPI.TOTL.ZG',
          latestObservedYear: '2023',
          latestObservedValue: 4.88,
          sourceUri: wbFrCpiUri,
          interpretation: 'Official World Bank French CPI inflation underscores the need to stress-test vendor and payroll opex indexation.',
        },
        callerAssumptionsDisclosed: [
          'Baseline monthly revenue, 80.00% gross margin, fixed opex, cash reserve, CAC, and ARPA are caller-supplied and unverified against bank or Stripe ledgers (stripe connector BLOCKED).',
        ],
        governanceAndAdvisoryDisclaimers: [
          'Analytical financial modeling output only; does not constitute a statutory audit, formal valuation, tax opinion, or regulated investment advice.',
        ],
      },
    },
    content: {
      capturedUris: [braveUri1, braveUri2],
      deliverable: {
        pack: 'content',
        schemaVersion: 1,
        contentFormat: 'EXECUTIVE_BRIEF',
        language: 'fr',
        editorialBrief: {
          headline: 'Gouvernance vérifiable des opérations assistées par IA : du prototype au contrôle probant',
          coreThesis: 'La valeur opérationnelle durable repose sur des contrats typés, des plafonds budgétaires déterministes et une revue humaine explicite des preuves.',
          targetReaderTakeaway: 'Exiger la séparation stricte entre faits observés, hypothèses fournies et synthèse analytique avant toute mise en production.',
          toneProfile: 'EXECUTIVE_DIRECT',
        },
        structuredSections: [{
          heading: '1. Pourquoi les assistants génériques échouent aux revues de conformité',
          summary: 'Analyse des risques liés aux sorties non sourcées et aux permissions implicites.',
          bodyMarkdown: 'Les directions opérationnelles et financières ne peuvent valider un livrable que lorsque chaque affirmation factuelle est reliée à une source horodatée et vérifiable.',
          citedSourceUris: [braveUri1],
        }],
        claimCitationLedger: [{
          factualStatement: 'Les référentiels publics de gestion des risques IA exigent la traçabilité des sources et une supervision humaine documentée.',
          sourceUri: braveUri1,
          verificationNote: 'Vérifié via la source publique capturée par Brave Search.',
        }],
        editorialDisclosures: [
          'Aucune citation directe ni statistique non présente dans le registre claimCitationLedger n’a été ajoutée.',
          'Les connecteurs wordpress-woocommerce et linkedin sont BLOQUÉS : publication finale assurée manuellement par votre équipe éditoriale.',
        ],
        distributionChecklist: [
          'Valider chaque URI du claimCitationLedger avant publication sur le site institutionnel.',
        ],
      },
    },
  };
}
