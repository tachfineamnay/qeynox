import { eq } from 'drizzle-orm';
import type { CapabilityDefinition, Principal } from '@qeynox/domain';
import type {
  BusinessPackDomain,
  ServiceContractMeta,
  ServiceDeployment,
} from '@qeynox/contracts';
import { QeyNoxStore, offers } from '@qeynox/persistence';
import { assertBusinessPackProvider } from './business-packs';
import { capabilityAvailability } from './capability-availability';
import { failClosedRuntime, type OperationalState, type RuntimeReadinessSource } from './runtime-readiness';
import { resolveContract, type ServiceContractRegistry } from './service-contracts';

/**
 * MISSION A13 + A16 — customer-facing service catalogue read model.
 *
 * One source of truth for both the customer Web pages and any read-only API projection:
 *
 *   published RaaS offers (status ACTIVE only)  ──join──▶  real capability availability
 *                                                     plus  the deployment's registered
 *                                                          typed request contracts
 *
 * Everything in the view is operator-published data or measured configuration/readiness state.
 * A service can be listed while its provider is not yet executable — availability says so, with
 * named blockers — but nothing is ever shown as executable or "free" without the configuration
 * that proves it.
 */

const STATE_RANK: Record<OperationalState, number> = { BLOCKED: 0, UNVERIFIED: 1, CONFIGURED: 2, OPERATIONAL: 3 };
const RANK_STATE: OperationalState[] = ['BLOCKED', 'UNVERIFIED', 'CONFIGURED', 'OPERATIONAL'];

function worstState(states: readonly OperationalState[]): OperationalState {
  if (states.length === 0) return 'BLOCKED';
  return RANK_STATE[Math.min(...states.map(state => STATE_RANK[state]))]!;
}

export interface ConfiguredOfferPayload {
  readonly id?: unknown; readonly version?: unknown; readonly label?: unknown;
  readonly capabilityIds?: unknown; readonly deliverableSchemaVersion?: unknown;
  readonly scope?: unknown; readonly exclusions?: unknown;
  readonly regions?: unknown; readonly locales?: unknown;
  readonly termsVersion?: unknown; readonly taxPolicy?: unknown;
  readonly isExplicitlyFree?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface ServiceOfferRow {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly configuration: Record<string, unknown>;
}

export interface ServiceCapabilityView {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly scope: string[];
  readonly maximumSteps: number;
  readonly maximumToolCalls: number;
  readonly operationalState: OperationalState;
  readonly providerStatus?: 'BLOCKED' | 'CONFIGURED_NOT_LIVE_VERIFIED' | 'NOT_REQUIRED';
  readonly providerBlockers?: { tool: string; reason: string }[];
  readonly providerReady: boolean;
  readonly missingProviders: string[];
  readonly profileReady: boolean;
  readonly policyReady: boolean;
  readonly missingPolicies: string[];
  readonly isExecutable: boolean;
}

export interface ServiceSummaryView {
  readonly offerId: string;
  readonly version: number;
  readonly label: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly isExplicitlyFree: boolean;
  readonly taxPolicy: 'CONFIG_REQUIRED' | 'CONFIGURED';
  readonly scope: string[];
  readonly exclusions: string[];
  readonly regions: string[];
  readonly locales: string[];
  readonly termsVersion: string;
  readonly deliverableSchemaVersion: number;
  readonly capabilityIds: string[];
  readonly availability: { readonly operationalState: OperationalState; readonly isExecutable: boolean; readonly blockers: string[] };
  readonly requestable: boolean;
  readonly contractKey: string | null;
  readonly unavailableReason: string | null;
  readonly packDomain?: BusinessPackDomain;
  readonly displayName?: string;
  readonly specialization?: string;
}

export interface ServiceDetailView extends ServiceSummaryView {
  readonly capabilities: ServiceCapabilityView[];
  /** Deployment switches echoed as booleans (never values), plus honest blocked external connectors. */
  readonly deployment: ServiceDeployment | null;
  /** Operator-editable specialization, allowlists, bounds and deliverable sections for A16 packs. */
  readonly contractMeta?: ServiceContractMeta;
}

/** Optional deployment probe for contract-specific honesty notes (booleans only). */
export type DeploymentProbe = (contractKey: string, offerId?: string) => ServiceDeployment | null;

export class ServiceCatalogueService {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly runtime: RuntimeReadinessSource = failClosedRuntime,
    private readonly contracts: ServiceContractRegistry | null = null,
    private readonly deploymentProbe: DeploymentProbe | null = null,
  ) {}

