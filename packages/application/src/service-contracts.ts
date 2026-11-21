import { z } from 'zod';
import {
  SERVICE_CONTRACT_WORLD_BANK,
  contentPackRequestSchema,
  financialAnalysisPackRequestSchema,
  marketingPackRequestSchema,
  operationsPackRequestSchema,
  researchPackRequestSchema,
  salesPackRequestSchema,
  seoPackRequestSchema,
  strategyPackRequestSchema,
  worldBankResearchRequestSchema,
  type BusinessPackDomain,
  type PackServiceConfig,
  type ServiceContractMeta,
  type ServicePreviewResult,
  type UnavailableExternalConnector,
  type WorldBankResearchRequestInput,
} from '@qeynox/contracts';
import type { QeyNoxStore } from '@qeynox/persistence';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { EconomicResearchService } from './economic-research';
import type { PlanningService } from './planning';
import type { RuntimeReadinessSource } from './runtime-readiness';
import { failClosedRuntime } from './runtime-readiness';
import {
  BusinessPackService,
  REQUIRED_PROVIDER_BY_PACK,
  UNAVAILABLE_CONNECTORS_BY_PACK,
  parsePackServiceConfig,
} from './business-packs';

/**
 * MISSION A13 + A16 — typed request contracts for customer-orderable services.
 *
 * A contract is the code side of one published service: which offer it serves, which typed input
 * the customer must supply, and how that input becomes an operation with a bounded plan. Contracts
 * are registered explicitly per deployment from reviewed operator configuration; there is no
 * inference, no "generic order form" and no generated content.
 */

export interface ServiceContractCreateResult {
  readonly operationId: ID;
  readonly revisionId: ID;
  /** Deterministic digest of the normalized request — what the customer approves. */
  readonly fingerprint: string;
  /** Named caveats to show before approval; never empty-by-accident, often empty by design. */
  readonly warnings: readonly string[];
  readonly stepCount: number;
}

export interface ServiceRequestContract {
  /** Stable, versioned contract identity; must match the envelope discriminator. */
  readonly key: string;
  /** The operator-published offer this contract serves. */
  readonly offerId: string;
  /** Capabilities this contract plans with; must equal the offer's capabilityIds. */
  readonly capabilityIds: readonly string[];
  /** The typed input object (without the envelope). */
  readonly requestSchema: z.ZodType<unknown>;
  readonly packDomain?: BusinessPackDomain;
  readonly displayName?: string;
  readonly specialization?: string;
  readonly contractMeta?: ServiceContractMeta;
  readonly requiredProvider?: 'world-bank' | 'brave-search';
  readonly unavailableExternalConnectors?: readonly UnavailableExternalConnector[];
  preview?(input: unknown): Promise<ServicePreviewResult>;
  create(actor: Principal, input: unknown): Promise<ServiceContractCreateResult>;
}

/** Fail-closed registry: an offer with no registered contract is listed but never orderable. */
export class ServiceContractRegistry {
  constructor(private readonly contracts: readonly ServiceRequestContract[] = []) {
    const seen = new Set<string>();
    for (const contract of contracts) {
      if (seen.has(contract.offerId)) {
        throw new DomainError('CONFLICT', 'Duplicate service contract for offer: ' + contract.offerId);
      }
      seen.add(contract.offerId);
    }
  }
  forOffer(offerId: string): ServiceRequestContract | null {
    return this.contracts.find(contract => contract.offerId === offerId) ?? null;
  }
  forKey(contractKey: string): ServiceRequestContract | null {
    return this.contracts.find(contract => contract.key === contractKey) ?? null;
  }
  registeredOfferIds(): readonly string[] {
    return this.contracts.map(contract => contract.offerId);
  }
  list(): readonly ServiceRequestContract[] {
    return [...this.contracts];
  }
}

// ---------------------------------------------------------------------------------------------
// World Bank economic-indicator research (A03)
// ---------------------------------------------------------------------------------------------

export interface WorldBankServiceConfig {
  readonly capabilityId: string;
  readonly offerId: string;
  readonly allowedCountries?: readonly string[];
  readonly allowedIndicators?: readonly string[];
  readonly maximumObservations?: number;
}

export const worldBankServiceConfigSchema = z.object({
  capabilityId: z.string().min(4).max(120),
  offerId: z.string().min(4).max(120),
  budgetPolicyId: z.string().min(4).max(120),
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2,3}$/)).min(1).max(64).optional(),
  allowedIndicators: z.array(z.string().regex(/^[A-Z0-9]+(?:\.[A-Z0-9]+)+$/)).min(1).max(64).optional(),
  maximumObservations: z.number().int().min(1).max(5).optional(),
});
export type ParsedWorldBankServiceConfig = z.infer<typeof worldBankServiceConfigSchema>;

