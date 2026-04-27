import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { chatService } from "../services/chat.js";
import { chatDirectReply, pickAgentForDispatcher } from "../services/chat-direct.js";
import { operatorMessagingService } from "../services/operator-messaging.js";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

export function chatRoutes(db: Db): Router {
  const router = Router();

  // Get-or-create thread — optional agentId body param for DM threads
  router.post("/companies/:companyId/chat/threads", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { agentId } = (req.body ?? {}) as { agentId?: string };
    const chatSvc = chatService(db);
    const thread = agentId
      ? await chatSvc.getOrCreateAgentThread(req.params.companyId, agentId)
      : await chatSvc.getOrCreateDispatcherThread(req.params.companyId);
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

  return router;
}