  /** Customer-facing catalogue: ACTIVE offers only, cheapest check first. */
  async list(_actor: Principal): Promise<ServiceSummaryView[]> {
    const rows = (await this.store.db.select().from(offers).where(eq(offers.status, 'ACTIVE'))) as ServiceOfferRow[];
    return this.views(rows);
  }

  /** One ACTIVE offer, or null (controller maps to 404 — a draft or disabled offer never resolves). */
  async detail(_actor: Principal, offerId: string): Promise<ServiceDetailView | null> {
    const rows = (await this.store.db.select().from(offers).where(eq(offers.status, 'ACTIVE'))) as ServiceOfferRow[];
    const row = rows.find(candidate => candidate.id === offerId);
    if (!row) return null;
    const [view] = await this.views([row]);
    if (!view) return null;
    const capabilities = await this.capabilityViews(view.capabilityIds);
    const { contract } = resolveContract(this.contracts, row.id, view.capabilityIds);
    const deployment = view.contractKey && this.deploymentProbe ? this.deploymentProbe(view.contractKey, row.id) : null;
    return {
      ...view,
      capabilities,
      deployment: deployment ? { ...deployment, providerStatus: capabilities.length > 0 && capabilities.every(capability => capability.providerReady) ? 'CONFIGURED_NOT_LIVE_VERIFIED' : 'BLOCKED' } : null,
      ...(contract?.contractMeta ? { contractMeta: contract.contractMeta } : {}),
    };
  }

