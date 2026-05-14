import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies, operatorMessages, workflowRuns, workflowStageResults } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { topicsService } from "../services/topics.js";
import { eaConversationsService } from "../services/ea-conversations.js";
import { eaAgentsService } from "../services/ea-agents.js";
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

export function eaTopicRoutes(db: Db) {
  const router = Router();
  const svc = topicsService(db);

  router.get("/ea/topics", async (req, res) => {
    assertBoard(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const topics = await svc.list(status);
    res.json(topics);
  });

  router.post("/ea/topics", validate(createTopicSchema), async (req, res) => {
    assertBoard(req);
    const topic = await svc.create(req.body);
    res.status(201).json(topic);
  });

  router.get("/ea/topics/:id", async (req, res) => {
    assertBoard(req);
    const topic = await svc.getById(String(req.params.id));
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.json(topic);
  });

  router.patch("/ea/topics/:id", validate(updateTopicSchema), async (req, res) => {
    assertBoard(req);
    const topic = await svc.update(String(req.params.id), req.body);
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.json(topic);
  });

  router.delete("/ea/topics/:id", async (req, res) => {
    assertBoard(req);
    const ok = await svc.remove(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/ea/topics/:id/issues", validate(linkIssueSchema), async (req, res) => {
    assertBoard(req);
    await svc.linkIssue(String(req.params.id), req.body.issueId);
    res.status(201).json({ ok: true });
  });

  router.delete("/ea/topics/:id/issues/:issueId", async (req, res) => {
    assertBoard(req);
    await svc.unlinkIssue(String(req.params.id), String(req.params.issueId));
    res.status(204).send();
  });

  async function enrichConv(conv: Awaited<ReturnType<ReturnType<typeof eaConversationsService>["getById"]>>) {
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

  // GET /ea/conversations?all=true — cross-company conversations with topic info
  // Default: active only. ?all=true: all statuses (including expired).
  router.get("/ea/conversations", async (req, res) => {
    assertBoard(req);
    const convSvc = eaConversationsService(db);
    const showAll = req.query.all === "true";
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
    const conversations = showAll ? await convSvc.listAll(limit) : await convSvc.listAllActive(limit);
    const enriched = (await Promise.all(conversations.map(enrichConv))).filter(Boolean);
    res.json(enriched);
  });

  // GET /ea/conversations/:id — single conversation with topic info
  router.get("/ea/conversations/:id", async (req, res) => {
    assertBoard(req);
    const convSvc = eaConversationsService(db);
    const conv = await convSvc.getById(String(req.params.id));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const enriched = await enrichConv(conv);
    res.json(enriched);
  });

  router.get("/ea/agents", async (req, res) => {
    assertBoard(req);
    const agentSvc = eaAgentsService(db);
    const eaAgents = await agentSvc.listEaAgents();
    res.json(eaAgents);
  });

  // POST /ea/agents/:id/reset — force agent back to idle and clear stale session (board-only)
  router.post("/ea/agents/:id/reset", async (req, res) => {
    assertBoard(req);
    const agentSvc = eaAgentsService(db);
    await agentSvc.setIdle(req.params.id, { clearSession: true });
    res.json({ ok: true });
  });

  // GET /ea/workflow-runs?agentId=xxx&limit=50
  // Board-only: list workflow runs for a null-companyId EA agent across all companies.
  router.get("/ea/workflow-runs", async (req, res) => {
    assertBoard(req);
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const conditions = agentId ? [eq(workflowRuns.agentId, agentId)] : [];
    const runs = await db
      .select()
      .from(workflowRuns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);
    res.json(runs);
  });

  // GET /ea/workflow-runs/:id — full run with stages (board-only)
  router.get("/ea/workflow-runs/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    const stages = await db
      .select()
      .from(workflowStageResults)
      .where(eq(workflowStageResults.runId, id))
      .orderBy(workflowStageResults.ord);
    res.json({ run, stages });
  });

  // GET /ea/inbound-messages?limit=30 — recent inbound messages with identify status (board-only)
  router.get("/ea/inbound-messages", async (req, res) => {
    assertBoard(req);
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = await db
      .select({
        id: operatorMessages.id,
        platform: operatorMessages.platform,
        body: operatorMessages.body,
        rawPayload: operatorMessages.rawPayload,
        createdAt: operatorMessages.createdAt,
      })
      .from(operatorMessages)
      .where(eq(operatorMessages.direction, "inbound"))
      .orderBy(desc(operatorMessages.createdAt))
      .limit(limit);
    // Filter dismissed client-side (jsonb path filtering is db-vendor specific)
    const visible = rows.filter((r) => !(r.rawPayload as Record<string, unknown> | null)?.dismissed);
    res.json(visible);
  });

  // PATCH /ea/inbound-messages/:id/dismiss — soft-dismiss a message (board-only)
  router.patch("/ea/inbound-messages/:id/dismiss", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const [existing] = await db
      .select({ rawPayload: operatorMessages.rawPayload })
      .from(operatorMessages)
      .where(eq(operatorMessages.id, id))
      .limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    const merged = { ...(existing.rawPayload as Record<string, unknown> | null ?? {}), dismissed: true };
    await db.update(operatorMessages).set({ rawPayload: merged }).where(eq(operatorMessages.id, id));
    res.json({ ok: true });
  });

  return router;
}
