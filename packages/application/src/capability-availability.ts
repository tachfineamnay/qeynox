import { eq } from 'drizzle-orm';
import type { CapabilityDefinition } from '@qeynox/domain';
import { QeyNoxStore, agentProfiles, toolConfigurations } from '@qeynox/persistence';

/** Real execution availability of one configured business capability. */
export interface CapabilityAvailability {
  readonly providerReady: boolean;
  readonly missingProviders: readonly string[];
  readonly profileReady: boolean;
}
export interface CapabilityAvailabilityIndex {
  readonly byCapabilityId: ReadonlyMap<string, CapabilityAvailability>;
  readonly missingProfiles: readonly string[];
  readonly missingProviders: readonly string[];
}

/**
 * A capability is executable only when its reviewed tool references are backed by ACTIVE tool
 * configurations and its slot has an ACTIVE business agent profile. Both are read from operator
 * configuration records; this never reports an absent prerequisite as available.
 */
export async function capabilityAvailability(
  store: QeyNoxStore,
  definitions: readonly CapabilityDefinition[],
): Promise<CapabilityAvailabilityIndex> {
  const [toolRows, profileRows] = await Promise.all([
    store.db.select().from(toolConfigurations).where(eq(toolConfigurations.status, 'ACTIVE')),
    store.db.select().from(agentProfiles).where(eq(agentProfiles.active, true)),
  ]);
  const enabledToolRefs = new Set<string>();
  for (const row of toolRows) {
    const manifest = (row.payload as { manifest?: { tools?: readonly { name: string; version: string }[] } }).manifest;
    for (const tool of manifest?.tools ?? []) enabledToolRefs.add(row.connectorId + ':' + tool.name + '@' + tool.version);
  }
  const activeProfileKeys = new Set(profileRows.map(row => row.roleKey));

  const byCapabilityId = new Map<string, CapabilityAvailability>();
  const missingProfiles = new Set<string>();
  const missingProviders = new Set<string>();
  for (const definition of definitions) {
    const missing = definition.allowedTools.filter(ref => !enabledToolRefs.has(ref));
    const profileKey = 'business:' + definition.slot;
    const profileReady = activeProfileKeys.has(profileKey);
    if (!profileReady) missingProfiles.add(profileKey);
    for (const ref of missing) missingProviders.add(ref);
    byCapabilityId.set(definition.id, { providerReady: missing.length === 0, missingProviders: missing, profileReady });
  }
  return { byCapabilityId, missingProfiles: [...missingProfiles], missingProviders: [...missingProviders] };
}
