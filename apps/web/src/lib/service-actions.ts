'use server';
import { redirect } from 'next/navigation';
import {
  SERVICE_CONTRACT_CONTENT_PACK,
  SERVICE_CONTRACT_FINANCIAL_PACK,
  SERVICE_CONTRACT_MARKETING_PACK,
  SERVICE_CONTRACT_OPERATIONS_PACK,
  SERVICE_CONTRACT_RESEARCH_PACK,
  SERVICE_CONTRACT_SALES_PACK,
  SERVICE_CONTRACT_SEO_PACK,
  SERVICE_CONTRACT_STRATEGY_PACK,
  SERVICE_CONTRACT_WORLD_BANK,
  serviceRequestEnvelopeSchema,
  serviceRequestResultSchema,
} from '@qeynox/contracts';
import { api, ApiError } from './api';
import { locale } from './copy';

export type ServiceRequestState = { code: string; detail?: string };

function str(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function lines(form: FormData, key: string): string[] {
  return str(form, key)
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function optionalInt(raw: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function buildInputForContract(serviceKey: string, form: FormData): unknown {
  const objective = str(form, 'objective');
  const noteRaw = str(form, 'note');
  const notePart = noteRaw ? { note: noteRaw } : {};

  switch (serviceKey) {
    case SERVICE_CONTRACT_WORLD_BANK: {
      const compareIndicators = [str(form, 'compare1'), str(form, 'compare2')].filter(Boolean);
      const minYear = optionalInt(str(form, 'minObservationYear'));
      return {
        objective,
        country: str(form, 'country'),
        indicator: str(form, 'indicator'),
        constraints: {
          mostRecent: Number(str(form, 'mostRecent') || '3'),
          ...(minYear !== undefined ? { minObservationYear: minYear } : {}),
          ...(compareIndicators.length > 0 ? { compareIndicators } : {}),
          includeInterpretation: str(form, 'includeInterpretation') === 'on',
          ...notePart,
        },
      };
    }

    case SERVICE_CONTRACT_RESEARCH_PACK: {
      const comparisonIndicators = [str(form, 'compare1'), str(form, 'compare2')].filter(Boolean);
      const benchmarkCountry = str(form, 'benchmarkCountry');
      const minYear = optionalInt(str(form, 'minObservationYear'));
      return {
        objective,
        primaryCountry: str(form, 'primaryCountry'),
        ...(benchmarkCountry ? { benchmarkCountry } : {}),
        primaryIndicator: str(form, 'primaryIndicator'),
        ...(comparisonIndicators.length > 0 ? { comparisonIndicators } : {}),
        mostRecent: Number(str(form, 'mostRecent') || '3'),
        ...(minYear !== undefined ? { minObservationYear: minYear } : {}),
        decisionHorizon: str(form, 'decisionHorizon') || 'ANNUAL',
        includeSynthesis: str(form, 'includeSynthesis') === 'on',
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_STRATEGY_PACK: {
      return {
        objective,
        companyOfferSummary: str(form, 'companyOfferSummary'),
        targetMarket: str(form, 'targetMarket'),
        competitors: lines(form, 'competitors'),
        framework: str(form, 'framework'),
        strategicHorizon: str(form, 'strategicHorizon'),
        resourceConstraints: lines(form, 'resourceConstraints'),
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_MARKETING_PACK: {
      const complianceConstraints = lines(form, 'complianceConstraints');
      const candidateChannels = form
        .getAll('candidateChannels')
        .map(v => String(v).trim())
        .filter(Boolean);
      return {
        objective,
        offerDescription: str(form, 'offerDescription'),
        idealCustomerProfile: str(form, 'idealCustomerProfile'),
        primaryFunnelStage: str(form, 'primaryFunnelStage'),
        candidateChannels,
        monthlyMediaBudgetMinor: Number(str(form, 'monthlyMediaBudgetMinor') || '0'),
        budgetCurrency: str(form, 'budgetCurrency') || 'EUR',
        campaignWindowWeeks: Number(str(form, 'campaignWindowWeeks') || '8'),
        ...(complianceConstraints.length > 0 ? { complianceConstraints } : {}),
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_SEO_PACK: {
      const callerReportedIssues = lines(form, 'callerReportedIssues');
      return {
        objective,
        domain: str(form, 'domain'),
        auditedUrls: lines(form, 'auditedUrls'),
        targetQueries: lines(form, 'targetQueries'),
        country: str(form, 'country'),
        searchLang: str(form, 'searchLang') || 'en',
        auditFocus: str(form, 'auditFocus') || 'FULL_AUDIT',
        ...(callerReportedIssues.length > 0 ? { callerReportedIssues } : {}),
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_SALES_PACK: {
      const targetAccounts = lines(form, 'targetAccounts').map(line => {
        const parts = line.split('|').map(p => p.trim());
        const accountName = parts[0] ?? '';
        const domainCandidate = parts[1] ?? '';
        const industry = parts[2] ?? parts[1] ?? '';
        const hasDomain = parts.length >= 3 && domainCandidate.includes('.');
        return {
          accountName,
          ...(hasDomain ? { accountDomain: domainCandidate } : {}),
          industry,
        };
      });
      const knownObjections = lines(form, 'knownObjections');
      return {
        objective,
        sellerSolutionSummary: str(form, 'sellerSolutionSummary'),
        targetAccounts,
        buyerPersonas: lines(form, 'buyerPersonas'),
        methodology: str(form, 'methodology'),
        dealStage: str(form, 'dealStage'),
        dealSizeBand: str(form, 'dealSizeBand'),
        ...(knownObjections.length > 0 ? { knownObjections } : {}),
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_OPERATIONS_PACK: {
      const workflowStages = lines(form, 'workflowStages').map(line => {
        const parts = line.split('|').map(p => p.trim());
        const stageName = parts[0] ?? '';
        const ownerRole = parts[1] ?? '';
        const medianCycleHours = Number(parts[2] ?? '0');
        const reworkRaw = parts[3] ?? '';
        const handoffRaw = (parts[4] ?? 'manual').toLowerCase();
        const errorOrReworkRatePercent = reworkRaw !== '' ? Number(reworkRaw) : undefined;
        return {
          stageName,
          ownerRole,
          medianCycleHours,
          ...(errorOrReworkRatePercent !== undefined ? { errorOrReworkRatePercent } : {}),
          manualHandoff: handoffRaw !== 'auto' && handoffRaw !== 'false',
        };
      });
      const complianceOrControlRequirements = lines(form, 'complianceOrControlRequirements');
      return {
        objective,
        processName: str(form, 'processName'),
        processDomain: str(form, 'processDomain'),
        workflowStages,
        targetSlaHours: Number(str(form, 'targetSlaHours') || '24'),
        ...(complianceOrControlRequirements.length > 0 ? { complianceOrControlRequirements } : {}),
        includeExternalBenchmarks: str(form, 'includeExternalBenchmarks') === 'on',
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_FINANCIAL_PACK: {
      const cac = optionalInt(str(form, 'customerAcquisitionCostMinor'));
      const arpa = optionalInt(str(form, 'averageRevenuePerAccountMinor'));
      const scenarios = lines(form, 'scenarios').map(line => {
        const parts = line.split('|').map(p => p.trim());
        return {
          name: parts[0] ?? '',
          revenueDeltaBasisPoints: Number(parts[1] ?? '0'),
          opexDeltaBasisPoints: Number(parts[2] ?? '0'),
          grossMarginDeltaBasisPoints: Number(parts[3] ?? '0'),
        };
      });
      return {
        objective,
        reportingCurrency: str(form, 'reportingCurrency') || 'EUR',
        benchmarkCountry: str(form, 'benchmarkCountry'),
        macroIndicator: str(form, 'macroIndicator'),
        baselineMetrics: {
          monthlyRevenueMinor: Number(str(form, 'monthlyRevenueMinor') || '0'),
          grossMarginBasisPoints: Number(str(form, 'grossMarginBasisPoints') || '0'),
          monthlyFixedOpexMinor: Number(str(form, 'monthlyFixedOpexMinor') || '0'),
          cashReserveMinor: Number(str(form, 'cashReserveMinor') || '0'),
          ...(cac !== undefined ? { customerAcquisitionCostMinor: cac } : {}),
          ...(arpa !== undefined ? { averageRevenuePerAccountMinor: arpa } : {}),
        },
        scenarios,
        horizonMonths: Number(str(form, 'horizonMonths') || '12'),
        ...notePart,
      };
    }

    case SERVICE_CONTRACT_CONTENT_PACK: {
      const editorialExclusions = lines(form, 'editorialExclusions');
      return {
        objective,
        topic: str(form, 'topic'),
        contentFormat: str(form, 'contentFormat'),
        targetAudience: str(form, 'targetAudience'),
        language: str(form, 'contentLanguage') || 'en',
        toneProfile: str(form, 'toneProfile') || 'ANALYTICAL',
        referenceQueries: lines(form, 'referenceQueries'),
        targetWordCount: Number(str(form, 'targetWordCount') || '1200'),
        ...(editorialExclusions.length > 0 ? { editorialExclusions } : {}),
        includeFullDraft: str(form, 'includeFullDraft') === 'on',
        ...notePart,
      };
    }

    default:
      return null;
  }
}

/**
 * Request a published service: validates the typed form against the registered contract envelope,
 * posts the envelope to the API, then lands on the mission workspace (which holds the plan, the
 * quote and the acceptance). Nothing is quoted, accepted, charged or executed here.
 */
export async function requestService(previous: ServiceRequestState, form: FormData): Promise<ServiceRequestState> {
  void previous;
  const lang = locale(String(form.get('lang')));
  const offerId = str(form, 'offerId');
  const service = str(form, 'service');
  if (!/^[A-Za-z0-9_.:-]{4,120}$/.test(offerId) || !service) {
    return { code: 'INVALID_INPUT' };
  }
  const input = buildInputForContract(service, form);
  if (!input) return { code: 'NOT_CONFIGURED' };

  const envelope = serviceRequestEnvelopeSchema.safeParse({ service, input });
  if (!envelope.success) {
    return { code: 'INVALID_INPUT' };
  }
  let operationId: string;
  try {
    const value = await api('/v1/services/' + encodeURIComponent(offerId) + '/requests', 'POST', envelope.data);
    operationId = serviceRequestResultSchema.parse(value).operationId;
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' };
  }
  redirect('/' + lang + '/missions/' + encodeURIComponent(operationId));
}
