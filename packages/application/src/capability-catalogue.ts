import { DomainError, type Principal } from '@qeynox/domain';
import { QeyNoxStore } from '@qeynox/persistence';
import { capabilityAvailability } from './capability-availability';

export const CAPABILITY_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export interface CapabilityCatalogueEntry {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly purpose: string;
  readonly scope: readonly string[];
  readonly maximumSteps: number;
  readonly maximumToolCalls: number;
  readonly externalActions: boolean;
  readonly providerReady: boolean;
  readonly missingProviders: readonly string[];
  readonly profileReady: boolean;
}
export interface CapabilitySlotView {
  readonly slot: number;
  readonly status: 'ACTIVE' | 'UNCONFIGURED';
  readonly available: boolean;
  readonly capability: CapabilityCatalogueEntry | null;
}
export interface CapabilityCatalogueView {
  readonly slots: readonly CapabilitySlotView[];
  readonly total: number;
  readonly active: number;
  readonly available: number;
}

/**
 * The eight configurable business capability slots with their real availability. Only ACTIVE slots
 * expose a capability; inactive slots never masquerade as usable services. Configuration itself is
 * operator-only and is never performed from a customer session.
 */
export class CapabilityCatalogueService {
  constructor(private readonly store: QeyNoxStore) {}

  async list(actor: Principal): Promise<CapabilityCatalogueView> {
    if (!actor.userId || !actor.workspaceId) throw new DomainError('DENIED', 'Authenticated workspace required');
    const definitions = await this.store.getCapabilities();
    const active = definitions.filter(definition => definition.status === 'ACTIVE');
    const availability = await capabilityAvailability(this.store, active);
    const slots: CapabilitySlotView[] = CAPABILITY_SLOTS.map(slot => {
      const definition = active.find(candidate => candidate.slot === slot);
      if (!definition) return { slot, status: 'UNCONFIGURED' as const, available: false, capability: null };
      const index = availability.byCapabilityId.get(definition.id);
      const providerReady = index?.providerReady ?? false;
      const profileReady = index?.profileReady ?? false;
      return {
        slot,
        status: 'ACTIVE' as const,
        available: providerReady && profileReady,
        capability: {
          id: definition.id,
          version: definition.version,
          name: definition.name ?? 'Unnamed capability',
          purpose: definition.purpose ?? '',
          scope: definition.scope,
          maximumSteps: definition.maximumSteps,
          maximumToolCalls: definition.maximumToolCalls,
          externalActions: definition.allowedTools.length > 0,
          providerReady,
          missingProviders: index?.missingProviders ?? [],
          profileReady,
        },
      };
    });
    return {
      slots,
      total: CAPABILITY_SLOTS.length,
      active: slots.filter(slot => slot.status === 'ACTIVE').length,
      available: slots.filter(slot => slot.available).length,
    };
  }
}
