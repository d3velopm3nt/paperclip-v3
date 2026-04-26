import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { chatService } from "../services/chat.js";
import { operatorMessagingService } from "../services/operator-messaging.js";
import { HttpError } from "../errors.js";

export function chatRoutes(db: Db): Router {
  const router = Router();

  router.post("/companies/:companyId/chat/threads", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const thread = await chatService(db).getOrCreateDispatcherThread(req.params.companyId);
    res.json(thread);
  });

  router.get("/companies/:companyId/chat/threads", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const threads = await chatService(db).listThreads(req.params.companyId);
    res.json(threads);
  });

  router.get("/companies/:companyId/chat/threads/:threadId/messages", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const messages = await chatService(db).listMessages(
      req.params.companyId,
      req.params.threadId,
    );
    res.json([...messages].reverse());
  });

  router.post("/companies/:companyId/chat/messages", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { body, contextRefs } = req.body as { body?: string; contextRefs?: unknown[] };
    if (!body || typeof body !== "string" || body.trim() === "") {
      throw new HttpError(400, "body required");
    }

    const chatSvc = chatService(db);
    const thread = await chatSvc.getOrCreateDispatcherThread(req.params.companyId);

    await operatorMessagingService(db).handleInbound(req.params.companyId, "", {
      platform: "chat",
      from: "operator",
      body: body.trim(),
      threadKey: thread.id,
      raw: { contextRefs: contextRefs ?? [] },
    });

    res.json({ ok: true, threadId: thread.id });
  });

  return router;
}
