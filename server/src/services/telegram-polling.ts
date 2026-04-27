import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { sendTelegramMessage } from "./telegram-adapter.js";
import { chatService } from "./chat.js";
import { chatDirectReply, pickAgentForDispatcher } from "./chat-direct.js";
import { logger } from "../middleware/logger.js";

const BASE_URL = "https://api.telegram.org";

async function tgGet(token: string, method: string, params: Record<string, unknown> = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${BASE_URL}/bot${token}/${method}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const json = (await res.json()) as { ok: boolean; result?: unknown };
  if (!json.ok) throw new Error(`Telegram ${method} failed`);
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

let pollingActive = false;

export async function startTelegramPolling(db: Db, token: string, companyId?: string): Promise<void> {
  if (pollingActive) return;
  pollingActive = true;

  // Delete any existing webhook so polling works
  try {
    await tgGet(token, "deleteWebhook", { drop_pending_updates: "false" });
    logger.info("telegram-polling: webhook deleted, starting long poll");
  } catch {
    // ignore
  }

  let offset = 0;

  async function resolveCompanyId(): Promise<string> {
    if (companyId) return companyId;
    const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
    return first?.id ?? "";
  }

  async function handleMessage(msg: TelegramMessage, resolvedCompanyId: string) {
    if (!msg.text) return;
    const chatId = String(msg.chat.id);

    logger.info({ chatId, text: msg.text }, "telegram-polling: message received ✓");

    if (msg.text.trim().toLowerCase() === "paperclip") {
      await sendTelegramMessage(token, chatId, "✅ Paperclip is connected and receiving messages!");
      return;
    }

    const chatTitle = msg.chat.title ?? msg.chat.first_name ?? `Telegram ${chatId}`;
    const thread = await chatService(db).getOrCreateTelegramThread(resolvedCompanyId, chatId, chatTitle);
    const agentId = await pickAgentForDispatcher(db, resolvedCompanyId, msg.text);

    if (!agentId) {
      logger.warn({ chatId }, "telegram-polling: no agent available");
      await sendTelegramMessage(token, chatId, "⚠ No agent available to respond.");
      return;
    }

    const startedAt = Date.now();
    const handled = await chatDirectReply(db, resolvedCompanyId, agentId, thread.id, msg.text, {
      platform: "telegram", telegramChatId: chatId,
    });

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
          await sendTelegramMessage(token, chatId, outbound.body);
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
    if (!pollingActive) return;
    try {
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
          handleMessage(update.message, resolvedCompanyId).catch((err) =>
            logger.warn({ err }, "telegram-polling: message handler error"),
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "telegram-polling: getUpdates error, retrying in 5s");
      setTimeout(poll, 5_000);
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
  pollingActive = false;
}
