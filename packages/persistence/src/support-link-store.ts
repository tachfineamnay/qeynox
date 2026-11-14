import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ID } from '@qeynox/domain';
import type { QeyNoxDatabase } from './database';
import { identityMemberships, identityUsers, identityWorkspaces } from './identity-schema';
import { supportChatwootLinks } from './support-schema';

export interface SupportLinkRow {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly chatwootContactId: string;
  readonly chatwootConversationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SupportActorProfileRow {
  readonly email: string;
  readonly displayName: string;
  readonly workspaceName: string;
}

function toRow(row: typeof supportChatwootLinks.$inferSelect): SupportLinkRow {
  return {
    id: row.id, userId: row.userId, workspaceId: row.workspaceId,
    chatwootContactId: row.chatwootContactId, chatwootConversationId: row.chatwootConversationId,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/**
 * Mapping-only persistence adapter. It never stores a support message: sending and reading always
 * goes through the external Chatwoot engine. The mapping is what enforces per-user isolation.
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

  async createLink(input: {
    readonly id: ID; readonly userId: ID; readonly workspaceId: ID;
    readonly chatwootContactId: string; readonly chatwootConversationId: string; readonly at: Date;
  }): Promise<SupportLinkRow> {
    const [row] = await this.db.insert(supportChatwootLinks).values({
      id: input.id, userId: input.userId, workspaceId: input.workspaceId,
      chatwootContactId: input.chatwootContactId,
      chatwootConversationId: input.chatwootConversationId,
      createdAt: input.at, updatedAt: input.at,
    }).returning();
    if (!row) throw new Error('Support link insert returned no row');
    return toRow(row);
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
