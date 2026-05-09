import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { eccConversations } from "@paperclipai/db";
import type { ConversationMessage } from "@paperclipai/db";

export type { ConversationMessage };

export interface EccConversation {
  id: string;
  topicId: string;
  status: string;
  startedAt: Date;
  lastMessageAt: Date;
  expiresAt: Date;
  messageCount: number;
  recentMessages: ConversationMessage[];
  createdAt: Date;
}

const WINDOW_DAYS = 14;
const MAX_RECENT = 20;

export function eccConversationsService(db: Db) {
  async function resolveActive(topicId: string): Promise<EccConversation> {
    const now = new Date();
    const existing = await db
      .select()
      .from(eccConversations)
      .where(
        and(
          eq(eccConversations.topicId, topicId),
          eq(eccConversations.status, "active"),
          gt(eccConversations.expiresAt, now),
        ),
      )
      .orderBy(desc(eccConversations.lastMessageAt))
      .limit(1);

    if (existing[0]) {
      const newExpiry = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
      const [updated] = await db
        .update(eccConversations)
        .set({
          lastMessageAt: now,
          expiresAt: newExpiry,
          messageCount: sql`${eccConversations.messageCount} + 1`,
        })
        .where(eq(eccConversations.id, existing[0].id))
        .returning();
      return updated as EccConversation;
    }

    const expiresAt = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
    const [created] = await db
      .insert(eccConversations)
      .values({
        topicId,
        status: "active",
        startedAt: now,
        lastMessageAt: now,
        expiresAt,
        messageCount: 1,
        recentMessages: [],
      })
      .returning();
    return created as EccConversation;
  }

  async function appendMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    if (!content.trim()) return;
    const rows = await db
      .select({ recentMessages: eccConversations.recentMessages })
      .from(eccConversations)
      .where(eq(eccConversations.id, conversationId))
      .limit(1);
    if (!rows[0]) return;

    const existing = (rows[0].recentMessages as ConversationMessage[]) ?? [];
    const newMsg: ConversationMessage = {
      role,
      content: content.slice(0, 2000),
      ts: new Date().toISOString(),
    };
    const updated = [...existing, newMsg].slice(-MAX_RECENT);

    await db
      .update(eccConversations)
      .set({ recentMessages: updated })
      .where(eq(eccConversations.id, conversationId));
  }

  async function extend(conversationId: string, extraDays = WINDOW_DAYS): Promise<EccConversation> {
    const rows = await db
      .select({ expiresAt: eccConversations.expiresAt })
      .from(eccConversations)
      .where(eq(eccConversations.id, conversationId))
      .limit(1);
    if (!rows[0]) throw new Error(`Conversation ${conversationId} not found`);

    const base = rows[0].expiresAt > new Date() ? rows[0].expiresAt : new Date();
    const newExpiry = new Date(base.getTime() + extraDays * 86_400_000);
    const [updated] = await db
      .update(eccConversations)
      .set({ expiresAt: newExpiry, status: "extended" })
      .where(eq(eccConversations.id, conversationId))
      .returning();
    return updated as EccConversation;
  }

  async function expire(conversationId: string): Promise<void> {
    await db
      .update(eccConversations)
      .set({ status: "expired" })
      .where(eq(eccConversations.id, conversationId));
  }

  async function list(topicId: string): Promise<EccConversation[]> {
    return db
      .select()
      .from(eccConversations)
      .where(eq(eccConversations.topicId, topicId))
      .orderBy(desc(eccConversations.lastMessageAt)) as Promise<EccConversation[]>;
  }

  async function getById(id: string): Promise<EccConversation | null> {
    const rows = await db
      .select()
      .from(eccConversations)
      .where(eq(eccConversations.id, id))
      .limit(1);
    return (rows[0] as EccConversation) ?? null;
  }

  async function listAllActive(limit = 100): Promise<EccConversation[]> {
    const now = new Date();
    return db
      .select()
      .from(eccConversations)
      .where(
        and(
          eq(eccConversations.status, "active"),
          gt(eccConversations.expiresAt, now),
        ),
      )
      .orderBy(desc(eccConversations.lastMessageAt))
      .limit(limit) as Promise<EccConversation[]>;
  }

  async function listAll(limit = 100): Promise<EccConversation[]> {
    return db
      .select()
      .from(eccConversations)
      .orderBy(desc(eccConversations.lastMessageAt))
      .limit(limit) as Promise<EccConversation[]>;
  }

  return { resolveActive, appendMessage, extend, expire, list, getById, listAllActive, listAll };
}
