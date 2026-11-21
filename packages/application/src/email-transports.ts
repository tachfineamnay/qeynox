import { DomainError } from '@qeynox/domain';
import { NotConfiguredEmailTransport, type EmailSendReceipt, type EmailTransport } from './platform-users';

/**
 * MISSION A19 — real provider adapter for the email transport port.
 *
 * Delivery truth: `send` resolves only when the provider accepted the message (HTTP 200 from the
 * Resend API, or a stubbed fetch in QA). Everything else throws `EmailDeliveryError` with a
 * retryability classification, which the delivery ledger persists. Nothing in this process ever
 * marks a message SENT on a network error, a non-2xx response, or a missing configuration.
 */

export class EmailDeliveryError extends Error {
  readonly code: string;
  /** True when the failure is plausibly transient (network, timeout, 429, 5xx) and worth retrying. */
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code;
    this.retryable = retryable;
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10000;

export interface ResendTransportOptions {
  readonly apiKey: string;
  /** RFC 5322 From value, e.g. "QeyNox <notifications@example.com>". Required; sends refuse without it. */
  readonly from: string;
  /** Injected fetch implementation; defaults to global fetch. Tests/QA pass a stub. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ResendEmailTransport implements EmailTransport {
  readonly status = 'CONFIGURED' as const;
  readonly reason: null = null;
  readonly provider = 'resend';
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ResendTransportOptions) {
    if (!options.apiKey?.trim() || !options.from?.trim()) {
      throw new DomainError('NOT_CONFIGURED', 'Resend delivery requires both QEYNOX_RESEND_API_KEY and QEYNOX_EMAIL_FROM');
    }
    this.apiKey = options.apiKey.trim();
    this.from = options.from.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
    readonly category?: string;
    readonly deduplicationKey?: string;
  }): Promise<EmailSendReceipt> {
    const body: Record<string, unknown> = {
      from: this.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.category ? { tags: [{ name: 'category', value: message.category }] } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: globalThis.Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + this.apiKey,
          'content-type': 'application/json',
          ...(message.deduplicationKey ? { 'idempotency-key': message.deduplicationKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new EmailDeliveryError(
        aborted ? 'EMAIL_PROVIDER_TIMEOUT' : 'EMAIL_PROVIDER_UNREACHABLE',
        aborted ? 'The e-mail provider did not answer in time' : 'The e-mail provider could not be reached',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 200 && response.status < 300) {
      let providerMessageId: string | null = null;
      try {
        const parsed = await response.json() as { id?: unknown };
        if (typeof parsed.id === 'string' && parsed.id.length > 0 && parsed.id.length <= 191) providerMessageId = parsed.id;
      } catch {
        // A 2xx without a parseable body still means the provider accepted the message.
      }
      return { providerMessageId };
    }
    const retryable = response.status === 429 || response.status >= 500;
    let providerCode = 'HTTP_' + response.status;
    try {
      const parsed = await response.json() as { name?: unknown; message?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name : undefined;
      if (name && /^[a-z0-9_.-]{1,64}$/i.test(name)) providerCode = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    } catch { /* keep HTTP_<status> */ }
    throw new EmailDeliveryError(
      retryable ? 'EMAIL_PROVIDER_RETRYABLE' : 'EMAIL_PROVIDER_REJECTED',
      'The e-mail provider refused the message (' + providerCode + ')',
      retryable,
    );
  }
}

/**
 * Provider selection, from the environment. Anything unrecognized or missing fails closed to the
 * not-configured transport: a mis-typed provider name must never resolve to a half-working sender.
 *
 *   QEYNOX_EMAIL_PROVIDER=resend   → ResendEmailTransport (requires QEYNOX_RESEND_API_KEY + QEYNOX_EMAIL_FROM)
 *   unset / anything else          → NotConfiguredEmailTransport (no message is ever sent)
 */
export function createEmailTransportFromEnv(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const provider = (env.QEYNOX_EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (provider === 'resend') {
    const apiKey = env.QEYNOX_RESEND_API_KEY ?? '';
    const from = env.QEYNOX_EMAIL_FROM ?? '';
    if (!apiKey.trim() || !from.trim()) {
      // Named but unusable: fail closed with the precise reason, never a silent partial send.
      return new NotConfiguredEmailTransport('EMAIL_PROVIDER_INCOMPLETE: QEYNOX_EMAIL_PROVIDER=resend requires QEYNOX_RESEND_API_KEY and QEYNOX_EMAIL_FROM');
    }
    return new ResendEmailTransport({ apiKey, from });
  }
  return new NotConfiguredEmailTransport(provider.length ? 'EMAIL_TRANSPORT_NOT_IMPLEMENTED' : 'EMAIL_PROVIDER_NOT_CONFIGURED');
}