/**
 * Parse the `service` section of an operator service configuration file. Strict: unknown or
 * malformed sections fail closed; the deployment then serves the catalogue without the A03 form.
 */
export function parseWorldBankServiceConfig(raw: unknown): ParsedWorldBankServiceConfig {
  return worldBankServiceConfigSchema.parse(raw);
}

export class WorldBankResearchContract implements ServiceRequestContract {
  readonly key = SERVICE_CONTRACT_WORLD_BANK;
  readonly requestSchema = worldBankResearchRequestSchema;
  readonly requiredProvider = 'world-bank' as const;
  readonly unavailableExternalConnectors: readonly UnavailableExternalConnector[] = [];

  constructor(
    private readonly store: QeyNoxStore,
    private readonly planning: PlanningService,
    private readonly config: ParsedWorldBankServiceConfig,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
  ) {}

  get offerId(): string { return this.config.offerId; }
  get capabilityIds(): readonly string[] { return [this.config.capabilityId]; }

  private serviceInstance(): EconomicResearchService {
    return new EconomicResearchService(
      this.store,
      {
        capabilityId: this.config.capabilityId as ID,
        offerId: this.config.offerId,
        ...(this.config.allowedCountries ? { allowedCountries: this.config.allowedCountries } : {}),
        ...(this.config.allowedIndicators ? { allowedIndicators: this.config.allowedIndicators } : {}),
        ...(this.config.maximumObservations ? { maximumObservations: this.config.maximumObservations } : {}),
      },
      this.runtime,
    );
  }

  private toResearchInput(input: unknown) {
    const request = this.requestSchema.parse(input) as WorldBankResearchRequestInput;
    const constraints = request.constraints;
    return {
      objective: request.objective,
      country: request.country,
      indicator: request.indicator,
      ...(constraints
        ? {
            constraints: {
              ...(constraints.mostRecent !== undefined ? { mostRecent: constraints.mostRecent } : {}),
              ...(constraints.minObservationYear !== undefined ? { minObservationYear: constraints.minObservationYear } : {}),
              ...(constraints.compareIndicators !== undefined ? { compareIndicators: constraints.compareIndicators } : {}),
              ...(constraints.includeInterpretation !== undefined ? { includeInterpretation: constraints.includeInterpretation } : {}),
              ...(constraints.note !== undefined ? { note: constraints.note } : {}),
            },
          }
        : {}),
    };
  }

  async preview(input: unknown): Promise<ServicePreviewResult> {
    const proposal = await this.serviceInstance().propose(this.toResearchInput(input));
    return {
      contractKey: this.key,
      packDomain: null,
      fingerprint: proposal.request.fingerprint,
      requiresUserApproval: proposal.requiresUserApproval,
      warnings: [...proposal.warnings],
      steps: proposal.steps.map((step, index) => ({
        index,
        title: step.title,
        description: step.description,
        capabilityId: step.capabilityId,
        intent: step.intent,
        dependsOnIndices: [...(step.dependsOnIndices ?? [])],
      })),
    };
  }

