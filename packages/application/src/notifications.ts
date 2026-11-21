import { randomUUID } from 'node:crypto';
import { DomainError } from '@qeynox/domain';
import { renderEmail, resolveEmailLocale, type EmailTemplateId } from './email-templates';
import { EmailDeliveryError } from './email-transports';
import type { EmailTransport } from './platform-users';

/**
 * MISSION A19 — customer notifications: in-app inbox, e-mail delivery ledger with retry and
 * deduplication, and per-category e-mail opt-outs.
 *
 * Invariants:
 *
 * 1. **Safe deduplication.** Every inbox row and every delivery row carries a unique
 *    `deduplication_key` derived from the source event. Re-materializing the same event inserts
 *    nothing the second time — retried code paths cannot double-notify.
 * 2. **No fabricated delivery.** A delivery is SENT only when the provider accepted the message
 *    (see the transport port). Failures are recorded with an error code and retried with backoff
 *    up to max_attempts; then the row is terminally FAILED. Permanent provider rejections fail
 *    immediately.
 * 3. **Retry is for secret-free content only.** Notification e-mails carry template id + vars, so
 *    the sender re-renders them deterministically on every attempt. Identity and invitation
 *    e-mails embed single-use links; the link value is NEVER persisted. Those rows are recorded
 *    SENT/FAILED with `retryable = false` — a retry would either resend a dead link or require
 *    storing the token, both unacceptable.
 * 4. **Opt-outs apply to customer notification e-mails only.** Verification, recovery and
 *    invitation e-mails are transactional and always sent when the transport is configured.
 *    In-app rows are always recorded.
 * 5. **Recipients are workspace-scoped.** An event notifies the operation's creator (while an ACTIVE
 *    member) and the workspace's ACTIVE OWNER/ADMIN members — the accounts able to act on it.
 *    Disabled accounts are never notified.
 * 6. **No event loss (P13).** Every eligible event gets a durable receipt in the same transaction
 *    as its inbox rows and delivery jobs; processing is oldest-first and resumes after downtime.
 */

