import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { sendTelegramMessage, sendTelegramChatAction } from "./telegram-adapter.js";
import { chatService } from "./chat.js";
import { chatDirectReply, pickAgentForDispatcher } from "./chat-direct.js";
import { logActivity } from "./activity-log.js";
import { readInstanceToken } from "./instance-token-store.js";
import { logger } from "../middleware/logger.js";

const BASE_URL = "https://api.telegram.org";

async function tgGet(token: string, method: string, params: Record<string, unknown> = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${BASE_URL}/bot${token}/${method}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string; error_code?: number };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? "unknown"} (code ${json.error_code})`);
  return json.result;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; first_name?: string };
  text?: string;
  date: number;
}

interface Update {
  update_id: number;
  message?: TelegramMessage;
}

declare const global: { __tgPollingActive?: boolean };

export async function startTelegramPolling(db: Db, envToken: string, companyId?: string): Promise<void> {
  if (global.__tgPollingActive) return;
  global.__tgPollingActive = true;

  // Resolve token: DB (encrypted) takes priority over env var
  async function resolveToken(): Promise<string> {
    const dbToken = await readInstanceToken(db, "telegramBotToken");
    return dbToken || envToken;
  }

  const initialToken = await resolveToken();

  // Delete any existing webhook so polling works
  try {
    await tgGet(initialToken, "deleteWebhook", { drop_pending_updates: "false" });
    logger.info("telegram-polling: webhook deleted, starting long poll");
  } catch {
    // ignore
  }

  let offset = 0;

  async function resolveCompanyId(): Promise<string> {
    if (companyId) return companyId; // env var TELEGRAM_COMPANY_ID — hard override
    // Check DB routing setting
    const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
    const dbCompanyId = (settings?.general as Record<string, unknown> | null)?.telegramCompanyId as string | null | undefined;
    if (dbCompanyId) return dbCompanyId;
    // Fallback: first company in DB
    const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
    return first?.id ?? "";
  }

  async function handleMessage(msg: TelegramMessage, resolvedCompanyId: string, resolvedToken: string) {
    if (!msg.text) return;
    const chatId = String(msg.chat.id);

    logger.info({ chatId, text: msg.text }, "telegram-polling: message received ✓");

    if (msg.text.trim().toLowerCase() === "paperclip") {
      await sendTelegramMessage(resolvedToken, chatId, "✅ Paperclip is connected and receiving messages!");
      return;
    }

    const chatTitle = msg.chat.title ?? msg.chat.first_name ?? `Telegram ${chatId}`;
    const thread = await chatService(db).getOrCreateTelegramThread(resolvedCompanyId, chatId, chatTitle);
    const agentId = await pickAgentForDispatcher(db, resolvedCompanyId, msg.text);

    // Log inbound Telegram message so it appears in LogsPanel Activity tab
    void logActivity(db, {
      companyId: resolvedCompanyId,
      actorType: "system",
      actorId: chatId,
      action: "telegram.message.inbound",
      entityType: "chat_thread",
      entityId: thread.id,
      agentId: agentId ?? undefined,
      details: { chatId, chatTitle, text: msg.text.slice(0, 500) },
    });

    if (!agentId) {
      logger.warn({ chatId }, "telegram-polling: no agent available");
      await sendTelegramMessage(resolvedToken, chatId, "⚠ No agent available to respond.");
      return;
    }

    // Show "typing…" in Telegram while agent processes (lasts 5s, refresh every 4s)
    void sendTelegramChatAction(resolvedToken, chatId);
    let typingActive = true;
    const typingInterval = setInterval(() => {
      if (typingActive) void sendTelegramChatAction(resolvedToken, chatId);
    }, 4_000);

    const startedAt = Date.now();
    const handled = await chatDirectReply(db, resolvedCompanyId, agentId, thread.id, msg.text, {
      platform: "telegram", telegramChatId: chatId,
    });
    typingActive = false;
    clearInterval(typingInterval);

    if (!handled) return;

    // Poll DB for outbound reply and send to Telegram
    const poll = async (attempt: number) => {
      try {
        const messages = await chatService(db).listMessages(resolvedCompanyId, thread.id, 3);
        const outbound = messages.find(
          (m) => m.direction === "outbound" && new Date(m.createdAt).getTime() > startedAt,
        );
        if (outbound?.body) {
          logger.info({ chatId, elapsedMs: Date.now() - startedAt }, "telegram-polling: sending reply");
          await sendTelegramMessage(resolvedToken, chatId, outbound.body);
          return;
        }
        if (Date.now() - startedAt < 120_000 && attempt < 40) {
          setTimeout(() => poll(attempt + 1), 3_000);
        } else {
          logger.warn({ chatId }, "telegram-polling: reply timeout");
        }
      } catch (err) {
        logger.warn({ err }, "telegram-polling: reply poll error");
      }
    };
    setTimeout(() => poll(1), 5_000);
  }

  const poll = async () => {
    if (!global.__tgPollingActive) return;
    try {
      const token = await resolveToken();
      const updates = (await tgGet(token, "getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: "message",
      })) as Update[];

      const resolvedCompanyId = await resolveCompanyId();
      if (!resolvedCompanyId) {
        logger.warn("telegram-polling: no company found, retrying in 10s");
        setTimeout(poll, 10_000);
        return;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message, resolvedCompanyId, token).catch((err) =>
            logger.warn({ err }, "telegram-polling: message handler error"),
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is409 = msg.includes("409") || msg.includes("Conflict") || msg.includes("terminated by other");
      if (is409) {
        // Another getUpdates is still in flight (e.g. previous server process hot-reload).
        // Telegram's long-poll timeout is 25s, so wait 30s to guarantee the other request is dead.
        logger.warn("telegram-polling: 409 conflict — another poller still running, waiting 30s");
        setTimeout(poll, 30_000);
      } else {
        logger.warn({ err }, "telegram-polling: getUpdates error, retrying in 5s");
        setTimeout(poll, 5_000);
      }
      return;
    }
    // Immediately poll again (long polling — 25s timeout means we wait up to 25s per request)
    setImmediate(poll);
  };

  // Start polling
  poll();
  logger.info("telegram-polling: started");
}

export function stopTelegramPolling() {
  global.__tgPollingActive = false;
}
