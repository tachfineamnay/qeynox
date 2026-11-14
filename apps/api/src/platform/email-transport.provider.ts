import { NotConfiguredEmailTransport, type EmailTransport } from '@qeynox/application';

/**
 * The only e-mail transport in this repository. It is deliberately not configured: no provider
 * adapter exists, so invitation, verification and recovery flows must fail closed instead of
 * claiming a message was sent. When QEYNOX_EMAIL_PROVIDER is set the reason distinguishes "named
 * but not implemented" from "no provider configured"; both keep the feature blocked.
 */
export function createEmailTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const provider = (env.QEYNOX_EMAIL_PROVIDER ?? '').trim();
  return new NotConfiguredEmailTransport(provider.length ? 'EMAIL_TRANSPORT_NOT_IMPLEMENTED' : 'EMAIL_PROVIDER_NOT_CONFIGURED');
}
