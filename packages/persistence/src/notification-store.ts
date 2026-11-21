import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { QeyNoxDatabase } from './database';
import { operations, events } from './schema';
import { identityMemberships, identityUsers } from './identity-schema';
import { notifications, emailDeliveries, notificationPreferences, notificationEventReceipts, notificationCheckpoints, type NotificationKind } from './notification-schema';

/**
 * MISSION A19 — Drizzle implementation of the notification repository contracts declared in
 * @qeynox/application (NotificationRepository & DeliveryLedger). Structural typing keeps
 * persistence free of application imports; signatures are kept byte-identical on purpose.
 */

export interface InboxRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly operationId: string | null;
  readonly linkPath: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
const EVENT_CHECKPOINT = 'notification-events';

export class NotificationStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async findOperation(operationId: string) {
    const [row] = await this.db.select({ id: operations.id, workspaceId: operations.workspaceId, createdBy: operations.createdBy, payload: operations.payload })
      .from(operations).where(eq(operations.id, operationId)).limit(1);
    if (!row) return undefined;
    return { id: row.id, workspaceId: row.workspaceId, createdBy: row.createdBy, title: row.payload.title };
  }

  /** Operation creator (if an ACTIVE member) ∪ ACTIVE OWNER/ADMIN members; disabled accounts excluded. Creator first, deduplicated by userId. */
  async listRecipients(workspaceId: string, createdBy: string): Promise<readonly { userId: string; email: string; locale: string; role: string }[]> {
    const byId = new Map<string, { userId: string; email: string; locale: string; role: string }>();
    const adminRows = await this.db.select({ userId: identityUsers.id, email: identityUsers.email, locale: identityUsers.locale, role: identityMemberships.role })
      .from(identityMemberships)
      .innerJoin(identityUsers, eq(identityUsers.id, identityMemberships.userId))
      .where(and(eq(identityMemberships.workspaceId, workspaceId), eq(identityMemberships.status, 'ACTIVE'), inArray(identityMemberships.role, ['OWNER', 'ADMIN']), isNull(identityUsers.disabledAt)));
    for (const row of adminRows) byId.set(row.userId, row);
    // P13: the creator is notified only while still an ACTIVE member of THIS workspace.
    const [creator] = await this.db.select({ userId: identityUsers.id, email: identityUsers.email, locale: identityUsers.locale })
      .from(identityUsers)
      .innerJoin(identityMemberships, and(eq(identityMemberships.userId, identityUsers.id), eq(identityMemberships.workspaceId, workspaceId), eq(identityMemberships.status, 'ACTIVE')))
      .where(and(eq(identityUsers.id, createdBy), isNull(identityUsers.disabledAt))).limit(1);
    if (creator && !byId.has(creator.userId)) byId.set(creator.userId, { ...creator, role: 'CREATOR' });
    return [...byId.values()];
  }

  async insertNotification(row: {
    id: string; userId: string; workspaceId: string; kind: NotificationKind;
    title: string; body: string; operationId: string | null; linkPath: string | null;
    deduplicationKey: string; createdAt: Date;
  }): Promise<boolean> {
    const inserted = await this.db.insert(notifications).values({
      id: row.id, userId: row.userId, workspaceId: row.workspaceId, kind: row.kind,
      title: row.title, body: row.body, operationId: row.operationId, linkPath: row.linkPath,
      deduplicationKey: row.deduplicationKey, createdAt: row.createdAt,
    }).onConflictDoNothing({ target: notifications.deduplicationKey }).returning({ id: notifications.id });
    return inserted.length > 0;
  }

  async insertDelivery(row: {
    id: string; userId: string | null; workspaceId: string | null; category: string;
    recipient: string; subject: string; provider: string; status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
    attemptCount: number; maxAttempts: number; nextRetryAt: Date; lastErrorCode: string | null;
    providerMessageId: string | null; templateId: string | null; templateVars: Record<string, string> | null;
    locale: string | null; retryable: boolean; deduplicationKey: string; notificationId: string | null;
    createdAt: Date; sentAt: Date | null;
  }): Promise<boolean> {
    const inserted = await this.db.insert(emailDeliveries).values({
      id: row.id, userId: row.userId, workspaceId: row.workspaceId, category: row.category,
      recipient: row.recipient, subject: row.subject, provider: row.provider, status: row.status,
      attemptCount: row.attemptCount, maxAttempts: row.maxAttempts, nextRetryAt: row.nextRetryAt,
      lastErrorCode: row.lastErrorCode, providerMessageId: row.providerMessageId,
      templateId: row.templateId, templateVars: row.templateVars, locale: row.locale, retryable: row.retryable,
      deduplicationKey: row.deduplicationKey, notificationId: row.notificationId,
      createdAt: row.createdAt, updatedAt: row.createdAt, sentAt: row.sentAt,
    }).onConflictDoNothing({ target: emailDeliveries.deduplicationKey }).returning({ id: emailDeliveries.id });
    return inserted.length > 0;
  }

  async recordInline(record: {
    deduplicationKey: string; userId: string | null; workspaceId: string | null; category: string;
    recipient: string; subject: string; provider: string; status: 'SENT' | 'FAILED';
    attemptCount: number; lastErrorCode: string | null; providerMessageId: string | null;
    locale: string | null; sentAt: Date | null; notificationId?: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.db.insert(emailDeliveries).values({
      id: randomUUID(), userId: record.userId, workspaceId: record.workspaceId, category: record.category,
      recipient: record.recipient, subject: record.subject, provider: record.provider, status: record.status,
      attemptCount: record.attemptCount, maxAttempts: 1, nextRetryAt: now, lastErrorCode: record.lastErrorCode,
      providerMessageId: record.providerMessageId, templateId: null, templateVars: null, locale: record.locale,
      retryable: false, deduplicationKey: record.deduplicationKey, notificationId: record.notificationId ?? null,
      createdAt: now, updatedAt: now, sentAt: record.sentAt,
    }).onConflictDoNothing({ target: emailDeliveries.deduplicationKey });
  }

  /**
   * P13 — eligible events WITHOUT a processing receipt, oldest first. The scan starts at the durable
   * watermark (never past an unprocessed event, see advanceEventWatermark), so a burst larger than
   * `limit` is simply continued by the next call and no event is ever skipped.
   */
  async listUnprocessedEvents(kinds: readonly string[], limit: number) {
    if (kinds.length === 0) return [];
    const [checkpoint] = await this.db.select({ watermark: notificationCheckpoints.watermark }).from(notificationCheckpoints)
      .where(eq(notificationCheckpoints.name, EVENT_CHECKPOINT)).limit(1);
    const rows = await this.db.select({ id: events.id, workspaceId: events.workspaceId, operationId: events.operationId, kind: events.kind, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(and(
        inArray(events.kind, [...kinds]),
        checkpoint ? sql`${events.occurredAt} >= ${checkpoint.watermark}` : undefined,
        sql`NOT EXISTS (SELECT 1 FROM notification_event_receipts r WHERE r.event_id = ${events.id})`,
      ))
      .orderBy(asc(events.occurredAt), asc(events.id))
      .limit(limit);
    return rows.map(row => ({
      id: row.id, workspaceId: row.workspaceId, operationId: row.operationId, kind: row.kind,
      occurredAt: row.occurredAt, data: (row.payload.data ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * P13 — materializes ONE event atomically. The receipt is claimed first (primary key; a concurrent
   * worker blocks, then sees the conflict and gets `claimed: false`), then `work` runs against a
   * store bound to the same transaction, then the receipt records the outcome. Any error rolls back
   * the receipt, inbox rows and delivery jobs together, so the event is retried as a whole.
   */
  async processEvent(
    event: { id: string; workspaceId: string; kind: string },
    work: (scoped: NotificationStore) => Promise<{ outcome: 'MATERIALIZED' | 'SKIPPED'; reason?: string | null; notifications: number; deliveries: number }>,
  ): Promise<{ claimed: false } | { claimed: true; outcome: 'MATERIALIZED' | 'SKIPPED'; reason: string | null; notifications: number; deliveries: number }> {
    return this.db.transaction(async tx => {
      const claimed = await tx.insert(notificationEventReceipts)
        .values({ eventId: event.id, workspaceId: event.workspaceId, kind: event.kind, outcome: 'MATERIALIZED' })
        .onConflictDoNothing({ target: notificationEventReceipts.eventId })
        .returning({ eventId: notificationEventReceipts.eventId });
      if (!claimed.length) return { claimed: false as const };
      const result = await work(new NotificationStore(tx as unknown as QeyNoxDatabase));
      const reason = result.reason ?? null;
      await tx.update(notificationEventReceipts)
        .set({ outcome: result.outcome, reason, notifications: result.notifications, deliveries: result.deliveries, processedAt: new Date() })
        .where(eq(notificationEventReceipts.eventId, event.id));
      return { claimed: true as const, outcome: result.outcome, reason, notifications: result.notifications, deliveries: result.deliveries };
    });
  }

  /**
   * P13 — moves the scan watermark forward, never backward, to the earlier of (a) the oldest eligible
   * event still lacking a receipt and (b) `now - safetyLagMs`, so an event that commits late with an
   * older occurred_at is still inside the scanned window.
   */
  async advanceEventWatermark(kinds: readonly string[], now: Date, safetyLagMs: number): Promise<void> {
    if (kinds.length === 0) return;
    const [checkpoint] = await this.db.select({ watermark: notificationCheckpoints.watermark }).from(notificationCheckpoints)
      .where(eq(notificationCheckpoints.name, EVENT_CHECKPOINT)).limit(1);
    const [oldest] = await this.db.select({ occurredAt: events.occurredAt }).from(events)
      .where(and(
        inArray(events.kind, [...kinds]),
        checkpoint ? sql`${events.occurredAt} >= ${checkpoint.watermark}` : undefined,
        sql`NOT EXISTS (SELECT 1 FROM notification_event_receipts r WHERE r.event_id = ${events.id})`,
      ))
      .orderBy(asc(events.occurredAt), asc(events.id)).limit(1);
    const lagged = new Date(now.getTime() - safetyLagMs).toISOString();
    const candidate = oldest && oldest.occurredAt < lagged ? oldest.occurredAt : lagged;
    if (checkpoint && checkpoint.watermark >= candidate) return;
    await this.db.insert(notificationCheckpoints).values({ name: EVENT_CHECKPOINT, watermark: candidate, updatedAt: now })
      .onConflictDoUpdate({
        target: notificationCheckpoints.name,
        set: { watermark: sql`GREATEST(${notificationCheckpoints.watermark}, excluded.watermark)`, updatedAt: now },
      });
  }

  async listInbox(userId: string, workspaceId: string, input: { unreadOnly: boolean; before: { createdAt: Date; id: string } | null; take: number }) {
    const conditions = [eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId)];
    if (input.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (input.before) {
      const cursor = input.before;
      const before = or(lt(notifications.createdAt, cursor.createdAt), and(eq(notifications.createdAt, cursor.createdAt), lt(notifications.id, cursor.id)));
      if (before) conditions.push(before);
    }
    const rows = await this.db.select().from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(input.take);
    return rows.map(row => ({
      id: row.id, kind: row.kind, title: row.title, body: row.body,
      operationId: row.operationId, linkPath: row.linkPath,
      readAt: iso(row.readAt), createdAt: row.createdAt.toISOString(),
    }));
  }

  async countUnread(userId: string, workspaceId: string): Promise<number> {
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), isNull(notifications.readAt)));
    return row?.value ?? 0;
  }

  async markRead(userId: string, workspaceId: string, id: string, at: Date): Promise<boolean> {
    const updated = await this.db.update(notifications).set({ readAt: at })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length > 0;
  }

  async markAllRead(userId: string, workspaceId: string, at: Date): Promise<number> {
    const updated = await this.db.update(notifications).set({ readAt: at })
      .where(and(eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  }

  async getPreferenceRows(userId: string): Promise<ReadonlyMap<NotificationKind, boolean>> {
    const rows = await this.db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    return new Map(rows.map(row => [row.category, row.emailEnabled] as const));
  }

  async setPreference(userId: string, category: NotificationKind, emailEnabled: boolean, at: Date): Promise<void> {
    await this.db.insert(notificationPreferences).values({ userId, category, emailEnabled, updatedAt: at })
      .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.category], set: { emailEnabled, updatedAt: at } });
  }

  /**
   * Claims due deliveries inside one transaction. Rows are locked with FOR UPDATE SKIP LOCKED so
   * concurrent drainers never claim the same row, and attempt_count is incremented at claim time:
   * a worker that crashes mid-send still leaves an honest audit trail (an attempt was initiated).
   */
  async claimDue(now: Date, limit: number) {
    return this.db.transaction(async tx => {
      const claimed = await tx.select().from(emailDeliveries)
        .where(and(eq(emailDeliveries.status, 'PENDING'), eq(emailDeliveries.retryable, true), sql`${emailDeliveries.nextRetryAt} <= ${now.toISOString()}`))
        .orderBy(asc(emailDeliveries.nextRetryAt), asc(emailDeliveries.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      const claimedRows = [];
      for (const row of claimed) {
        const [updated] = await tx.update(emailDeliveries)
          .set({ attemptCount: row.attemptCount + 1, updatedAt: now })
          .where(eq(emailDeliveries.id, row.id))
          .returning();
        if (updated) claimedRows.push(updated);
      }
      return claimedRows.map(row => ({
        id: row.id, userId: row.userId, workspaceId: row.workspaceId, category: row.category,
        recipient: row.recipient, subject: row.subject, provider: row.provider, locale: row.locale,
        attemptCount: row.attemptCount, maxAttempts: row.maxAttempts,
        templateId: row.templateId, templateVars: row.templateVars,
        deduplicationKey: row.deduplicationKey, notificationId: row.notificationId,
      }));
    });
  }

  async markSent(id: string, providerMessageId: string | null, at: Date): Promise<void> {
    await this.db.update(emailDeliveries)
      .set({ status: 'SENT', providerMessageId, lastErrorCode: null, sentAt: at, updatedAt: at })
      .where(and(eq(emailDeliveries.id, id), eq(emailDeliveries.status, 'PENDING')));
  }

  async markRetryableFailure(id: string, errorCode: string, nextRetryAt: Date, at: Date): Promise<void> {
    await this.db.update(emailDeliveries)
      .set({ status: 'PENDING', lastErrorCode: errorCode, nextRetryAt, updatedAt: at })
      .where(and(eq(emailDeliveries.id, id), eq(emailDeliveries.status, 'PENDING')));
  }

  async markTerminalFailure(id: string, errorCode: string, at: Date): Promise<void> {
    await this.db.update(emailDeliveries)
      .set({ status: 'FAILED', lastErrorCode: errorCode, updatedAt: at })
      .where(and(eq(emailDeliveries.id, id), eq(emailDeliveries.status, 'PENDING')));
  }
}
