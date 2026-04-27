import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { chatService } from "../services/chat.js";
import { operatorMessagingService } from "../services/operator-messaging.js";
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

    const chatSvc = chatService(db);
    const thread = toAgentId
      ? await chatSvc.getOrCreateAgentThread(req.params.companyId, toAgentId)
      : await chatSvc.getOrCreateDispatcherThread(req.params.companyId);

    await operatorMessagingService(db).handleInbound(req.params.companyId, "", {
      platform: "chat",
      from: "operator",
      body: body.trim(),
      threadKey: thread.id,
      toAgentId,
      raw: { contextRefs: contextRefs ?? [] },
    });

    res.json({ ok: true, threadId: thread.id });
  });

  return router;
}
