// v3: Telegram platform adapter for operator↔agent messaging.
// Uses Telegram Bot API directly (HTTP) — no MCP dependency.

import { logger } from "../middleware/logger.js";
import type { MessagePlatformAdapter, OutboundMessage } from "./operator-messaging.js";

const BASE_URL = "https://api.telegram.org";

async function tgApi(token: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram API error (${method}): ${json.description ?? "unknown"}`);
  }
  return json.result;
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export async function getTelegramBotInfo(token: string): Promise<{
  id: number; username: string; firstName: string;
}> {
  const r = (await tgApi(token, "getMe")) as { id: number; username: string; first_name: string };
  return { id: r.id, username: r.username, firstName: r.first_name };
}

export async function getTelegramWebhookInfo(token: string): Promise<{
  url: string; hasCustomCertificate: boolean; pendingUpdateCount: number;
}> {
  const r = (await tgApi(token, "getWebhookInfo")) as {
    url: string; has_custom_certificate: boolean; pending_update_count: number;
  };
  return { url: r.url, hasCustomCertificate: r.has_custom_certificate, pendingUpdateCount: r.pending_update_count };
}

export async function setTelegramWebhook(token: string, url: string, secret: string): Promise<void> {
  await tgApi(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
}

export async function deleteTelegramWebhook(token: string): Promise<void> {
  await tgApi(token, "deleteWebhook", { drop_pending_updates: false });
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  replyToMessageId?: number,
): Promise<{ messageId: number }> {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  const r = (await tgApi(token, "sendMessage", body)) as { message_id: number };
  return { messageId: r.message_id };
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

export function createTelegramAdapter(token: string, operatorChatId: string): MessagePlatformAdapter {
  return {
    platform: "telegram",

    async send(msg: OutboundMessage): Promise<{ threadKey: string }> {
      const chatId = msg.to[0] ?? operatorChatId;
      try {
        const { messageId } = await sendTelegramMessage(token, chatId, msg.body);
        return { threadKey: chatId };
      } catch (err) {
        logger.error({ err, chatId }, "telegram-adapter: send failed");
        throw err;
      }
    },

    async reply(threadKey: string, body: string): Promise<void> {
      // threadKey = chat_id (we reply into the same chat, no specific message reference)
      const chatId = threadKey.split(":")[0]!;
      try {
        await sendTelegramMessage(token, chatId, body);
      } catch (err) {
        logger.error({ err, chatId }, "telegram-adapter: reply failed");
        throw err;
      }
    },
  };
}
