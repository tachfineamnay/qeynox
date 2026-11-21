import { createEmailTransportFromEnv, type EmailTransport } from '@qeynox/application';

/**
 * The e-mail transport for this deployment. MISSION A19: a real adapter exists behind
 * QEYNOX_EMAIL_PROVIDER — 'resend' wires ResendEmailTransport; anything missing, incomplete or
 * unrecognized fails closed to a transport that refuses to send (no message is ever claimed to
 * be delivered). Credentials are deployment secrets (see .env.example); they are never committed.
 */
export function createEmailTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  return createEmailTransportFromEnv(env);
}
