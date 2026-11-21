'use client';
import { useActionState } from 'react';
import {
  CONTENT_FORMATS,
  CONTENT_LANGUAGES,
  CONTENT_TONE_PROFILES,
  MARKETING_CHANNELS,
  MARKETING_FUNNEL_STAGES,
  OPERATIONS_PROCESS_DOMAINS,
  RESEARCH_DECISION_HORIZONS,
  SALES_DEAL_SIZE_BANDS,
  SALES_DEAL_STAGES,
  SALES_METHODOLOGIES,
  SEO_AUDIT_FOCUSES,
  SERVICE_CONTRACT_CONTENT_PACK,
  SERVICE_CONTRACT_FINANCIAL_PACK,
  SERVICE_CONTRACT_MARKETING_PACK,
  SERVICE_CONTRACT_OPERATIONS_PACK,
  SERVICE_CONTRACT_RESEARCH_PACK,
  SERVICE_CONTRACT_SALES_PACK,
  SERVICE_CONTRACT_SEO_PACK,
  SERVICE_CONTRACT_STRATEGY_PACK,
  SERVICE_CONTRACT_WORLD_BANK,
  STRATEGY_FRAMEWORKS,
  STRATEGY_HORIZONS,
  type ServiceContractMeta,
} from '@qeynox/contracts';
import { serviceCopy, type ServiceCopy } from '../lib/service-copy';
import { requestService, type ServiceRequestState } from '../lib/service-actions';
import { errorText } from './forms';
import { Feedback } from './ui';
import type { Locale } from '../lib/copy';

const initialState: ServiceRequestState = { code: '' };

function optionList(meta: ServiceContractMeta | undefined, key: string, fallback: readonly string[]): readonly string[] {
  const candidate = meta?.options[key];
  return Array.isArray(candidate) && candidate.length > 0 ? candidate : fallback;
}

