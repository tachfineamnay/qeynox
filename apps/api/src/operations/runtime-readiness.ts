import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { RuntimeReadiness } from '@qeynox/application';
import { createRuntimeProbeMonitor, type RuntimeProbeMonitor, type RuntimeProbeMonitorOptions, type RuntimeProbePolicy } from '@qeynox/application';

/**
 * Reads the deployment prerequisites required to execute a mission step.
 *
 * - Hermes is the replaceable intelligence runtime; it fails closed without its endpoint, API key,
 *   native-tool isolation and tested egress containment.
 * - Hatchet is the single durable workflow executor; the outbox dispatcher cannot run without a
 *   client token.
 *
 * MISSION A21.07: configuration and operator attestations are preconditions only. A component is
 * verified exclusively by fresh evidence from a bounded live probe run by THIS process
 * (`RuntimeProbeMonitor`): Hermes and Hatchet are probed and judged separately, evidence expires, and
 * a configuration change invalidates it. `QEYNOX_RUNTIME_VERIFIED_LIVE` and
 * `QEYNOX_RUNTIME_VERIFICATION_EVIDENCE` are no longer read, and no default evidence exists.
 */
let monitor: RuntimeProbeMonitor | null = null;

/** The API process's monitor (created on first use from the process environment). */
export function apiRuntimeMonitor(): RuntimeProbeMonitor {
  monitor ??= createRuntimeProbeMonitor(process.env);
  return monitor;
}

/**
 * Replace the monitor with a fresh one holding NO evidence: exactly what a process restart does.
 * Used at boot and by QA to prove that evidence never survives a restart.
 */
export function restartApiRuntimeMonitor(options: RuntimeProbeMonitorOptions & { policy?: RuntimeProbePolicy } = {}): RuntimeProbeMonitor {
  monitor?.stop();
  monitor = createRuntimeProbeMonitor(process.env, options);
  return monitor;
}

export function apiRuntimeReadiness(): RuntimeReadiness {
  return apiRuntimeMonitor().readiness();
}

/** Starts background probing when the API boots and stops it on shutdown. */
@Injectable()
export class RuntimeProbeLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  onApplicationBootstrap(): void {
    if (process.env.QEYNOX_RUNTIME_PROBES === 'off') return;
    apiRuntimeMonitor().start();
  }

  onApplicationShutdown(): void {
    apiRuntimeMonitor().stop();
  }
}
