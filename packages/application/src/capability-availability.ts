import { eq } from 'drizzle-orm';
import type { CapabilityDefinition } from '@qeynox/domain';
import { QeyNoxStore, agentProfiles, toolConfigurations, verificationPolicies } from '@qeynox/persistence';
import type { OperationalState, RuntimeReadiness } from './runtime-readiness';
import { failClosedRuntime } from './runtime-readiness';

/** Real execution availability of one configured business capability. */
export interface CapabilityAvailability {
  readonly providerReady: boolean;
  readonly missingProviders: readonly string[];
  readonly profileReady: boolean;
  /** Active verification policy exists for this capability. */
  readonly policyReady: boolean;
  readonly missingPolicies: readonly string[];
  /** Four-state operational readiness for this capability. */
  readonly operationalState: OperationalState;
  /** True only when operationalState is OPERATIONAL. */
  readonly isExecutable: boolean;
}
export interface CapabilityAvailabilityIndex {
  readonly byCapabilityId: ReadonlyMap<string, CapabilityAvailability>;
  readonly missingProfiles: readonly string[];
  readonly missingProviders: readonly string[];
  readonly missingPolicies: readonly string[];
}

/**
 * Compute operational state for a capability from its prerequisites.
 * - BLOCKED: missing provider/profile/policy or engine/orchestrator BLOCKED
 * - UNVERIFIED: all DB config present but engine not verifiedLive (config flag alone is not proof)
 * - CONFIGURED: all DB config present but runtime not yet evaluated (failClosed source)
 * - OPERATIONAL: all DB config + engine/orchestrator OPERATIONAL
 */
export function computeCapabilityOperationalState(input: {
  providerReady: boolean;
  profileReady: boolean;
  policyReady: boolean;
  runtime: RuntimeReadiness;
}): OperationalState {
  if (!input.providerReady || !input.profileReady || !input.policyReady) return 'BLOCKED';
  if (input.runtime.overallState === 'BLOCKED') return 'BLOCKED';
  if (input.runtime.overallState === 'UNVERIFIED') return 'UNVERIFIED';
  if (input.runtime.overallState === 'OPERATIONAL') return 'OPERATIONAL';
  // Runtime is CONFIGURED (DB config present, runtime not yet verified) -> capability is CONFIGURED
  return 'CONFIGURED';
}

/**
 * A capability is executable only when its reviewed tool references are backed by ACTIVE tool
 * configurations, its slot has an ACTIVE business agent profile, and it has an ACTIVE verification
 * policy. All are read from operator configuration records; this never reports an absent
 * prerequisite as available.
 *
 * MISSION A01: policy attestations are now a hard prerequisite. A capability without an ACTIVE
 * verification policy is BLOCKED, never OPERATIONAL, even if provider/profile are ready.
 * Runtime prerequisites (engine, orchestrator) are evaluated via the optional runtime source;
 * when absent, failClosedRuntime is used (BLOCKED).
 */
export async function capabilityAvailability(
  store: QeyNoxStore,
  definitions: readonly CapabilityDefinition[],
  runtimeSource?: () => RuntimeReadiness,
): Promise<CapabilityAvailabilityIndex> {
  const runtime = (runtimeSource ?? failClosedRuntime)();
  const [toolRows, profileRows, policyRows] = await Promise.all([
    store.db.select().from(toolConfigurations).where(eq(toolConfigurations.status, 'ACTIVE')),
    store.db.select().from(agentProfiles).where(eq(agentProfiles.active, true)),
    store.db.select().from(verificationPolicies).where(eq(verificationPolicies.status, 'ACTIVE')),
  ]);
  const enabledToolRefs = new Set<string>();
  for (const row of toolRows) {
    const manifest = (row.payload as { manifest?: { tools?: readonly { name: string; version: string }[] } }).manifest;
    for (const tool of manifest?.tools ?? []) enabledToolRefs.add(row.connectorId + ':' + tool.name + '@' + tool.version);
  }
  const activeProfileKeys = new Set(profileRows.map(row => row.roleKey));
  const activePolicyCapabilityIds = new Set(policyRows.map(row => row.capabilityId));

  const byCapabilityId = new Map<string, CapabilityAvailability>();
  const missingProfiles = new Set<string>();
  const missingProviders = new Set<string>();
  const missingPolicies = new Set<string>();
  for (const definition of definitions) {
    const missing = definition.allowedTools.filter(ref => !enabledToolRefs.has(ref));
    const profileKey = 'business:' + definition.slot;
    const profileReady = activeProfileKeys.has(profileKey);
    if (!profileReady) missingProfiles.add(profileKey);
    for (const ref of missing) missingProviders.add(ref);
    const policyReady = activePolicyCapabilityIds.has(definition.id);
    if (!policyReady) missingPolicies.add(definition.id);
    const providerReady = missing.length === 0;
    const operationalState = computeCapabilityOperationalState({
      providerReady,
      profileReady,
      policyReady,
      runtime,
    });
    byCapabilityId.set(definition.id, {
      providerReady,
      missingProviders: missing,
      profileReady,
      policyReady,
      missingPolicies: policyReady ? [] : [definition.id],
      operationalState,
      isExecutable: operationalState === 'OPERATIONAL',
    });
  }
  return {
    byCapabilityId,
    missingProfiles: [...missingProfiles],
    missingProviders: [...missingProviders],
    missingPolicies: [...missingPolicies],
  };
}