export const NOTIFICATION_CATEGORIES = ['APPROVALS', 'EXECUTION_FAILURES', 'RESULTS'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationEventKind = 'STEPS_COMPLETED_REVIEW_REQUIRED' | 'STEP_FAILED' | 'STEP_OUTCOME_UNKNOWN' | 'RESULT_DELIVERED';
export const NOTIFICATION_EVENT_KINDS: readonly NotificationEventKind[] = ['STEPS_COMPLETED_REVIEW_REQUIRED', 'STEP_FAILED', 'STEP_OUTCOME_UNKNOWN', 'RESULT_DELIVERED'];

export interface InboxItem {
  readonly id: string;
  readonly kind: NotificationCategory;
  readonly title: string;
  readonly body: string;
  readonly operationId: string | null;
  readonly linkPath: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}
export interface InboxPage {
  readonly items: readonly InboxItem[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export interface NotificationPreference {
  readonly category: NotificationCategory;
  readonly emailEnabled: boolean;
}
export interface NotificationEventRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly data: Record<string, unknown>;
}
export interface NotificationRecipient {
  readonly userId: string;
  readonly email: string;
  readonly locale: string;
  /** ACTIVE membership role in the workspace, or 'CREATOR' when the membership row itself carries the role. */
  readonly role: string;
}
export interface OperationPointer {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly title: string;
}
export interface DueDelivery {
  readonly id: string;
  readonly userId: string | null;
  readonly workspaceId: string | null;
  readonly category: string;
  readonly recipient: string;
  readonly subject: string;
  readonly provider: string;
  readonly locale: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly templateId: string | null;
  readonly templateVars: Record<string, string> | null;
  readonly deduplicationKey: string;
  readonly notificationId: string | null;
  /** P14: fencing token of THIS claim; every transition must present it. */
  readonly leaseToken: string;
  /** P14: when the first provider attempt was claimed (start of the idempotency window). */
  readonly firstAttemptAt: string;
  /** P14: an earlier attempt may have reached the provider without a definitive answer. */
  readonly outcomeUncertain: boolean;
}
export interface InlineDeliveryRecord {
  readonly deduplicationKey: string;
  readonly userId: string | null;
  readonly workspaceId: string | null;
  readonly category: string;
  readonly recipient: string;
  readonly subject: string;
  readonly provider: string;
  readonly status: 'SENT' | 'FAILED';
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly providerMessageId: string | null;
  readonly locale: string | null;
  readonly sentAt: Date | null;
  readonly notificationId?: string | null;
}

/** P13 — what one event's materialization may touch; bound to the event's transaction. */
export type NotificationEventScope = Pick<NotificationRepository, 'findOperation' | 'listRecipients' | 'insertNotification' | 'insertDelivery' | 'getPreferenceRows'>;
export interface EventMaterialization { readonly outcome: 'MATERIALIZED' | 'SKIPPED'; readonly reason?: string | null; readonly notifications: number; readonly deliveries: number }
/** P13 — late-commit safety window for the scan watermark. */
export const NOTIFICATION_EVENT_SCAN_LAG_MS = 24 * 60 * 60 * 1000;
/**
 * P13 — an event older than this when first materialized still gets its inbox rows, but no e-mail
 * (e.g. the first run after deployment catching up on history, or a very long outage).
 */
export const NOTIFICATION_EMAIL_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface NotificationRepository {
  findOperation(operationId: string): Promise<OperationPointer | undefined>;
  /** ACTIVE OWNER/ADMIN members ∪ the operation creator; disabled accounts excluded. */
  listRecipients(workspaceId: string, createdBy: string): Promise<readonly NotificationRecipient[]>;
  /** Inserts the inbox row; returns false when the deduplication key already exists. */
  insertNotification(row: {
    id: string; userId: string; workspaceId: string; kind: NotificationCategory;
    title: string; body: string; operationId: string | null; linkPath: string | null;
    deduplicationKey: string; createdAt: Date;
  }): Promise<boolean>;
  /** Inserts a delivery row; returns false when the deduplication key already exists. */
  insertDelivery(row: {
    id: string; userId: string | null; workspaceId: string | null; category: string;
    recipient: string; subject: string; provider: string; status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
    attemptCount: number; maxAttempts: number; nextRetryAt: Date; lastErrorCode: string | null;
    providerMessageId: string | null; templateId: string | null; templateVars: Record<string, string> | null;
    locale: string | null; retryable: boolean; deduplicationKey: string; notificationId: string | null;
    createdAt: Date; sentAt: Date | null;
  }): Promise<boolean>;
  /** P13: eligible events without a processing receipt, oldest first, from the durable watermark. */
  listUnprocessedEvents(kinds: readonly string[], limit: number): Promise<readonly NotificationEventRow[]>;
  /** P13: claims the event's receipt and runs `work` in ONE transaction (receipt + inbox + deliveries). */
  processEvent(
    event: { id: string; workspaceId: string; kind: string },
    work: (scoped: NotificationEventScope) => Promise<EventMaterialization>,
  ): Promise<{ claimed: false } | ({ claimed: true } & Required<Pick<EventMaterialization, 'outcome' | 'notifications' | 'deliveries'>> & { reason: string | null })>;
  /** P13: advances the scan watermark (never past an unprocessed event, never closer than the lag). */
  advanceEventWatermark(kinds: readonly string[], now: Date, safetyLagMs: number): Promise<void>;
  listInbox(userId: string, workspaceId: string, input: { unreadOnly: boolean; before: { createdAt: Date; id: string } | null; take: number }): Promise<readonly InboxItem[]>;
  countUnread(userId: string, workspaceId: string): Promise<number>;
  markRead(userId: string, workspaceId: string, id: string, at: Date): Promise<boolean>;
  markAllRead(userId: string, workspaceId: string, at: Date): Promise<number>;
  getPreferenceRows(userId: string): Promise<ReadonlyMap<NotificationCategory, boolean>>;
  setPreference(userId: string, category: NotificationCategory, emailEnabled: boolean, at: Date): Promise<void>;
  /** P14: atomically claims due, unleased deliveries under a fenced lease (each claim is an attempt). */
  claimDue(now: Date, limit: number, options: { owner: string; leaseMs: number; idempotencyWindowStart: Date }): Promise<readonly DueDelivery[]>;
  /** P14: FAILED for abandoned rows that cannot be safely attempted again (exhausted / uncertain past the window). */
  failAbandonedDeliveries(now: Date, idempotencyWindowStart: Date): Promise<number>;
  /** P14: extends the claim's lease; false when this worker no longer owns the row. */
  renewDeliveryLease(id: string, leaseToken: string, now: Date, leaseMs: number): Promise<boolean>;
  /** Owner-checked; false when the lease was lost (nothing is changed). */
  markSent(id: string, leaseToken: string, providerMessageId: string | null, at: Date): Promise<boolean>;
  markRetryableFailure(id: string, leaseToken: string, errorCode: string, nextRetryAt: Date, uncertain: boolean, at: Date): Promise<boolean>;
  markTerminalFailure(id: string, leaseToken: string, errorCode: string, at: Date, uncertain?: boolean): Promise<boolean>;
}

/** Narrow port for services that record inline delivery outcomes (identity, invitations). */
export interface DeliveryLedger {
  recordInline(record: InlineDeliveryRecord): Promise<void>;
}

export interface NotificationServiceOptions {
  readonly now?: () => Date;
  /** Absolute base URL used to build links inside e-mails. Falls back to relative paths when unset. */
  readonly publicBaseUrl?: string | null;
}

const KIND_MAP: Record<NotificationEventKind, { kind: NotificationCategory; template: EmailTemplateId }> = {
  STEPS_COMPLETED_REVIEW_REQUIRED: { kind: 'APPROVALS', template: 'APPROVAL_REQUIRED' },
  STEP_FAILED: { kind: 'EXECUTION_FAILURES', template: 'EXECUTION_FAILED' },
  STEP_OUTCOME_UNKNOWN: { kind: 'EXECUTION_FAILURES', template: 'EXECUTION_FAILED' },
  RESULT_DELIVERED: { kind: 'RESULTS', template: 'RESULT_DELIVERED' },
};

const backoffSeconds = [60, 300, 900] as const;
const defaultMaxAttempts = 3;
/**
 * P14 — delivery lease. Renewed immediately before each provider call, so it only has to outlast one
 * call (the Resend transport aborts after 10 s by default); expiry means the worker crashed or stalled.
 */
export const EMAIL_DELIVERY_LEASE_MS = 5 * 60 * 1000;
/**
 * P14 — Resend keeps an idempotency key for 24 hours. A delivery with an uncertain earlier attempt is
 * re-sent (with the same key) only within this margin-adjusted window; later it is FAILED instead.
 */
export const EMAIL_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Localized inbox strings (title, body with {operationTitle}). Same locale set as the e-mail catalog. */
const inboxCopy: Record<NotificationCategory, Record<'en' | 'fr' | 'es' | 'de', { title: string; body: string }>> = {
  APPROVALS: {
    en: { title: 'Result ready for review', body: 'All steps for “{operationTitle}” are complete. A result review is pending your decision.' },
    fr: { title: 'Résultat prêt pour votre revue', body: 'Toutes les étapes de « {operationTitle} » sont terminées. Une revue de résultat attend votre décision.' },
    es: { title: 'Resultado listo para revisión', body: 'Todos los pasos de «{operationTitle}» están completos. La revisión del resultado espera tu decisión.' },
    de: { title: 'Ergebnis wartet auf Ihre Prüfung', body: 'Alle Schritte für „{operationTitle}“ sind abgeschlossen. Eine Ergebnissichtung wartet auf Ihre Entscheidung.' },
  },
  EXECUTION_FAILURES: {
    en: { title: 'Execution failed', body: 'A step of “{operationTitle}” stopped ({errorCode}). Nothing is marked as delivered.' },
    fr: { title: 'L’exécution a échoué', body: 'Une étape de « {operationTitle} » s’est arrêtée ({errorCode}). Rien n’est marqué comme livré.' },
    es: { title: 'La ejecución falló', body: 'Un paso de «{operationTitle}» se detuvo ({errorCode}). Nada se marca como entregado.' },
    de: { title: 'Ausführung fehlgeschlagen', body: 'Ein Schritt von „{operationTitle}“ wurde angehalten ({errorCode}). Nichts ist als zugestellt markiert.' },
  },
  RESULTS: {
    en: { title: 'Result delivered', body: 'The reviewed deliverable for “{operationTitle}” has been released.' },
    fr: { title: 'Résultat livré', body: 'Le livrable revu pour « {operationTitle} » a été publié.' },
    es: { title: 'Resultado entregado', body: 'El entregable revisado de «{operationTitle}» ha sido publicado.' },
    de: { title: 'Ergebnis zugestellt', body: 'Das geprüfte Ergebnisdokument für „{operationTitle}“ wurde freigegeben.' },
  },
};

export class NotificationService {
  private readonly now: () => Date;
  private readonly publicBaseUrl: string | null;

  constructor(
    private readonly repository: NotificationRepository & DeliveryLedger,
    private readonly email: EmailTransport,
    options: NotificationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '') ?? null;
  }

  // --- inbox -------------------------------------------------------------------------------

  async inbox(userId: string, workspaceId: string, input: { unreadOnly?: boolean; limit?: number; cursor?: string | null }): Promise<InboxPage> {
    const take = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), 100);
    const before = decodeCursor(input.cursor ?? null);
    const items = await this.repository.listInbox(userId, workspaceId, { unreadOnly: input.unreadOnly === true, before, take: take + 1 });
    const page = items.slice(0, take);
    const last = page.at(-1);
    const nextCursor = items.length > take && last ? encodeCursor(last.createdAt, last.id) : null;
    const unreadCount = await this.repository.countUnread(userId, workspaceId);
    return { items: page, nextCursor, unreadCount };
  }

  markRead(userId: string, workspaceId: string, id: string): Promise<{ read: boolean }> {
    return this.repository.markRead(userId, workspaceId, id, this.now()).then(read => ({ read }));
  }

  markAllRead(userId: string, workspaceId: string): Promise<{ updated: number }> {
    return this.repository.markAllRead(userId, workspaceId, this.now()).then(updated => ({ updated }));
  }

  async preferences(userId: string): Promise<readonly NotificationPreference[]> {
    const rows = await this.repository.getPreferenceRows(userId);
    return NOTIFICATION_CATEGORIES.map(category => ({ category, emailEnabled: rows.get(category) ?? true }));
  }

  async setPreference(userId: string, category: string, emailEnabled: boolean): Promise<NotificationPreference> {
    if (!NOTIFICATION_CATEGORIES.includes(category as NotificationCategory)) {
      throw new DomainError('INVALID_INPUT', 'Unknown notification category: ' + category);
    }
    const typed = category as NotificationCategory;
    await this.repository.setPreference(userId, typed, emailEnabled === true, this.now());
    return { category: typed, emailEnabled: emailEnabled === true };
  }

  // --- materialization (runs in the worker) --------------------------------------------------

  /**
   * Converts notification-relevant domain events into inbox rows and delivery jobs (MISSION P13).
   *
   * - Every eligible event without a durable receipt is processed, OLDEST first; a burst larger than
   *   one batch continues in the next batch / drain, and a worker outage resumes where it stopped.
   * - Each event is atomic: receipt + inbox rows + e-mail jobs commit together or not at all.
   *   Concurrent workers serialize on the receipt; the loser skips.
   * - Deduplication keys stay `evt:<eventId>:<userId>` in both tables, so events materialized before
   *   this change (no receipt yet) are re-visited once without double-notifying.
   * - Workspace isolation: the event's workspace must own the operation; recipients come from that
   *   workspace only. Preferences decide the e-mail at first materialization, as before.
   * - A failing event is rolled back and retried on the next pass; it does not block the others.
   */
  async materialize(limit = 25, maxBatches = 4): Promise<{ scanned: number; notifications: number; deliveries: number; skipped: number; failed: number }> {
    const batchSize = Math.min(Math.max(1, Math.floor(limit)), 100);
    const totals = { scanned: 0, notifications: 0, deliveries: 0, skipped: 0, failed: 0 };
    const failedIds = new Set<string>();
    for (let batch = 0; batch < Math.max(1, Math.min(20, maxBatches)); batch++) {
      const events = (await this.repository.listUnprocessedEvents(NOTIFICATION_EVENT_KINDS, batchSize + failedIds.size))
        .filter(event => !failedIds.has(event.id)).slice(0, batchSize);
      if (!events.length) break;
      for (const event of events) {
        totals.scanned++;
        try {
          const result = await this.repository.processEvent(
            { id: event.id, workspaceId: event.workspaceId, kind: event.kind },
            scoped => this.materializeEvent(scoped, event),
          );
          if (!result.claimed) continue; // another worker processed it
          totals.notifications += result.notifications;
          totals.deliveries += result.deliveries;
          if (result.outcome === 'SKIPPED') totals.skipped++;
        } catch (error: unknown) {
          // Rolled back as a whole; the event keeps no receipt and is retried on the next pass.
          failedIds.add(event.id);
          totals.failed++;
          console.error('[notifications] event ' + event.id + ' not materialized:', error instanceof Error ? error.message : 'unknown');
        }
      }
      if (events.length < batchSize) break;
    }
    await this.repository.advanceEventWatermark(NOTIFICATION_EVENT_KINDS, this.now(), NOTIFICATION_EVENT_SCAN_LAG_MS);
    return totals;
  }

  /** One event inside its transaction. Never sends; only records inbox rows and PENDING jobs. */
  private async materializeEvent(scoped: NotificationEventScope, event: NotificationEventRow): Promise<EventMaterialization> {
    const mapping = KIND_MAP[event.kind as NotificationEventKind];
    if (!mapping) return { outcome: 'SKIPPED', reason: 'UNSUPPORTED_KIND', notifications: 0, deliveries: 0 };
    const operation = await scoped.findOperation(event.operationId);
    if (!operation) return { outcome: 'SKIPPED', reason: 'OPERATION_NOT_FOUND', notifications: 0, deliveries: 0 };
    // Workspace isolation: an event never notifies anyone outside the workspace owning the operation.
    if (operation.workspaceId !== event.workspaceId) return { outcome: 'SKIPPED', reason: 'WORKSPACE_MISMATCH', notifications: 0, deliveries: 0 };
    const recipients = await scoped.listRecipients(event.workspaceId, operation.createdBy);
    if (!recipients.length) return { outcome: 'SKIPPED', reason: 'NO_RECIPIENTS', notifications: 0, deliveries: 0 };
    const errorCode = typeof event.data['errorCode'] === 'string' ? event.data['errorCode'] : null;
    const occurredAt = Date.parse(event.occurredAt);
    const emailEligible = this.email.status === 'CONFIGURED'
      && Number.isFinite(occurredAt) && this.now().getTime() - occurredAt <= NOTIFICATION_EMAIL_MAX_EVENT_AGE_MS;
    let notifications = 0;
    let deliveries = 0;
    for (const recipient of recipients) {
      const locale = resolveEmailLocale(recipient.locale);
      const dedup = 'evt:' + event.id + ':' + recipient.userId;
      const strings = inboxCopy[mapping.kind][locale];
      const body = strings.body
        .replace('{operationTitle}', operation.title)
        .replace('{errorCode}', errorCode ?? 'UNKNOWN');
      const actionUrl = this.absoluteUrl('/' + locale + '/missions/' + operation.id);
      const id = randomUUID();
      const inserted = await scoped.insertNotification({
        id, userId: recipient.userId, workspaceId: event.workspaceId, kind: mapping.kind,
        title: strings.title, body, operationId: operation.id,
        linkPath: '/missions/' + operation.id,
        deduplicationKey: dedup, createdAt: this.now(),
      });
      // The e-mail decision belongs to the FIRST materialization of (event, recipient): if the inbox
      // row already existed (materialized before receipts existed), its decision is already recorded.
      if (!inserted) continue;
      notifications++;
      // E-mail only when opted in (default: opted in). In-app is recorded regardless. Never create a
      // delivery row while no transport exists: it would imply a send happened or will happen.
      const prefs = await scoped.getPreferenceRows(recipient.userId);
      if (!(prefs.get(mapping.kind) ?? true) || !emailEligible) continue;
      const templateVars: Record<string, string> = {
        operationTitle: operation.title,
        actionUrl,
        ...(errorCode ? { errorCode } : {}),
      };
      const rendered = renderEmail(mapping.template, locale, templateVars);
      const deliveryInserted = await scoped.insertDelivery({
        id: randomUUID(), userId: recipient.userId, workspaceId: event.workspaceId,
        category: mapping.kind, recipient: recipient.email, subject: rendered.subject,
        provider: this.email.provider, status: 'PENDING', attemptCount: 0, maxAttempts: defaultMaxAttempts,
        nextRetryAt: this.now(), lastErrorCode: null, providerMessageId: null,
        templateId: mapping.template, templateVars, locale, retryable: true,
        deduplicationKey: dedup, notificationId: id,
        createdAt: this.now(), sentAt: null,
      });
      if (deliveryInserted) deliveries++;
    }
    return { outcome: 'MATERIALIZED', notifications, deliveries };
  }

  /**
   * Claims due deliveries and (re)attempts the send under exclusive ownership (MISSION P14).
   *
   * - A claim is a fenced lease: until it is released or expires, no other worker can claim the row.
   *   The lease is renewed right before the provider call; a worker that lost it does not send.
   * - Success → SENT with the provider message id. Failure → PENDING with backoff (lease released), or
   *   FAILED when the provider rejected permanently or attempts are exhausted. All owner-checked.
   * - Uncertain outcomes (timeout, network error, 5xx, crashed worker) are retried only with the same
   *   Resend idempotency key (the deduplication key) and only inside the key's window; afterwards the
   *   row is FAILED with EMAIL_OUTCOME_UNCERTAIN — never reported SENT, never re-sent blindly.
   */
  async processDueDeliveries(limit = 10): Promise<{ claimed: number; sent: number; retrying: number; failed: number }> {
    const now = this.now();
    const windowStart = new Date(now.getTime() - EMAIL_IDEMPOTENCY_WINDOW_MS);
    let failed = await this.repository.failAbandonedDeliveries(now, windowStart);
    const due = await this.repository.claimDue(now, Math.min(Math.max(1, limit), 50), { owner: this.deliveryOwner, leaseMs: EMAIL_DELIVERY_LEASE_MS, idempotencyWindowStart: windowStart });
    let sent = 0, retrying = 0;
    for (const delivery of due) {
      if (!delivery.templateId) {
        if (await this.repository.markTerminalFailure(delivery.id, delivery.leaseToken, 'EMAIL_DELIVERY_NOT_RETRYABLE', this.now())) failed++;
        continue;
      }
      const rendered = renderEmail(delivery.templateId as EmailTemplateId, delivery.locale, delivery.templateVars ?? {});
      // Ownership is re-proven (and the lease extended) immediately before the provider call.
      if (!(await this.repository.renewDeliveryLease(delivery.id, delivery.leaseToken, this.now(), EMAIL_DELIVERY_LEASE_MS))) continue;
      try {
        const receipt = await this.email.send({
          to: delivery.recipient,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          category: delivery.category,
          // Resend idempotency key: unchanged across every attempt of this delivery.
          deduplicationKey: delivery.deduplicationKey,
        });
        if (await this.repository.markSent(delivery.id, delivery.leaseToken, receipt.providerMessageId, this.now())) {
          sent++;
        } else {
          // Lease lost during the call (should not happen: renewed just before a bounded call). Nothing is
          // written; the owner re-sends with the same idempotency key and records the provider's answer.
          console.warn('[notifications] delivery ' + delivery.id + ' accepted after its lease was lost; left to the current owner');
        }
      } catch (error: unknown) {
        const classified = classifyDeliveryError(error);
        const nextRetryAt = new Date(this.now().getTime() + (backoffSeconds[Math.min(Math.max(delivery.attemptCount, 1), backoffSeconds.length) - 1] ?? 3600) * 1000);
        const outsideWindow = (classified.uncertain || delivery.outcomeUncertain)
          && nextRetryAt.getTime() - Date.parse(delivery.firstAttemptAt) > EMAIL_IDEMPOTENCY_WINDOW_MS;
        if (!classified.retryable || delivery.attemptCount >= delivery.maxAttempts || outsideWindow) {
          const code = outsideWindow && classified.retryable ? 'EMAIL_OUTCOME_UNCERTAIN' : classified.code;
          if (await this.repository.markTerminalFailure(delivery.id, delivery.leaseToken, code, this.now(), classified.uncertain)) failed++;
        } else if (await this.repository.markRetryableFailure(delivery.id, delivery.leaseToken, classified.code, nextRetryAt, classified.uncertain, this.now())) {
          retrying++;
        }
      }
    }
    return { claimed: due.length, sent, retrying, failed };
  }

  /** P14 — per-instance lease owner identity (diagnostic; ownership is proven by the lease token). */
  private readonly deliveryOwner = 'notifications:' + randomUUID();

  /** One drain pass: materialize new events, then send what is due. Safe to run on an interval. */
  async drain(limit = 25): Promise<{ materialized: { scanned: number; notifications: number; deliveries: number; skipped: number; failed: number }; deliveries: { claimed: number; sent: number; retrying: number; failed: number } }> {
    const materialized = await this.materialize(limit);
    const deliveries = await this.processDueDeliveries(limit);
    return { materialized, deliveries };
  }

  private absoluteUrl(path: string): string {
    return this.publicBaseUrl ? this.publicBaseUrl + path : path;
  }
}

/** P14: `uncertain` = the provider may have accepted the message (no definitive answer). */
function classifyDeliveryError(error: unknown): { code: string; retryable: boolean; uncertain: boolean } {
  if (error instanceof EmailDeliveryError) return { code: error.code, retryable: error.retryable, uncertain: error.uncertain };
  if (error instanceof DomainError) return { code: error.code, retryable: false, uncertain: false };
  // Unknown failure during the call: conservatively assume the message may have gone out.
  return { code: 'EMAIL_DELIVERY_FAILED', retryable: true, uncertain: true };
}

const encodeCursor = (createdAt: string, id: string): string => Buffer.from(createdAt + '|' + id, 'utf8').toString('base64url');
const decodeCursor = (cursor: string | null): { createdAt: Date; id: string } | null => {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = raw.indexOf('|');
    if (separator <= 0) return null;
    const createdAt = new Date(raw.slice(0, separator));
    const id = raw.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return { createdAt, id };
  } catch { return null; }
};
