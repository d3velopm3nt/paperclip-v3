import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, chatThreads, operatorMessages } from "@paperclipai/db";

export function chatService(db: Db) {
  async function getOrCreateDispatcherThread(companyId: string) {
    const [existing] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.companyId, companyId), isNull(chatThreads.agentId), eq(chatThreads.platform, "web")))
      .limit(1);
    if (existing) return existing;

    const [created] = await db
      .insert(chatThreads)
      .values({ companyId, agentId: null, name: "Dispatcher", platform: "web" })
      .returning();
    return created!;
  }

  async function getOrCreateWhatsAppThread(companyId: string, fromPhone: string, contactName?: string) {
    const [existing] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.companyId, companyId), eq(chatThreads.platform, "whatsapp"), eq(chatThreads.externalKey, fromPhone)))
      .limit(1);
    if (existing) return existing;

    const [created] = await db
      .insert(chatThreads)
      .values({ companyId, agentId: null, name: contactName ?? fromPhone, platform: "whatsapp", externalKey: fromPhone })
      .returning();
    return created!;
  }

  async function getOrCreateTelegramThread(companyId: string, telegramChatId: string, chatTitle?: string) {
    const [existing] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.companyId, companyId), eq(chatThreads.platform, "telegram"), eq(chatThreads.externalKey, telegramChatId)))
      .limit(1);
    if (existing) return existing;

    const [created] = await db
      .insert(chatThreads)
      .values({ companyId, agentId: null, name: chatTitle ?? `Telegram ${telegramChatId}`, platform: "telegram", externalKey: telegramChatId })
      .returning();
    return created!;
  }

  async function getOrCreateAgentThread(companyId: string, agentId: string) {
    const [existing] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.companyId, companyId), eq(chatThreads.agentId, agentId)))
      .limit(1);
    if (existing) return existing;

    const [agentRow] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    const [created] = await db
      .insert(chatThreads)
      .values({ companyId, agentId, name: agentRow?.name ?? "Agent" })
      .returning();
    return created!;
  }

  async function listThreads(companyId: string) {
    const threads = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.companyId, companyId))
      .orderBy(desc(chatThreads.createdAt));

    const dispatcher = threads.filter((t) => t.agentId === null);
    const agentThreads = threads.filter((t) => t.agentId !== null);
    return [...dispatcher, ...agentThreads];
  }

  async function listMessages(companyId: string, threadId: string, limit = 50) {
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.companyId, companyId)))
      .limit(1);

    if (!thread) return [];

    if (thread.agentId === null && thread.platform !== "telegram") {
      // Web dispatcher thread: messages tagged to this thread, or legacy messages with no thread tag
      return db
        .select()
        .from(operatorMessages)
        .where(
          and(
            eq(operatorMessages.companyId, companyId),
            eq(operatorMessages.source, "chat"),
            or(
              eq(operatorMessages.chatThreadId, thread.id),
              isNull(operatorMessages.chatThreadId),
            ),
          ),
        )
        .orderBy(desc(operatorMessages.createdAt))
        .limit(limit);
    }

    // Agent DM thread: all messages that belong to this thread (both inbound and outbound)
    return db
      .select()
      .from(operatorMessages)
      .where(
        and(
          eq(operatorMessages.companyId, companyId),
          eq(operatorMessages.source, "chat"),
          eq(operatorMessages.chatThreadId, thread.id),
        ),
      )
      .orderBy(desc(operatorMessages.createdAt))
      .limit(limit);
  }

  return { getOrCreateDispatcherThread, getOrCreateAgentThread, getOrCreateTelegramThread, getOrCreateWhatsAppThread, listThreads, listMessages };
}
