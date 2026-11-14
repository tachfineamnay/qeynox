import type { DeploymentInfoPort, DeploymentInfoView } from '@qeynox/application';

/** Deployment facts are only reported when the operator sets them; missing values stay null. */
export class EnvironmentDeploymentInfo implements DeploymentInfoPort {
  info(): DeploymentInfoView {
    const valueOf = (name: string): string | null => {
      const raw = (process.env[name] ?? '').trim();
      return raw.length ? raw : null;
    };
    return {
      version: { value: valueOf('QEYNOX_DEPLOY_VERSION'), source: 'QEYNOX_DEPLOY_VERSION' },
      commit: { value: valueOf('QEYNOX_DEPLOY_COMMIT'), source: 'QEYNOX_DEPLOY_COMMIT' },
      deployedAt: { value: valueOf('QEYNOX_DEPLOYED_AT'), source: 'QEYNOX_DEPLOYED_AT' },
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
