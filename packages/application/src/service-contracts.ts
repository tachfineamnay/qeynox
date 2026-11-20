import { z } from 'zod';
import {
  SERVICE_CONTRACT_WORLD_BANK,
  worldBankResearchRequestSchema,
  type WorldBankResearchRequestInput,
} from '@qeynox/contracts';
import type { QeyNoxStore } from '@qeynox/persistence';
import type { ID, Principal } from '@qeynox/domain';
import { EconomicResearchService } from './economic-research';
import type { PlanningService } from './planning';
import type { RuntimeReadinessSource } from './runtime-readiness';
import { failClosedRuntime } from './runtime-readiness';

/**
 * MISSION A13 — typed request contracts for customer-orderable services.
 *
 * A contract is the code side of one published service: which offer it serves, which typed input
 * the customer must supply, and how that input becomes an operation with a bounded plan. Contracts
 * are registered explicitly per deployment from reviewed operator configuration; there is no
 * inference, no "generic order form" and no generated content.
 *
 * To add a service for a new capability:
 *   1. declare its request object in @qeynox/contracts (next to the World Bank one);
 *   2. add it to the serviceRequestEnvelopeSchema union;
 *   3. implement ServiceRequestContract (normalize → bounded plan → persist via PlanningService);
 *   4. register it in the deployment's ServiceContractRegistry (env-configured, fail-closed).
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
  create(actor: Principal, input: unknown): Promise<ServiceContractCreateResult>;
}

/** Fail-closed registry: an offer with no registered contract is listed but never orderable. */
export class ServiceContractRegistry {
  constructor(private readonly contracts: readonly ServiceRequestContract[] = []) {}
  forOffer(offerId: string): ServiceRequestContract | null {
    return this.contracts.find(contract => contract.offerId === offerId) ?? null;
  }
  registeredOfferIds(): readonly string[] { return this.contracts.map(contract => contract.offerId); }
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

  constructor(
    private readonly store: QeyNoxStore,
    private readonly planning: PlanningService,
    private readonly config: ParsedWorldBankServiceConfig,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
  ) {}

  get offerId(): string { return this.config.offerId; }
  get capabilityIds(): readonly string[] { return [this.config.capabilityId]; }

  async create(actor: Principal, input: unknown): Promise<ServiceContractCreateResult> {
    const request = this.requestSchema.parse(input) as WorldBankResearchRequestInput;
    const service = new EconomicResearchService(this.store, {
      capabilityId: this.config.capabilityId as ID,
      offerId: this.config.offerId,
      ...(this.config.allowedCountries ? { allowedCountries: this.config.allowedCountries } : {}),
      ...(this.config.allowedIndicators ? { allowedIndicators: this.config.allowedIndicators } : {}),
      ...(this.config.maximumObservations ? { maximumObservations: this.config.maximumObservations } : {}),
    }, this.runtime);
    const created = await service.createPlan(actor, request, this.planning);
    return {
      operationId: created.operationId,
      revisionId: created.revisionId,
      fingerprint: created.request.fingerprint,
      warnings: created.warnings,
      stepCount: created.steps.length,
    };
  }
}

/** Resolve the registered contract for an offer, enforcing capability-consistency. */
export function resolveContract(registry: ServiceContractRegistry | null, offerId: string, capabilityIds: readonly string[]): {
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
