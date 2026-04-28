// v3: Telegram webhook receiver + Channels status/config API.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { chatThreads, companies, emailAccounts, instanceSettings, operatorMessages } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  createTelegramAdapter,
  getTelegramBotInfo,
  getTelegramWebhookInfo,
  setTelegramWebhook,
  deleteTelegramWebhook,
  sendTelegramMessage,
} from "../services/telegram-adapter.js";
import { registerAdapter } from "../services/operator-messaging.js";
import { readInstanceToken, writeInstanceToken, deleteInstanceToken } from "../services/instance-token-store.js";

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

    logger.info({ chatId, fromId, text: msg.text }, "telegram webhook: message received ✓");

    // Validation keyword — lets user confirm the connection is live without creating issues
    if (msg.text.trim().toLowerCase() === "paperclip") {
      res.status(200).json({ ok: true });
      await sendTelegramMessage(BOT_TOKEN, chatId, "✅ Paperclip is connected and receiving messages!");
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
        await sendTelegramMessage(BOT_TOKEN, chatId, "⚠ No agent available to respond.");
        return;
      }

      logger.info({ chatId, agentId, threadId: thread.id }, "telegram webhook: routing to chatDirectReply");

      const startedAt = Date.now();
      const handled = await chatDirectReply(db, companyId, agentId, thread.id, msg.text, {
        platform: "telegram",
        telegramChatId: chatId,
        fromId,
        raw: update,
      });

      // Poll for the outbound reply and send to Telegram (claude takes 15-60s)
      if (handled) {
        const poll = async (attempt: number) => {
          try {
            const messages = await chatService(db).listMessages(companyId, thread.id, 3);
            const outbound = messages.find(
              (m) => m.direction === "outbound" && new Date(m.createdAt).getTime() > startedAt,
            );
            if (outbound?.body) {
              logger.info({ chatId, attempt, elapsedMs: Date.now() - startedAt }, "telegram webhook: sending reply");
              await sendTelegramMessage(BOT_TOKEN, chatId, outbound.body);
              return;
            }
            if (Date.now() - startedAt < 120_000 && attempt < 40) {
              setTimeout(() => poll(attempt + 1), 3_000);
            } else {
              logger.warn({ chatId }, "telegram webhook: reply timeout, no outbound message found");
            }
          } catch (err) {
            logger.warn({ err }, "telegram webhook: poll error");
          }
        };
        setTimeout(() => poll(1), 5_000);
      }
    } catch (err) {
      logger.error({ err, chatId }, "telegram webhook: chat routing failed");
    }
  });

  // ── Telegram bot token (stored encrypted in DB) ──────────────────────────

  router.put("/channels/telegram/token", async (req, res) => {
    assertBoard(req);
    const { token } = req.body as { token?: string };
    if (!token?.trim()) {
      res.status(400).json({ error: "token required" });
      return;
    }
    try {
      await writeInstanceToken(db, "telegramBotToken", token.trim());
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  router.delete("/channels/telegram/token", async (req, res) => {
    assertBoard(req);
    await deleteInstanceToken(db, "telegramBotToken");
    res.json({ ok: true });
  });

  // ── Telegram routing: which company receives messages ────────────────────

  router.put("/channels/telegram/routing", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.body as { companyId: string | null };
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general: { telegramCompanyId: companyId ?? null } })
      .onConflictDoUpdate({
        target: instanceSettings.singletonKey,
        set: {
          general: sql`instance_settings.general || jsonb_build_object('telegramCompanyId', ${companyId ?? null}::text)`,
          updatedAt: new Date(),
        },
      });
    res.json({ ok: true });
  });

  // ── Channels status (board only) ─────────────────────────────────────────

  router.get("/channels/status", async (req, res) => {
    assertBoard(req);

    const telegram = await getTelegramStatus(db);

    // Resolve which company receives Telegram messages
    // Priority: TELEGRAM_COMPANY_ID env var > DB instanceSettings > first company
    let activeCompanyId: string | null = null;
    let routingSource: "env" | "db" | "default" = "default";
    if (telegram.configured) {
      if (COMPANY_ID) {
        activeCompanyId = COMPANY_ID;
        routingSource = "env";
      } else {
        const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
        const dbCompanyId = (settings?.general as Record<string, unknown> | null)?.telegramCompanyId as string | null | undefined;
        if (dbCompanyId) {
          activeCompanyId = dbCompanyId;
          routingSource = "db";
        } else {
          const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
          activeCompanyId = first?.id ?? null;
          routingSource = "default";
        }
      }
    }

    // Email: count configured accounts
    const emailRows = await db.select({ id: emailAccounts.id }).from(emailAccounts);

    res.json({
      telegram: { ...telegram, activeCompanyId, routingSource },
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

  // Recent messages for a channel — used by LogsPanel Channels tab
  router.get("/companies/:companyId/channels/messages", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { platform } = req.query as { platform?: string };
    const companyId = req.params.companyId;

    if (platform === "telegram") {
      const tgThreads = await db
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(and(eq(chatThreads.companyId, companyId), eq(chatThreads.platform, "telegram")));

      if (tgThreads.length === 0) { res.json([]); return; }

      const threadIds = tgThreads.map((t) => t.id);
      const rows = await db
        .select({
          id: operatorMessages.id,
          direction: operatorMessages.direction,
          platform: operatorMessages.platform,
          body: operatorMessages.body,
          chatThreadId: operatorMessages.chatThreadId,
          createdAt: operatorMessages.createdAt,
        })
        .from(operatorMessages)
        .where(and(eq(operatorMessages.companyId, companyId), inArray(operatorMessages.chatThreadId, threadIds)))
        .orderBy(desc(operatorMessages.createdAt))
        .limit(100);
      res.json(rows);
    } else {
      const rows = await db
        .select({
          id: operatorMessages.id,
          direction: operatorMessages.direction,
          platform: operatorMessages.platform,
          body: operatorMessages.body,
          chatThreadId: operatorMessages.chatThreadId,
          createdAt: operatorMessages.createdAt,
        })
        .from(operatorMessages)
        .where(eq(operatorMessages.companyId, companyId))
        .orderBy(desc(operatorMessages.createdAt))
        .limit(100);
      res.json(rows);
    }
  });

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

async function getTelegramStatus(db: Db) {
  // DB token takes priority over env var
  const dbToken = await readInstanceToken(db, "telegramBotToken").catch(() => null);
  const effectiveToken = dbToken || BOT_TOKEN;
  const tokenSource: "db" | "env" | null = dbToken ? "db" : BOT_TOKEN ? "env" : null;

  if (!effectiveToken) {
    return { configured: false, tokenSource: null as null };
  }
  try {
    const [botInfo, webhookInfo] = await Promise.all([
      getTelegramBotInfo(effectiveToken),
      getTelegramWebhookInfo(effectiveToken),
    ]);
    return {
      configured: true,
      tokenSource,
      tokenSet: true,
      operatorChatId: OPERATOR_CHAT_ID || null,
      bot: botInfo,
      webhook: webhookInfo,
    };
  } catch (err) {
    logger.warn({ err }, "telegram: status check failed");
    return { configured: true, tokenSource, tokenSet: true, error: "Could not reach Telegram API" };
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
