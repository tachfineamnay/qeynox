/**
 * Deployment runtime prerequisites for executing a mission step.
 *
 * The values are reported by the process that owns the configuration (API deployment env) and are
 * never inferred: an absent value is reported as missing, never as available.
 */
export interface RuntimeComponent {
  readonly id: string;
  readonly configured: boolean;
  readonly missing: readonly string[];
}
export interface RuntimeReadiness {
  readonly engine: RuntimeComponent;
  readonly orchestrator: RuntimeComponent;
}
export type RuntimeReadinessSource = () => RuntimeReadiness;

/** Fail closed when no deployment source is wired: nothing is assumed configured. */
export const failClosedRuntime: RuntimeReadinessSource = () => ({
  engine: { id: 'hermes', configured: false, missing: ['HERMES_API_BASE_URL', 'HERMES_API_KEY'] },
  orchestrator: { id: 'hatchet', configured: false, missing: ['HATCHET_CLIENT_TOKEN'] },
});