  private async views(rows: readonly ServiceOfferRow[]): Promise<ServiceSummaryView[]> {
    if (rows.length === 0) return [];
    const definitions = await this.store.getCapabilities();
    const byId = new Map<string, CapabilityDefinition>(definitions.map(definition => [definition.id as string, definition]));
    const referenced = new Set<string>();
    for (const row of rows) for (const id of this.capabilityIds(row.configuration)) referenced.add(id);
    const activeDefinitions = [...referenced]
      .map(id => byId.get(id))
      .filter((definition): definition is CapabilityDefinition => definition !== undefined && definition.status === 'ACTIVE');
    const availability = await capabilityAvailability(this.store, activeDefinitions, this.runtime);

    const views: ServiceSummaryView[] = [];
    for (const row of rows) {
      const capabilityIds = this.capabilityIds(row.configuration);
      const blockers = new Set<string>();
      const states: OperationalState[] = [];
      let capabilityActive = true;
      for (const capabilityId of capabilityIds) {
        const definition = byId.get(capabilityId);
        if (!definition || definition.status !== 'ACTIVE') {
          blockers.add('CAPABILITY_NOT_CONFIGURED');
          states.push('BLOCKED');
          capabilityActive = false;
          continue;
        }
        const entry = availability.byCapabilityId.get(capabilityId);
        if (!entry) {
          blockers.add('PROVIDER_NOT_CONFIGURED');
          states.push('BLOCKED');
          continue;
        }
        states.push(entry.operationalState);
        if (!entry.providerReady) {
          blockers.add('PROVIDER_NOT_CONFIGURED');
          for (const provider of entry.missingProviders) blockers.add('PROVIDER:' + provider);
        }
        if (!entry.profileReady) blockers.add('PROFILE_NOT_CONFIGURED');
        if (!entry.policyReady) blockers.add('POLICY_NOT_CONFIGURED');
        if (this.runtime().overallState !== 'OPERATIONAL') blockers.add('RUNTIME_NOT_OPERATIONAL');
      }
      if (capabilityIds.length === 0) {
        blockers.add('CAPABILITY_NOT_CONFIGURED');
        states.push('BLOCKED');
        capabilityActive = false;
      }
      const { contract } = resolveContract(this.contracts, row.id, capabilityIds);
      const contractKey = contract?.key ?? null;
      const payload = row.configuration as ConfiguredOfferPayload;
      const isExplicitlyFree = payload.isExplicitlyFree === true;
      const taxPolicy = payload.taxPolicy === 'CONFIGURED' ? 'CONFIGURED' as const : 'CONFIG_REQUIRED' as const;
      if (!isExplicitlyFree) {
        // Stripe/payment processing is not implemented in this repo; surface truthful blocker on paid offers.
        if (row.amountMinor === 0) {
          blockers.add('OFFER_FREE_UNAUTHORIZED');
          states.push('BLOCKED');
        }
      }
      if (contract?.packDomain) {
        try {
          for (const id of capabilityIds) {
            const definition = byId.get(id);
            if (!definition) throw new Error('Missing capability');
            assertBusinessPackProvider(contract.packDomain, definition);
          }
        } catch { blockers.add('PACK_PROVIDER_MISMATCH'); states.push('BLOCKED'); }
      }
      const operationalState = worstState(states);
      views.push({
        offerId: row.id,
        version: row.version,
        label: typeof payload.label === 'string' && payload.label.trim() ? payload.label : row.id,
        amountMinor: row.amountMinor,
        currency: row.currency,
        isExplicitlyFree,
        taxPolicy,
        scope: stringArray(payload.scope),
        exclusions: stringArray(payload.exclusions),
        regions: stringArray(payload.regions),
        locales: stringArray(payload.locales),
        termsVersion: typeof payload.termsVersion === 'string' ? payload.termsVersion : '',
        deliverableSchemaVersion: typeof payload.deliverableSchemaVersion === 'number' ? payload.deliverableSchemaVersion : 1,
        capabilityIds,
        availability: { operationalState, isExecutable: operationalState === 'OPERATIONAL', blockers: [...blockers].sort() },
        requestable: contract !== null && capabilityActive,
        contractKey,
        unavailableReason: contract === null ? 'SERVICE_NOT_CONFIGURED' : !capabilityActive ? 'CAPABILITY_NOT_CONFIGURED' : null,
        ...(contract?.packDomain ? { packDomain: contract.packDomain } : {}),
        ...(contract?.displayName ? { displayName: contract.displayName } : {}),
        ...(contract?.specialization ? { specialization: contract.specialization } : {}),
      });
    }
    return views.sort((a, b) => a.offerId.localeCompare(b.offerId));
  }

  private async capabilityViews(capabilityIds: readonly string[]): Promise<ServiceCapabilityView[]> {
    const definitions = await this.store.getCapabilities();
    const needed = new Set(capabilityIds);
    const selected = definitions.filter(definition => needed.has(definition.id as string));
    const availability = await capabilityAvailability(this.store, selected.filter(d => d.status === 'ACTIVE'), this.runtime);
    const views: ServiceCapabilityView[] = [];
    for (const definition of selected) {
      const entry = availability.byCapabilityId.get(definition.id);
      views.push({
        id: definition.id,
        name: definition.name ?? 'Unnamed capability',
        purpose: definition.purpose ?? '',
        scope: [...definition.scope],
        maximumSteps: definition.maximumSteps,
        maximumToolCalls: definition.maximumToolCalls,
        operationalState: entry?.operationalState ?? 'BLOCKED',
        providerReady: entry?.providerReady ?? false,
        providerStatus: entry?.providerStatus ?? 'BLOCKED',
        providerBlockers: [...(entry?.providerBlockers ?? [])],
        missingProviders: entry ? [...entry.missingProviders] : [],
        profileReady: entry?.profileReady ?? false,
        policyReady: entry?.policyReady ?? false,
        missingPolicies: entry ? [...entry.missingPolicies] : [],
        isExecutable: entry?.isExecutable ?? false,
      });
    }
    return views;
  }

  private capabilityIds(configuration: Record<string, unknown>): string[] {
    return stringArray((configuration as ConfiguredOfferPayload).capabilityIds);
  }
}