  async create(actor: Principal, input: unknown): Promise<ServiceContractCreateResult> {
    const created = await this.serviceInstance().createPlan(actor, this.toResearchInput(input), this.planning);
    return {
      operationId: created.operationId,
      revisionId: created.revisionId,
      fingerprint: created.request.fingerprint,
      warnings: created.warnings,
      stepCount: created.steps.length,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Eight Business Capability Packs (A16)
// ---------------------------------------------------------------------------------------------

const PACK_REQUEST_SCHEMAS: Readonly<Record<BusinessPackDomain, z.ZodType<unknown>>> = {
  research: researchPackRequestSchema,
  strategy: strategyPackRequestSchema,
  marketing: marketingPackRequestSchema,
  seo: seoPackRequestSchema,
  sales: salesPackRequestSchema,
  operations: operationsPackRequestSchema,
  'financial-analysis': financialAnalysisPackRequestSchema,
  content: contentPackRequestSchema,
};

export class BusinessPackContract implements ServiceRequestContract {
  readonly key: string;
  readonly offerId: string;
  readonly capabilityIds: readonly string[];
  readonly requestSchema: z.ZodType<unknown>;
  readonly packDomain: BusinessPackDomain;
  readonly displayName: string;
  readonly specialization: string;
  readonly contractMeta: ServiceContractMeta;
  readonly requiredProvider: 'world-bank' | 'brave-search';
  readonly unavailableExternalConnectors: readonly UnavailableExternalConnector[];
  private readonly service: BusinessPackService;

  constructor(
    store: QeyNoxStore,
    private readonly planning: PlanningService,
    config: PackServiceConfig,
    runtime: RuntimeReadinessSource = failClosedRuntime,
  ) {
    this.service = new BusinessPackService(store, config, runtime);
    this.key = this.service.contractKey;
    this.offerId = config.offerId;
    this.capabilityIds = [config.capabilityId];
    this.requestSchema = PACK_REQUEST_SCHEMAS[config.pack];
    this.packDomain = config.pack;
    this.displayName = config.displayName;
    this.specialization = config.specialization;
    this.contractMeta = this.service.contractMeta();
    this.requiredProvider = REQUIRED_PROVIDER_BY_PACK[config.pack];
    this.unavailableExternalConnectors = UNAVAILABLE_CONNECTORS_BY_PACK[config.pack];
  }

  async preview(input: unknown): Promise<ServicePreviewResult> {
    const proposal = await this.service.propose(input);
    return {
      contractKey: this.key,
      packDomain: this.packDomain,
      fingerprint: proposal.fingerprint,
      requiresUserApproval: proposal.requiresUserApproval,
      warnings: [...proposal.warnings],
      steps: proposal.steps.map((step, index) => ({
        index,
        title: step.title,
        description: step.description,
        capabilityId: step.capabilityId,
        intent: step.intent,
        dependsOnIndices: [...(step.dependsOnIndices ?? [])],
      })),
      ...(proposal.computedMetrics ? { computedMetrics: proposal.computedMetrics } : {}),
    };
  }

  async create(actor: Principal, input: unknown): Promise<ServiceContractCreateResult> {
    const created = await this.service.createPlan(actor, input, this.planning);
    return {
      operationId: created.operationId,
      revisionId: created.revisionId,
      fingerprint: created.proposal.fingerprint,
      warnings: created.proposal.warnings,
      stepCount: created.proposal.steps.length,
    };
  }
}

function buildOneContract(
  store: QeyNoxStore,
  planning: PlanningService,
  rawService: unknown,
  runtime: RuntimeReadinessSource,
): ServiceRequestContract {
  if (typeof rawService === 'object' && rawService !== null && 'pack' in rawService) {
    return new BusinessPackContract(store, planning, parsePackServiceConfig(rawService), runtime);
  }
  return new WorldBankResearchContract(store, planning, parseWorldBankServiceConfig(rawService), runtime);
}

/**
 * Parses an operator service bundle JSON object containing either:
 *   - `{ service: ... }` (legacy A03 World Bank service OR a single A16 business pack), or
 *   - `{ services: [ ... ] }` (multi-pack operator suite such as a16-business-packs.json).
 */
export function createContractsFromCatalogJson(
  store: QeyNoxStore,
  planning: PlanningService,
  parsedJson: unknown,
  runtime: RuntimeReadinessSource = failClosedRuntime,
): readonly ServiceRequestContract[] {
  if (typeof parsedJson !== 'object' || parsedJson === null) {
    throw new DomainError('NOT_CONFIGURED', 'Service catalog file must contain a JSON object');
  }
  const record = parsedJson as { service?: unknown; services?: unknown };
  if (Array.isArray(record.services)) {
    if (record.services.length === 0) {
      throw new DomainError('NOT_CONFIGURED', 'Service catalog "services" array must not be empty');
    }
    return record.services.map(item => buildOneContract(store, planning, item, runtime));
  }
  if (record.service !== undefined) {
    return [buildOneContract(store, planning, record.service, runtime)];
  }
  throw new DomainError('NOT_CONFIGURED', 'Service catalog file missing "service" or "services" section');
}

/** Resolve the registered contract for an offer, enforcing capability-consistency. */
export function resolveContract(
  registry: ServiceContractRegistry | null,
  offerId: string,
  capabilityIds: readonly string[],
): {
  contract: ServiceRequestContract | null;
  reason: 'OK' | 'SERVICE_NOT_CONFIGURED' | 'CAPABILITY_NOT_CONFIGURED';
} {
  const contract = registry?.forOffer(offerId) ?? null;
  if (!contract) return { contract: null, reason: 'SERVICE_NOT_CONFIGURED' };
  const contractCaps = new Set(contract.capabilityIds);
  if (contractCaps.size !== new Set(capabilityIds).size || capabilityIds.some(id => !contractCaps.has(id))) {
    // The offer and the registered contract disagree — refuse rather than plan under the wrong offer.
    return { contract: null, reason: 'SERVICE_NOT_CONFIGURED' };
  }
  return { contract, reason: 'OK' };
}
