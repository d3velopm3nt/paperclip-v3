// v3: Telegram webhook receiver + Channels status/config API.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies, emailAccounts } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { assertBoard } from "./authz.js";
import {
  createTelegramAdapter,
  getTelegramBotInfo,
  getTelegramWebhookInfo,
  setTelegramWebhook,
  deleteTelegramWebhook,
  sendTelegramMessage,
} from "../services/telegram-adapter.js";
import { registerAdapter } from "../services/operator-messaging.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const OPERATOR_CHAT_ID = process.env.TELEGRAM_OPERATOR_CHAT_ID ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "paperclip-tg-webhook";
const COMPANY_ID = process.env.TELEGRAM_COMPANY_ID ?? "";

// Called once at startup to register the adapter if token is configured.
export function registerTelegramAdapterIfConfigured(): void {
  if (!BOT_TOKEN) return;
  const adapter = createTelegramAdapter(BOT_TOKEN, OPERATOR_CHAT_ID);
  registerAdapter(adapter);
  logger.info("telegram: adapter registered");
}

export function telegramRoutes(db: Db): Router {
  const router = Router();

  // ── Inbound webhook (called by Telegram, no board auth) ──────────────────

  router.post("/telegram/webhook", async (req, res) => {
    // Validate Telegram secret header
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (secret !== WEBHOOK_SECRET) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const update = req.body as TelegramUpdate;
    const msg = update.message;
    if (!msg?.text) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = String(msg.chat.id);
    const fromId = String(msg.from?.id ?? msg.chat.id);
    const threadKey = chatId;

    // Resolve company: prefer env var, else first company in DB
    let companyId = COMPANY_ID;
    if (!companyId) {
      const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
      companyId = first?.id ?? "";
    }
    if (!companyId) {
      logger.warn("telegram webhook: no company found, dropping message");
      res.status(200).json({ ok: true });
      return;
    }

    // Route through chat system — creates a Telegram thread and replies via chatDirectReply
    res.status(200).json({ ok: true }); // Respond to Telegram immediately

    const { chatService } = await import("../services/chat.js");
    const { chatDirectReply, pickAgentForDispatcher } = await import("../services/chat-direct.js");

    try {
      const chatTitle = msg.chat.title ?? msg.chat.first_name ?? `Telegram ${chatId}`;
      const thread = await chatService(db).getOrCreateTelegramThread(companyId, chatId, chatTitle);

      const agentId = await pickAgentForDispatcher(db, companyId, msg.text);
      if (!agentId) {
        logger.warn({ companyId, chatId }, "telegram webhook: no agent available");
        return;
      }

      const handled = await chatDirectReply(db, companyId, agentId, thread.id, msg.text, {
        platform: "telegram",
        telegramChatId: chatId,
        fromId,
        raw: update,
      });

      // Send the reply back to Telegram
      if (handled) {
        // Response will be emitted via WebSocket live event; also send to Telegram
        // We hook into the outbound message via a short poll of the thread
        setTimeout(async () => {
          try {
            const { chatService: cs } = await import("../services/chat.js");
            const messages = await cs(db).listMessages(companyId, thread.id, 1);
            const latest = messages[0];
            if (latest?.direction === "outbound" && latest.body) {
              await sendTelegramMessage(BOT_TOKEN, chatId, latest.body);
            }
          } catch (err) {
            logger.warn({ err }, "telegram webhook: failed to send reply");
          }
        }, 3000);
      }
    } catch (err) {
      logger.error({ err, chatId }, "telegram webhook: chat routing failed");
    }
  });

  // ── Channels status (board only) ─────────────────────────────────────────

  router.get("/channels/status", async (req, res) => {
    assertBoard(req);

    const telegram = await getTelegramStatus();

    // Email: count configured accounts
    const emailRows = await db.select({ id: emailAccounts.id }).from(emailAccounts);

    res.json({
      telegram,
      email: { configured: emailRows.length > 0, accountCount: emailRows.length },
    });
  });

  // ── Register telegram webhook ────────────────────────────────────────────

  router.post("/channels/telegram/webhook", async (req, res) => {
    assertBoard(req);
    if (!BOT_TOKEN) {
      res.status(422).json({ error: "TELEGRAM_BOT_TOKEN not configured" });
      return;
    }
    const { url } = req.body as { url?: string };
    if (!url) {
      res.status(400).json({ error: "url required" });
      return;
    }
    const webhookUrl = `${url.replace(/\/$/, "")}/api/telegram/webhook`;
    try {
      await setTelegramWebhook(BOT_TOKEN, webhookUrl, WEBHOOK_SECRET);
      res.json({ ok: true, webhookUrl });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  // ── Delete telegram webhook (fall back to polling) ───────────────────────

  router.delete("/channels/telegram/webhook", async (req, res) => {
    assertBoard(req);
    if (!BOT_TOKEN) {
      res.status(422).json({ error: "TELEGRAM_BOT_TOKEN not configured" });
      return;
    }
    await deleteTelegramWebhook(BOT_TOKEN);
    res.json({ ok: true });
  });

  // ── Send test message ────────────────────────────────────────────────────

  router.post("/channels/telegram/test", async (req, res) => {
    assertBoard(req);
    if (!BOT_TOKEN || !OPERATOR_CHAT_ID) {
      res.status(422).json({ error: "TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID required" });
      return;
    }
    try {
      await sendTelegramMessage(BOT_TOKEN, OPERATOR_CHAT_ID, "✅ Paperclip test message — channel is working.");
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getTelegramStatus() {
  if (!BOT_TOKEN) {
    return { configured: false };
  }
  try {
    const [botInfo, webhookInfo] = await Promise.all([
      getTelegramBotInfo(BOT_TOKEN),
      getTelegramWebhookInfo(BOT_TOKEN),
    ]);
    return {
      configured: true,
      operatorChatId: OPERATOR_CHAT_ID || null,
      bot: botInfo,
      webhook: webhookInfo,
    };
  } catch (err) {
    logger.warn({ err }, "telegram: status check failed");
    return { configured: true, error: "Could not reach Telegram API" };
  }
}

// ─── Telegram update shape (minimal) ─────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string; title?: string; first_name?: string };
    text?: string;
    date: number;
  };
}
