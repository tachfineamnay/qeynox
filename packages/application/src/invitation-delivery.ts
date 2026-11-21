import { renderEmail } from './email-templates';
import { EmailDeliveryError } from './email-transports';
import type { EmailTransport } from './platform-users';
import type { DeliveryLedger } from './notifications';

/**
 * MISSION A19 — shared invitation e-mail delivery for the two invitation paths in this codebase
 * (customer self-service workspace invitations and operator-driven platform invitations).
 *
 * The e-mail links to the workspace area, where the invitation inbox lists the pending invitation
 * for the signed-in account. The single-use raw token is still returned to the inviting principal
 * exactly as before — manual delivery remains possible and unchanged. The message content is
 * single-use and is NEVER persisted; the delivery ledger records only the outcome.
 */

/** Wire shape returned by both invitation endpoints. `reason` is an honest machine code. */
export type InvitationDelivery =
  | { readonly email: 'SENT'; readonly reason: null }
  | { readonly email: 'BLOCKED'; readonly reason: string }
  | { readonly email: 'FAILED'; readonly reason: string | null };

export interface InvitationDeliveryDeps {
  readonly email?: EmailTransport | null | undefined;
  readonly deliveryLedger?: DeliveryLedger | null | undefined;
  /** Absolute base URL for links inside e-mails; relative paths are emitted when unset. */
  readonly publicBaseUrl?: string | null | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface InvitationDeliveryInput {
  readonly membershipId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly recipientEmail: string;
  readonly recipientLocale: string | null | undefined;
  readonly role: string;
  readonly expiresAt: Date;
}

export async function deliverInvitationEmail(deps: InvitationDeliveryDeps, input: InvitationDeliveryInput): Promise<InvitationDelivery> {
  const now = deps.now ?? (() => new Date());
  const locale = (input.recipientLocale ?? 'en').trim().toLowerCase().split('-')[0] || 'en';
  const baseUrl = deps.publicBaseUrl?.replace(/\/+$/, '') ?? null;
  const actionUrl = baseUrl ? baseUrl + '/' + locale + '/workspaces' : '/' + locale + '/workspaces';
  const email = deps.email ?? null;
  if (!email || email.status !== 'CONFIGURED') {
    return { email: 'BLOCKED', reason: email?.reason ?? 'EMAIL_PROVIDER_NOT_CONFIGURED' };
  }
  const rendered = renderEmail('WORKSPACE_INVITATION', locale, {
    workspaceName: input.workspaceName, role: input.role, actionUrl,
    expiresAt: input.expiresAt.toISOString(),
  });
  // One delivery row per membership: re-sending for the same pending invitation reuses the key.
  const dedup = 'invitation:' + input.membershipId;
  try {
    const receipt = await email.send({
      to: input.recipientEmail, subject: rendered.subject, text: rendered.text, html: rendered.html,
      category: 'TRANSACTIONAL', deduplicationKey: dedup,
    });
    await recordInline(deps, dedup, input, rendered.subject, 'SENT', receipt.providerMessageId, null, locale, now());
    return { email: 'SENT', reason: null };
  } catch (error) {
    const code = error instanceof EmailDeliveryError ? error.code : 'EMAIL_DELIVERY_FAILED';
    await recordInline(deps, dedup, input, rendered.subject, 'FAILED', null, code, locale, now());
    return { email: 'FAILED', reason: code };
  }
}

/** Best-effort ledger write: bookkeeping must never mask the real delivery outcome. */
async function recordInline(
  deps: InvitationDeliveryDeps,
  dedup: string,
  input: InvitationDeliveryInput,
  subject: string,
  status: 'SENT' | 'FAILED',
  providerMessageId: string | null,
  lastErrorCode: string | null,
  locale: string,
  at: Date,
): Promise<void> {
  if (!deps.deliveryLedger || !deps.email) return;
  try {
    await deps.deliveryLedger.recordInline({
      deduplicationKey: dedup, userId: input.userId, workspaceId: input.workspaceId,
      category: 'TRANSACTIONAL:WORKSPACE_INVITATION', recipient: input.recipientEmail,
      subject, provider: deps.email.provider, status, attemptCount: 1,
      lastErrorCode, providerMessageId, locale, sentAt: status === 'SENT' ? at : null,
    });
  } catch {
    // Never let bookkeeping turn a truthful outcome into a false one.
  }
}
