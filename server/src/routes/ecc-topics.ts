import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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

  async function enrichConv(conv: Awaited<ReturnType<ReturnType<typeof eccConversationsService>["getById"]>>) {
    if (!conv) return null;
    const topic = await svc.getById(conv.topicId);
    const companyId = topic?.companyId ?? null;
    let companyName: string | null = null;
    if (companyId) {
      const [co] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
      companyName = co?.name ?? null;
    }
    const msgs = (conv.recentMessages ?? []) as Array<{ role: string; content: string; ts: string }>;
    const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
    const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === "assistant");
    return {
      ...conv,
      topicName: topic?.name ?? null,
      companyId,
      companyName,
      topicState: topic?.currentState ?? null,
      topicSummary: topic?.summary ?? null,
      linkedIssues: (topic?.issues ?? []).map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, status: i.status })),
      lastUserMessage: lastUserMsg ? lastUserMsg.content.slice(0, 200) : null,
      lastAssistantMessage: lastAssistantMsg ? lastAssistantMsg.content.slice(0, 200) : null,
    };
  }

  // GET /ecc/conversations?all=true — cross-company conversations with topic info
  // Default: active only. ?all=true: all statuses (including expired).
  router.get("/ecc/conversations", async (req, res) => {
    assertBoard(req);
    const convSvc = eccConversationsService(db);
    const showAll = req.query.all === "true";
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
    const conversations = showAll ? await convSvc.listAll(limit) : await convSvc.listAllActive(limit);
    const enriched = (await Promise.all(conversations.map(enrichConv))).filter(Boolean);
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
    const enriched = await enrichConv(conv);
    res.json(enriched);
  });

  return router;
}
