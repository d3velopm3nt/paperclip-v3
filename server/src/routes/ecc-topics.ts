import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { eccTopicsService } from "../services/ecc-topics.js";
import { eccConversationsService } from "../services/ecc-conversations.js";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";

const createTopicSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().uuid().nullable().optional(),
});

const updateTopicSchema = z.object({
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  currentState: z.string().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
  companyId: z.string().uuid().nullable().optional(),
});

const linkIssueSchema = z.object({
  issueId: z.string().uuid(),
});

function assertBoard(req: Request): void {
  if (req.actor?.type !== "board") throw forbidden("Board access required");
}

export function eccTopicRoutes(db: Db) {
  const router = Router();
  const svc = eccTopicsService(db);

  router.get("/ecc/topics", async (req, res) => {
    assertBoard(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const topics = await svc.list(status);
    res.json(topics);
  });

  router.post("/ecc/topics", validate(createTopicSchema), async (req, res) => {
    assertBoard(req);
    const topic = await svc.create(req.body);
    res.status(201).json(topic);
  });

  router.get("/ecc/topics/:id", async (req, res) => {
    assertBoard(req);
    const topic = await svc.getById(String(req.params.id));
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.json(topic);
  });

  router.patch("/ecc/topics/:id", validate(updateTopicSchema), async (req, res) => {
    assertBoard(req);
    const topic = await svc.update(String(req.params.id), req.body);
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.json(topic);
  });

  router.delete("/ecc/topics/:id", async (req, res) => {
    assertBoard(req);
    const ok = await svc.remove(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/ecc/topics/:id/issues", validate(linkIssueSchema), async (req, res) => {
    assertBoard(req);
    await svc.linkIssue(String(req.params.id), req.body.issueId);
    res.status(201).json({ ok: true });
  });

  router.delete("/ecc/topics/:id/issues/:issueId", async (req, res) => {
    assertBoard(req);
    await svc.unlinkIssue(String(req.params.id), String(req.params.issueId));
    res.status(204).send();
  });

  // GET /ecc/conversations?all=true — cross-company conversations with topic info
  // Default: active only. ?all=true: all statuses (including expired).
  router.get("/ecc/conversations", async (req, res) => {
    assertBoard(req);
    const convSvc = eccConversationsService(db);
    const showAll = req.query.all === "true";
    const conversations = showAll ? await convSvc.listAll(200) : await convSvc.listAllActive();
    const enriched = await Promise.all(
      conversations.map(async (conv) => {
        const topic = await svc.getById(conv.topicId);
        return {
          ...conv,
          topicName: topic?.name ?? null,
          companyId: topic?.companyId ?? null,
          topicState: topic?.currentState ?? null,
          topicSummary: topic?.summary ?? null,
        };
      }),
    );
    res.json(enriched);
  });

  // GET /ecc/conversations/:id — single conversation with topic info
  router.get("/ecc/conversations/:id", async (req, res) => {
    assertBoard(req);
    const convSvc = eccConversationsService(db);
    const conv = await convSvc.getById(String(req.params.id));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const topic = await svc.getById(conv.topicId);
    res.json({
      ...conv,
      topicName: topic?.name ?? null,
      companyId: topic?.companyId ?? null,
      topicState: topic?.currentState ?? null,
      topicSummary: topic?.summary ?? null,
    });
  });

  return router;
}
