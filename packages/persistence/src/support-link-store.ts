import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ID } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { identityMemberships, identityUsers, identityWorkspaces } from './identity-schema';
import { supportChatwootLinks, supportIntents } from './support-schema';

export interface SupportLinkRow {
  readonly id: ID;
  readonly userId: ID;
  readonly workspaceId: ID;
  readonly chatwootContactId: string;
  readonly chatwootConversationId: string;
  readonly state: 'ACTIVE' | 'ORPHANED';
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SupportIntentRow {
  readonly id: ID;
  readonly userId: ID;
  readonly workspaceId: ID;
  readonly intentRef: string;
  readonly chatwootContactId: string | null;
  readonly chatwootConversationId: string | null;
  readonly state: 'PENDING_CONTACT' | 'PENDING_CONVERSATION' | 'LINKED' | 'FAILED' | 'ORPHANED';
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SupportActorProfileRow {
  readonly email: string;
  readonly displayName: string;
  readonly workspaceName: string;
}


/** Walks the error/cause chain to find the PostgreSQL error code (drizzle wraps driver errors). */
function pgErrorCode(error: unknown): { code?: string | undefined; constraint?: string | undefined } {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined };
    }
    current = candidate.cause;
  }
  return {};
}

function toRow(row: typeof supportChatwootLinks.$inferSelect): SupportLinkRow {
  return {
    id: row.id as ID, userId: row.userId as ID, workspaceId: row.workspaceId as ID,
    chatwootContactId: row.chatwootContactId, chatwootConversationId: row.chatwootConversationId,
    state: row.state,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}
function toIntent(row: typeof supportIntents.$inferSelect): SupportIntentRow {
  return {
    id: row.id as ID, userId: row.userId as ID, workspaceId: row.workspaceId as ID,
    intentRef: row.intentRef, chatwootContactId: row.chatwootContactId,
    chatwootConversationId: row.chatwootConversationId, state: row.state, failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Mapping-only persistence adapter. It never stores a support message: sending and reading always
 * goes through the external Chatwoot engine. The mapping is what enforces per-user isolation.
 * Intent rows record the deterministic source_id chosen per open request so ambiguous remote writes
 * can be reconciled rather than duplicated; message content is never written here.
 */
export class SupportLinkStore {
  constructor(private readonly db: QeyNoxDatabase) {}

  async findContact(userId: ID, workspaceId: ID): Promise<SupportLinkRow | undefined> {
    const [row] = await this.db.select().from(supportChatwootLinks)
      .where(and(eq(supportChatwootLinks.userId, userId), eq(supportChatwootLinks.workspaceId, workspaceId)))
      .limit(1);
    return row === undefined ? undefined : toRow(row);
  }

  async findConversation(userId: ID, workspaceId: ID, chatwootConversationId: string): Promise<SupportLinkRow | undefined> {
    const [row] = await this.db.select().from(supportChatwootLinks)
      .where(and(
        eq(supportChatwootLinks.userId, userId),
        eq(supportChatwootLinks.workspaceId, workspaceId),
        eq(supportChatwootLinks.chatwootConversationId, chatwootConversationId),
      ))
      .limit(1);
    return row === undefined ? undefined : toRow(row);
  }

  async listForUser(userId: ID, workspaceId: ID): Promise<readonly SupportLinkRow[]> {
    return (await this.db.select().from(supportChatwootLinks)
      .where(and(eq(supportChatwootLinks.userId, userId), eq(supportChatwootLinks.workspaceId, workspaceId)))
      .orderBy(desc(supportChatwootLinks.updatedAt))).map(toRow);
  }

  async listForConversations(conversationIds: readonly string[]): Promise<readonly SupportLinkRow[]> {
    if (!conversationIds.length) return [];
    return (await this.db.select().from(supportChatwootLinks)
      .where(inArray(supportChatwootLinks.chatwootConversationId, [...conversationIds]))).map(toRow);
  }

  /**
   * Conversation ids mapped to more than one distinct (user, workspace) pair. Such a mapping is an
   * isolation breach waiting to happen; callers must fail closed for every side involved.
   */
  async findDuplicatedConversationIds(conversationIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (!conversationIds.length) return new Set();
    const rows = await this.db.select({
      chatwootConversationId: supportChatwootLinks.chatwootConversationId,
      distinctPairs: sql<number>`count(distinct (${supportChatwootLinks.userId}, ${supportChatwootLinks.workspaceId}))`,
    }).from(supportChatwootLinks)
      .where(inArray(supportChatwootLinks.chatwootConversationId, [...conversationIds]))
      .groupBy(supportChatwootLinks.chatwootConversationId);
    return new Set(rows.filter(row => Number(row.distinctPairs) > 1).map(row => row.chatwootConversationId));
  }

  /** Creates the intent-to-create row for one open request; the deterministic source_id lives here. */
  async createIntent(input: {
    readonly id: ID; readonly userId: ID; readonly workspaceId: ID; readonly intentRef: string; readonly at: Date;
  }): Promise<{ readonly created: boolean; readonly intent: SupportIntentRow }> {
    try {
      const [row] = await this.db.insert(supportIntents).values({
        id: input.id, userId: input.userId, workspaceId: input.workspaceId,
        intentRef: input.intentRef, state: 'PENDING_CONTACT',
        createdAt: input.at, updatedAt: input.at,
      }).returning();
      if (!row) throw new Error('Intent insert returned no row');
      return { created: true, intent: toIntent(row) };
    } catch (error: unknown) {
      const { code, constraint } = pgErrorCode(error);
      // Only the scoped intent unique index means "idempotent replay"; any other violation is a real failure.
      if (code === '23505' && (constraint === undefined || constraint === 'support_intents_user_workspace_ref_unique')) {
        const existing = await this.findIntentByRef(input.userId, input.workspaceId, input.intentRef);
        if (existing) return { created: false, intent: existing };
      }
      throw error;
    }
  }

  /** Tenant-scoped intent lookup; an intent_ref is never resolved across tenants. */
  async findIntentByRef(userId: ID, workspaceId: ID, intentRef: string): Promise<SupportIntentRow | undefined> {
    const [row] = await this.db.select().from(supportIntents).where(and(
      eq(supportIntents.userId, userId),
      eq(supportIntents.workspaceId, workspaceId),
      eq(supportIntents.intentRef, intentRef),
    )).limit(1);
    return row === undefined ? undefined : toIntent(row);
  }

  async updateIntent(id: ID, input: {
    readonly state: 'PENDING_CONTACT' | 'PENDING_CONVERSATION' | 'LINKED' | 'FAILED' | 'ORPHANED';
    readonly chatwootContactId?: string | null;
    readonly chatwootConversationId?: string | null;
    readonly failureCode?: string | null;
    readonly at: Date;
  }): Promise<void> {
    await this.db.update(supportIntents).set({
      state: input.state,
      ...(input.chatwootContactId === undefined ? {} : { chatwootContactId: input.chatwootContactId }),
      ...(input.chatwootConversationId === undefined ? {} : { chatwootConversationId: input.chatwootConversationId }),
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      updatedAt: input.at,
    }).where(eq(supportIntents.id, id));
  }

  /**
   * Commits the authorization link and the intent's LINKED transition in one transaction.
   * A concurrent twin committing the same (workspace, user, conversation) mapping loses the unique
   * race and re-reads the winner's row: both callers observe one link, never an error page.
   */
  async createLink(input: {
    readonly id: ID; readonly userId: ID; readonly workspaceId: ID;
    readonly chatwootContactId: string; readonly chatwootConversationId: string; readonly at: Date;
    readonly intentId?: ID | undefined;
  }): Promise<SupportLinkRow> {
    try {
      return await this.db.transaction(async tx => {
        const [row] = await tx.insert(supportChatwootLinks).values({
          id: input.id, userId: input.userId, workspaceId: input.workspaceId,
          chatwootContactId: input.chatwootContactId,
          chatwootConversationId: input.chatwootConversationId,
          state: 'ACTIVE',
          createdAt: input.at, updatedAt: input.at,
        }).returning();
        if (!row) throw new Error('Support link insert returned no row');
        if (input.intentId) {
          await tx.update(supportIntents).set({
            state: 'LINKED', chatwootContactId: input.chatwootContactId,
            chatwootConversationId: input.chatwootConversationId, updatedAt: input.at,
          }).where(eq(supportIntents.id, input.intentId));
        }
        return toRow(row);
      });
    } catch (error: unknown) {
      const { code, constraint } = pgErrorCode(error);
      if (code !== '23505' || (constraint !== undefined && !constraint.includes('conversation'))) throw error;
      const winner = await this.findConversation(input.userId, input.workspaceId, input.chatwootConversationId);
      if (!winner) throw error;
      if (input.intentId) {
        await this.updateIntent(input.intentId, {
          state: 'LINKED', chatwootContactId: input.chatwootContactId,
          chatwootConversationId: input.chatwootConversationId, at: input.at,
        });
      }
      return winner;
    }
  }

  /** Marks the link ORPHANED (remote conversation gone or ambiguous mapping); it stops authorizing access. */
  async markOrphaned(linkId: ID, at: Date): Promise<void> {
    await this.db.update(supportChatwootLinks).set({ state: 'ORPHANED', updatedAt: at }).where(eq(supportChatwootLinks.id, linkId));
  }

  async touch(linkId: ID, at: Date): Promise<void> {
    await this.db.update(supportChatwootLinks).set({ updatedAt: at }).where(eq(supportChatwootLinks.id, linkId));
  }

  /** Display data for creating the Chatwoot contact; never used to bypass workspace authorization. */
  async actorProfile(userId: ID, workspaceId: ID): Promise<SupportActorProfileRow | undefined> {
    const [row] = await this.db.select({
      email: identityUsers.email,
      workspaceName: identityWorkspaces.name,
      membershipStatus: identityMemberships.status,
    }).from(identityUsers)
      .innerJoin(identityMemberships, eq(identityMemberships.userId, identityUsers.id))
      .innerJoin(identityWorkspaces, eq(identityWorkspaces.id, identityMemberships.workspaceId))
      .where(and(
        eq(identityUsers.id, userId),
        eq(identityMemberships.workspaceId, workspaceId),
        eq(identityMemberships.status, 'ACTIVE'),
      ))
      .limit(1);
    if (!row) return undefined;
    return { email: row.email, displayName: row.email.split('@')[0] ?? row.email, workspaceName: row.workspaceName };
  }
}