function optionNumber(meta: ServiceContractMeta | undefined, key: string, fallback: number): number {
  const candidate = meta?.options[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
}

function WorldBankLegacyFields({ s, off }: { s: ServiceCopy; off: boolean }) {
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="country">{s.country}</label>
          <input id="country" name="country" required minLength={2} maxLength={3} autoComplete="off" placeholder="MAR" aria-describedby="country-hint" disabled={off} />
          <span id="country-hint" className="muted">{s.countryHint}</span>
        </div>
        <div>
          <label htmlFor="indicator">{s.indicator}</label>
          <input id="indicator" name="indicator" required minLength={3} maxLength={64} autoComplete="off" placeholder="NY.GDP.PCAP.CD" aria-describedby="indicator-hint" disabled={off} />
          <span id="indicator-hint" className="muted">{s.indicatorHint}</span>
        </div>
        <div>
          <label htmlFor="mostRecent">{s.mostRecent}</label>
          <select id="mostRecent" name="mostRecent" defaultValue="3" disabled={off}>
            {[1, 2, 3, 4, 5].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="minObservationYear">{s.minYear}</label>
          <input id="minObservationYear" name="minObservationYear" type="number" inputMode="numeric" min={1960} max={new Date().getUTCFullYear()} placeholder="2020" disabled={off} />
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="compare1">{s.compare1}</label>
          <input id="compare1" name="compare1" maxLength={64} autoComplete="off" placeholder="NY.GDP.MKTP.KD.ZG" disabled={off} />
        </div>
        <div>
          <label htmlFor="compare2">{s.compare2}</label>
          <input id="compare2" name="compare2" maxLength={64} autoComplete="off" placeholder="SP.POP.TOTL" disabled={off} />
        </div>
      </div>
      <label className="checkbox"><input type="checkbox" name="includeInterpretation" defaultChecked disabled={off} /><span>{s.interpretation}</span></label>
    </>
  );
}

function ResearchPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const maxObs = optionNumber(meta, 'maximumObservations', 5);
  const countries = optionList(meta, 'allowedCountries', []);
  const indicators = optionList(meta, 'allowedIndicators', []);
  const obsChoices = Array.from({ length: maxObs }, (_, idx) => idx + 1);
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="primaryCountry">{s.country}</label>
          {countries.length > 0 ? (
            <select id="primaryCountry" name="primaryCountry" defaultValue={countries[0]} disabled={off}>
              {countries.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input id="primaryCountry" name="primaryCountry" required minLength={2} maxLength={3} placeholder="MA" disabled={off} />
          )}
        </div>
        <div>
          <label htmlFor="benchmarkCountry">{s.benchmarkCountry}</label>
          {countries.length > 0 ? (
            <select id="benchmarkCountry" name="benchmarkCountry" defaultValue="" disabled={off}>
              <option value="">—</option>
              {countries.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input id="benchmarkCountry" name="benchmarkCountry" maxLength={3} placeholder="FR" disabled={off} />
          )}
        </div>
        <div>
          <label htmlFor="primaryIndicator">{s.indicator}</label>
          {indicators.length > 0 ? (
            <select id="primaryIndicator" name="primaryIndicator" defaultValue={indicators[0]} disabled={off}>
              {indicators.map(ind => <option key={ind} value={ind}>{ind}</option>)}
            </select>
          ) : (
            <input id="primaryIndicator" name="primaryIndicator" required minLength={3} maxLength={64} placeholder="NY.GDP.PCAP.CD" disabled={off} />
          )}
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="mostRecent">{s.mostRecent}</label>
          <select id="mostRecent" name="mostRecent" defaultValue={String(Math.min(3, maxObs))} disabled={off}>
            {obsChoices.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="minObservationYear">{s.minYear}</label>
          <input id="minObservationYear" name="minObservationYear" type="number" min={1960} max={new Date().getUTCFullYear()} placeholder="2020" disabled={off} />
        </div>
        <div>
          <label htmlFor="decisionHorizon">{s.decisionHorizon}</label>
          <select id="decisionHorizon" name="decisionHorizon" defaultValue="ANNUAL" disabled={off}>
            {RESEARCH_DECISION_HORIZONS.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="compare1">{s.compare1}</label>
          <input id="compare1" name="compare1" maxLength={64} placeholder="FP.CPI.TOTL.ZG" disabled={off} />
        </div>
        <div>
          <label htmlFor="compare2">{s.compare2}</label>
          <input id="compare2" name="compare2" maxLength={64} placeholder="SL.UEM.TOTL.ZS" disabled={off} />
        </div>
      </div>
      <label className="checkbox"><input type="checkbox" name="includeSynthesis" defaultChecked disabled={off} /><span>{s.interpretation}</span></label>
    </>
  );
}

function StrategyPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const frameworks = optionList(meta, 'allowedFrameworks', STRATEGY_FRAMEWORKS);
  const horizons = optionList(meta, 'allowedHorizons', STRATEGY_HORIZONS);
  return (
    <>
      <label htmlFor="companyOfferSummary">{s.companyOfferSummary}</label>
      <textarea id="companyOfferSummary" name="companyOfferSummary" required minLength={20} maxLength={1500} rows={3} placeholder="B2B workflow platform for regulated finance & operations teams" disabled={off} />
      <div className="qx-service-row">
        <div>
          <label htmlFor="targetMarket">{s.targetMarket}</label>
          <input id="targetMarket" name="targetMarket" required minLength={3} maxLength={200} placeholder="Mid-market European & MENA financial services" disabled={off} />
        </div>
        <div>
          <label htmlFor="framework">{s.framework}</label>
          <select id="framework" name="framework" defaultValue={frameworks[0]} disabled={off}>
            {frameworks.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="strategicHorizon">{s.strategicHorizon}</label>
          <select id="strategicHorizon" name="strategicHorizon" defaultValue={horizons[0]} disabled={off}>
            {horizons.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="competitors">{s.competitors}</label>
          <textarea id="competitors" name="competitors" required rows={3} placeholder={"Competitor Alpha\nCompetitor Beta"} disabled={off} />
        </div>
        <div>
          <label htmlFor="resourceConstraints">{s.resourceConstraints}</label>
          <textarea id="resourceConstraints" name="resourceConstraints" required rows={3} placeholder={"2-person GTM team\nNo paid enterprise field sales in Q1"} disabled={off} />
        </div>
      </div>
    </>
  );
}

function MarketingPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const stages = optionList(meta, 'allowedStages', MARKETING_FUNNEL_STAGES);
  const channels = optionList(meta, 'allowedChannels', MARKETING_CHANNELS);
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="offerDescription">{s.offerDescription}</label>
          <textarea id="offerDescription" name="offerDescription" required minLength={20} maxLength={1500} rows={3} placeholder="Automated compliance evidence collection for SOC2 & ISO 27001" disabled={off} />
        </div>
        <div>
          <label htmlFor="idealCustomerProfile">{s.idealCustomerProfile}</label>
          <textarea id="idealCustomerProfile" name="idealCustomerProfile" required minLength={15} maxLength={1000} rows={3} placeholder="VP Engineering & CISO at 50-500 employee B2B SaaS companies" disabled={off} />
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="primaryFunnelStage">{s.primaryFunnelStage}</label>
          <select id="primaryFunnelStage" name="primaryFunnelStage" defaultValue={stages[0]} disabled={off}>
            {stages.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="monthlyMediaBudgetMinor">{s.monthlyMediaBudgetMinor}</label>
          <input id="monthlyMediaBudgetMinor" name="monthlyMediaBudgetMinor" type="number" min={0} defaultValue={500000} required disabled={off} />
        </div>
        <div>
          <label htmlFor="budgetCurrency">{s.budgetCurrency}</label>
          <input id="budgetCurrency" name="budgetCurrency" required minLength={3} maxLength={3} defaultValue="EUR" disabled={off} />
        </div>
        <div>
          <label htmlFor="campaignWindowWeeks">{s.campaignWindowWeeks}</label>
          <input id="campaignWindowWeeks" name="campaignWindowWeeks" type="number" min={2} max={52} defaultValue={8} required disabled={off} />
        </div>
      </div>
      <fieldset disabled={off}>
        <legend>{s.candidateChannels}</legend>
        <div className="qx-service-row">
          {channels.map((ch, idx) => (
            <label key={ch} className="checkbox">
              <input type="checkbox" name="candidateChannels" value={ch} defaultChecked={idx < 2} />
              <span>{ch}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor="complianceConstraints">{s.complianceConstraints}</label>
      <textarea id="complianceConstraints" name="complianceConstraints" rows={2} placeholder="GDPR opt-in required; no competitor trademark bidding" disabled={off} />
    </>
  );
}

function SeoPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const countries = optionList(meta, 'allowedCountries', ['FR', 'MA', 'GB', 'US', 'DE']);
  const locales = optionList(meta, 'allowedSearchLocales', ['en', 'fr']);
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="domain">{s.domainHost}</label>
          <input id="domain" name="domain" required minLength={4} maxLength={253} placeholder="example.com" disabled={off} />
        </div>
        <div>
          <label htmlFor="country">{s.country}</label>
          <select id="country" name="country" defaultValue={countries[0]} disabled={off}>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="searchLang">{s.searchLang}</label>
          <select id="searchLang" name="searchLang" defaultValue={locales[0]} disabled={off}>
            {locales.map(loc => <option key={loc} value={loc}>{loc}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="auditFocus">{s.auditFocus}</label>
          <select id="auditFocus" name="auditFocus" defaultValue="FULL_AUDIT" disabled={off}>
            {SEO_AUDIT_FOCUSES.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="auditedUrls">{s.auditedUrls}</label>
          <textarea id="auditedUrls" name="auditedUrls" required rows={3} placeholder={"https://example.com/pricing\nhttps://example.com/security"} disabled={off} />
        </div>
        <div>
          <label htmlFor="targetQueries">{s.targetQueries}</label>
          <textarea id="targetQueries" name="targetQueries" required rows={3} placeholder={"enterprise workflow governance\nauditable ai operations"} disabled={off} />
        </div>
      </div>
      <label htmlFor="callerReportedIssues">{s.callerReportedIssues}</label>
      <textarea id="callerReportedIssues" name="callerReportedIssues" rows={2} placeholder="Duplicate title tags on product docs" disabled={off} />
    </>
  );
}

function SalesPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const methodologies = optionList(meta, 'allowedMethodologies', SALES_METHODOLOGIES);
  const stages = optionList(meta, 'allowedDealStages', SALES_DEAL_STAGES);
  return (
    <>
      <label htmlFor="sellerSolutionSummary">{s.sellerSolutionSummary}</label>
      <textarea id="sellerSolutionSummary" name="sellerSolutionSummary" required minLength={20} maxLength={1500} rows={3} placeholder="Audited RaaS execution platform with deterministic budget & approval controls" disabled={off} />
      <div className="qx-service-row">
        <div>
          <label htmlFor="methodology">{s.methodology}</label>
          <select id="methodology" name="methodology" defaultValue={methodologies[0]} disabled={off}>
            {methodologies.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dealStage">{s.dealStage}</label>
          <select id="dealStage" name="dealStage" defaultValue={stages[0]} disabled={off}>
            {stages.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dealSizeBand">{s.dealSizeBand}</label>
          <select id="dealSizeBand" name="dealSizeBand" defaultValue="MID_MARKET" disabled={off}>
            {SALES_DEAL_SIZE_BANDS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="targetAccounts">{s.targetAccounts}</label>
          <textarea id="targetAccounts" name="targetAccounts" required rows={3} placeholder={"Acme FinTech | acme.example | Financial Services"} disabled={off} />
        </div>
        <div>
          <label htmlFor="buyerPersonas">{s.buyerPersonas}</label>
          <textarea id="buyerPersonas" name="buyerPersonas" required rows={3} placeholder={"VP Operations\nHead of Security & Risk"} disabled={off} />
        </div>
      </div>
      <label htmlFor="knownObjections">{s.knownObjections}</label>
      <textarea id="knownObjections" name="knownObjections" rows={2} placeholder="Data residency & procurement review lead time" disabled={off} />
    </>
  );
}

function OperationsPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const domains = optionList(meta, 'allowedProcessDomains', OPERATIONS_PROCESS_DOMAINS);
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="processName">{s.processName}</label>
          <input id="processName" name="processName" required minLength={3} maxLength={160} placeholder="Enterprise Customer Security & Billing Onboarding" disabled={off} />
        </div>
        <div>
          <label htmlFor="processDomain">{s.processDomain}</label>
          <select id="processDomain" name="processDomain" defaultValue={domains[0]} disabled={off}>
            {domains.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="targetSlaHours">{s.targetSlaHours}</label>
          <input id="targetSlaHours" name="targetSlaHours" type="number" step="0.5" min={0.5} max={8760} defaultValue={48} required disabled={off} />
        </div>
      </div>
      <label htmlFor="workflowStages">{s.workflowStages}</label>
      <textarea
        id="workflowStages"
        name="workflowStages"
        required
        rows={4}
        placeholder={"Contract Intake | Deal Desk | 8 | 10 | manual\nSecurity Questionnaire | Security Lead | 36 | 20 | manual\nWorkspace Provisioning | Ops Engineer | 12 | 5 | auto"}
        disabled={off}
      />
      <label htmlFor="complianceOrControlRequirements">{s.complianceRequirements}</label>
      <textarea id="complianceOrControlRequirements" name="complianceOrControlRequirements" rows={2} placeholder="Dual sign-off required before production tenant activation" disabled={off} />
      <label className="checkbox"><input type="checkbox" name="includeExternalBenchmarks" defaultChecked disabled={off} /><span>{s.includeExternalBenchmarks}</span></label>
    </>
  );
}

function FinancialAnalysisPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const currencies = optionList(meta, 'allowedCurrencies', ['EUR', 'USD', 'GBP', 'MAD']);
  const countries = optionList(meta, 'allowedCountries', ['MA', 'FR', 'DE', 'GB', 'US']);
  const indicators = optionList(meta, 'allowedMacroIndicators', ['FP.CPI.TOTL.ZG', 'NY.GDP.MKTP.KD.ZG']);
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="reportingCurrency">{s.reportingCurrency}</label>
          <select id="reportingCurrency" name="reportingCurrency" defaultValue={currencies[0]} disabled={off}>
            {currencies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="benchmarkCountry">{s.benchmarkCountry}</label>
          <select id="benchmarkCountry" name="benchmarkCountry" defaultValue={countries[0]} disabled={off}>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="macroIndicator">{s.macroIndicator}</label>
          <select id="macroIndicator" name="macroIndicator" defaultValue={indicators[0]} disabled={off}>
            {indicators.map(ind => <option key={ind} value={ind}>{ind}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="horizonMonths">{s.horizonMonths}</label>
          <input id="horizonMonths" name="horizonMonths" type="number" min={3} max={36} defaultValue={12} required disabled={off} />
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="monthlyRevenueMinor">{s.monthlyRevenueMinor}</label>
          <input id="monthlyRevenueMinor" name="monthlyRevenueMinor" type="number" min={0} defaultValue={8500000} required disabled={off} />
        </div>
        <div>
          <label htmlFor="grossMarginBasisPoints">{s.grossMarginBasisPoints}</label>
          <input id="grossMarginBasisPoints" name="grossMarginBasisPoints" type="number" min={0} max={10000} defaultValue={7500} required disabled={off} />
        </div>
        <div>
          <label htmlFor="monthlyFixedOpexMinor">{s.monthlyFixedOpexMinor}</label>
          <input id="monthlyFixedOpexMinor" name="monthlyFixedOpexMinor" type="number" min={0} defaultValue={9200000} required disabled={off} />
        </div>
        <div>
          <label htmlFor="cashReserveMinor">{s.cashReserveMinor}</label>
          <input id="cashReserveMinor" name="cashReserveMinor" type="number" min={0} defaultValue={54000000} required disabled={off} />
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="customerAcquisitionCostMinor">{s.cacMinor}</label>
          <input id="customerAcquisitionCostMinor" name="customerAcquisitionCostMinor" type="number" min={0} placeholder="450000" disabled={off} />
        </div>
        <div>
          <label htmlFor="averageRevenuePerAccountMinor">{s.arpaMinor}</label>
          <input id="averageRevenuePerAccountMinor" name="averageRevenuePerAccountMinor" type="number" min={0} placeholder="85000" disabled={off} />
        </div>
      </div>
      <label htmlFor="scenarios">{s.scenarios}</label>
      <textarea
        id="scenarios"
        name="scenarios"
        required
        rows={3}
        placeholder={"Downside -20% Rev | -2000 | 500 | -300\nEfficiency Plan | 0 | -1500 | 200"}
        disabled={off}
      />
    </>
  );
}

function ContentPackFields({ s, meta, off }: { s: ServiceCopy; meta?: ServiceContractMeta | undefined; off: boolean }) {
  const formats = optionList(meta, 'allowedFormats', CONTENT_FORMATS);
  const locales = optionList(meta, 'allowedLocales', CONTENT_LANGUAGES);
  return (
    <>
      <div className="qx-service-row">
        <div>
          <label htmlFor="topic">{s.topic}</label>
          <input id="topic" name="topic" required minLength={5} maxLength={200} placeholder="Auditable AI Governance & Human-in-the-Loop Verification" disabled={off} />
        </div>
        <div>
          <label htmlFor="contentFormat">{s.contentFormat}</label>
          <select id="contentFormat" name="contentFormat" defaultValue={formats[0]} disabled={off}>
            {formats.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="contentLanguage">{s.contentLanguage}</label>
          <select id="contentLanguage" name="contentLanguage" defaultValue={locales[0]} disabled={off}>
            {locales.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="toneProfile">{s.toneProfile}</label>
          <select id="toneProfile" name="toneProfile" defaultValue="ANALYTICAL" disabled={off}>
            {CONTENT_TONE_PROFILES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
          </select>
        </div>
      </div>
      <div className="qx-service-row">
        <div>
          <label htmlFor="targetAudience">{s.targetAudience}</label>
          <input id="targetAudience" name="targetAudience" required minLength={5} maxLength={300} placeholder="Chief Risk Officers, Engineering Directors & Operations Leads" disabled={off} />
        </div>
        <div>
          <label htmlFor="targetWordCount">{s.targetWordCount}</label>
          <input id="targetWordCount" name="targetWordCount" type="number" min={400} max={4000} defaultValue={1400} required disabled={off} />
        </div>
      </div>
      <label htmlFor="referenceQueries">{s.referenceQueries}</label>
      <textarea id="referenceQueries" name="referenceQueries" required rows={3} placeholder={"NIST AI risk management framework verification\nhuman in the loop audit trail enterprise"} disabled={off} />
      <label htmlFor="editorialExclusions">{s.editorialExclusions}</label>
      <textarea id="editorialExclusions" name="editorialExclusions" rows={2} placeholder="No hype superlatives; no unattributed market-size percentages" disabled={off} />
      <label className="checkbox"><input type="checkbox" name="includeFullDraft" defaultChecked disabled={off} /><span>{s.includeFullDraft}</span></label>
    </>
  );
}

/**
 * Typed service request form dispatching across all eight A16 business capability packs and the
 * A03 World Bank contract. Server action and API re-validate allowlists, bounds and schemas.
 */
export function ServiceRequestForm({
  lang,
  offerId,
  contractKey = SERVICE_CONTRACT_WORLD_BANK,
  contractMeta,
  disabled,
}: {
  lang: Locale;
  offerId: string;
  contractKey?: string | null;
  contractMeta?: ServiceContractMeta | undefined;
  disabled?: boolean;
}) {
  const s = serviceCopy(lang);
  const [state, action, pending] = useActionState(requestService, initialState);
  const activeKey = contractKey ?? SERVICE_CONTRACT_WORLD_BANK;
  const off = Boolean(disabled) || pending;
  const invalid = !disabled && state.code !== '';
  const message = invalid
    ? state.code === 'NOT_CONFIGURED'
      ? s.notConfigured
      : state.code === 'DENIED'
        ? s.denied
        : state.code === 'NOT_FOUND'
          ? s.notFound
          : state.code === 'INVALID_INPUT'
            ? s.invalid
            : errorText(state.code, lang)
    : '';

  return (
    <form action={action} className="qx-service-form">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="service" value={activeKey} />

      <label htmlFor="objective">{s.objective}</label>
      <p id="objective-hint" className="muted">{s.objectiveHint}</p>
      <textarea
        id="objective"
        name="objective"
        required
        minLength={20}
        maxLength={5000}
        rows={3}
        placeholder="State the concrete business decision, audit scope, or target outcome (minimum 20 characters)."
        aria-describedby="objective-hint"
        disabled={off}
      />

      {activeKey === SERVICE_CONTRACT_RESEARCH_PACK ? (
        <ResearchPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_STRATEGY_PACK ? (
        <StrategyPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_MARKETING_PACK ? (
        <MarketingPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_SEO_PACK ? (
        <SeoPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_SALES_PACK ? (
        <SalesPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_OPERATIONS_PACK ? (
        <OperationsPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_FINANCIAL_PACK ? (
        <FinancialAnalysisPackFields s={s} meta={contractMeta} off={off} />
      ) : activeKey === SERVICE_CONTRACT_CONTENT_PACK ? (
        <ContentPackFields s={s} meta={contractMeta} off={off} />
      ) : (
        <WorldBankLegacyFields s={s} off={off} />
      )}

      <label htmlFor="note">{s.note}</label>
      <textarea id="note" name="note" maxLength={500} rows={2} aria-describedby="note-hint" disabled={off} />
      <p id="note-hint" className="muted">{s.constraintsNote}</p>

      <button type="submit" disabled={off}>{pending ? s.working : s.submit}</button>
      {invalid ? <Feedback error title={message} /> : null}
    </form>
  );
}
