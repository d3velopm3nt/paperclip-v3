import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { chatThreads, instanceSettings, operatorMessages } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { chatService } from "../services/chat.js";
import { chatDirectReply, pickAgentForDispatcher } from "../services/chat-direct.js";
import { operatorMessagingService } from "../services/operator-messaging.js";
import { sendWhatsAppMessage } from "../services/whatsapp-adapter.js";
import { readInstanceToken } from "../services/instance-token-store.js";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

export function chatRoutes(db: Db): Router {
  const router = Router();

  // Get-or-create thread — optional agentId/platform body params
  router.post("/companies/:companyId/chat/threads", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { agentId, platform } = (req.body ?? {}) as { agentId?: string; platform?: string };
    const chatSvc = chatService(db);
    let thread;
    if (agentId) {
      thread = await chatSvc.getOrCreateAgentThread(req.params.companyId, agentId);
    } else if (platform === "telegram") {
      // Create a placeholder Telegram inbox thread (no specific external key)
      thread = await chatSvc.getOrCreateTelegramThread(req.params.companyId, "inbox", "Telegram");
    } else {
      thread = await chatSvc.getOrCreateDispatcherThread(req.params.companyId);
    }
    res.json(thread);
  });

  // List all threads for sidebar
  router.get("/companies/:companyId/chat/threads", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const threads = await chatService(db).listThreads(req.params.companyId);
    res.json(threads);
  });

  // List messages for a thread (oldest-first)
  router.get("/companies/:companyId/chat/threads/:threadId/messages", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const messages = await chatService(db).listMessages(
      req.params.companyId,
      req.params.threadId,
    );
    res.json([...messages].reverse());
  });

  // Send a message from the operator
  router.post("/companies/:companyId/chat/messages", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { body, contextRefs, toAgentId } = req.body as {
      body?: string;
      contextRefs?: unknown[];
      toAgentId?: string;
    };
    if (!body || typeof body !== "string" || body.trim() === "") {
      throw new HttpError(400, "body required");
    }

    const companyId = req.params.companyId;
    const chatSvc = chatService(db);
    const thread = toAgentId
      ? await chatSvc.getOrCreateAgentThread(companyId, toAgentId)
      : await chatSvc.getOrCreateDispatcherThread(companyId);

    // Return immediately; reply delivered via WebSocket
    res.json({ ok: true, threadId: thread.id });

    // Determine responding agent
    const agentId =
      toAgentId ?? (await pickAgentForDispatcher(db, companyId, body.trim()));

    if (!agentId) {
      logger.warn({ companyId }, "chat: no agent available to respond");
      return;
    }

    // Try direct Anthropic API reply (no issue created).
    // Falls back to full issue pipeline if agent has no API key.
    chatDirectReply(db, companyId, agentId, thread.id, body.trim(), {
      contextRefs: contextRefs ?? [],
    })
      .then((handled) => {
        if (!handled) {
          // Agent uses subscription auth — fall back to issue pipeline
          return operatorMessagingService(db).handleInbound(companyId, "", {
            platform: "chat",
            from: "operator",
            body: body.trim(),
            threadKey: thread.id,
            toAgentId,
            raw: { contextRefs: contextRefs ?? [] },
          });
        }
      })
      .catch((err) => logger.warn({ err, companyId }, "chat: reply failed"));
  });

  // Operator reply to a specific thread (WhatsApp and future external platforms)
  router.post("/companies/:companyId/chat/threads/:threadId/reply", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { body } = req.body as { body?: string };
    if (!body || typeof body !== "string" || body.trim() === "") {
      throw new HttpError(400, "body required");
    }

    const companyId = req.params.companyId;
    const threadId = req.params.threadId;

    // Verify thread belongs to company
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.companyId, companyId)))
      .limit(1);

    if (!thread) throw new HttpError(404, "thread not found");

    // Store outbound operator message
    const [stored] = await db
      .insert(operatorMessages)
      .values({
        companyId,
        chatThreadId: threadId,
        direction: "outbound",
        platform: thread.platform,
        source: "operator",
        body: body.trim(),
      })
      .returning();

    res.json({ ok: true, messageId: stored?.id });

    // For WhatsApp threads, send the reply to the customer
    if (thread.platform === "whatsapp" && thread.externalKey) {
      const toPhone = thread.externalKey.replace(/^\+/, ""); // Meta API wants no leading +
      const token = await readInstanceToken(db, "whatsappAccessToken").catch(() => null);
      const [settingsRow] = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, "default"))
        .limit(1);
      const phoneNumberId =
        ((settingsRow?.general as Record<string, unknown> | null)?.whatsappPhoneNumberId as string | undefined) ?? "";

      if (token && phoneNumberId) {
        sendWhatsAppMessage(token, phoneNumberId, toPhone, body.trim()).catch((err) =>
          logger.error({ err, toPhone, threadId }, "chat: WhatsApp send failed"),
        );
      } else {
        logger.warn({ threadId }, "chat: WhatsApp reply skipped — token or phoneNumberId not configured");
      }
    }
  });

  return router;
}
