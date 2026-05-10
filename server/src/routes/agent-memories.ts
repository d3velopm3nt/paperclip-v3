import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { memoryLoaderService } from "../services/agent-runtime/memory-loader.js";
import { assertCompanyAccess, assertBoard } from "./authz.js";

export function agentMemoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryLoaderService(db);

  // Agent self-write: POST /agents/me/memories (called by agent during/after runs)
  router.post("/agents/me/memories", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agentId = req.actor.agentId;
    const companyId = req.actor.companyId;

    const { scope, projectId, category, title, content, confidence } = req.body;
    if (!scope || !category || !title || !content) {
      res.status(400).json({ error: "Missing required fields: scope, category, title, content" });
      return;
    }

    const memory = await svc.saveMemory({
      agentId,
      companyId,
      scope,
      projectId: projectId ?? null,
      category,
      title,
      content,
      source: "self",
      confidence: confidence ?? 0.7,
    });

    res.status(201).json(memory);
  });

  // Agent self-read: GET /agents/me/memories
  router.get("/agents/me/memories", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const scope = req.query.scope as "global" | "project" | undefined;
    const projectId = req.query.projectId as string | undefined;
    const memories = await svc.loadMemories(req.actor.agentId, projectId, { scope });
    res.json(memories);
  });

  async function getAgentCompanyId(agentId: string): Promise<string | null> {
    const [agent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return agent?.companyId ?? null;
  }

  // List memories for an agent
  router.get("/agents/:agentId/memories", async (req, res) => {
    const { agentId } = req.params;
    const companyId = await getAgentCompanyId(agentId);
    // ECC agents have null companyId — board-only access
    if (!companyId) {
      assertBoard(req);
    } else {
      assertCompanyAccess(req, companyId);
    }

    const scope = req.query.scope as "global" | "project" | undefined;
    const projectId = req.query.projectId as string | undefined;
    const category = req.query.category as string | undefined;

    const memories = await svc.loadMemories(agentId, projectId, { scope, category });
    res.json(memories);
  });

  // Create a memory
  router.post("/agents/:agentId/memories", async (req, res) => {
    const { agentId } = req.params;
    const companyId = await getAgentCompanyId(agentId);
    if (!companyId) {
      assertBoard(req);
    } else {
      assertCompanyAccess(req, companyId);
    }

    const { scope, projectId, category, title, content, source, confidence, companyId: bodyCompanyId } = req.body;

    if (!scope || !category || !title || !content || !source) {
      res.status(400).json({ error: "Missing required fields: scope, category, title, content, source" });
      return;
    }

    // ECC agents have null companyId — caller must supply one in the body
    const resolvedCompanyId = companyId ?? bodyCompanyId;
    if (!resolvedCompanyId) {
      res.status(400).json({ error: "companyId required for cross-company agents" });
      return;
    }

    const memory = await svc.saveMemory({
      agentId,
      companyId: resolvedCompanyId,
      scope,
      projectId: projectId ?? null,
      category,
      title,
      content,
      source,
      confidence,
    });

    res.status(201).json(memory);
  });

  // Update a memory
  router.patch("/agents/:agentId/memories/:memoryId", async (req, res) => {
    const { agentId, memoryId } = req.params;
    const companyId = await getAgentCompanyId(agentId);
    if (!companyId) {
      assertBoard(req);
    } else {
      assertCompanyAccess(req, companyId);
    }

    const existing = await svc.getMemory(memoryId);
    if (!existing || existing.agentId !== agentId) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }

    const { title, content, category, confidence } = req.body;
    const updated = await svc.updateMemory(memoryId, {
      ...(title !== undefined && { title }),
      ...(content !== undefined && { content }),
      ...(category !== undefined && { category }),
      ...(confidence !== undefined && { confidence }),
    });

    res.json(updated);
  });

  // Delete a memory
  router.delete("/agents/:agentId/memories/:memoryId", async (req, res) => {
    const { agentId, memoryId } = req.params;
    const companyId = await getAgentCompanyId(agentId);
    if (!companyId) {
      assertBoard(req);
    } else {
      assertCompanyAccess(req, companyId);
    }

    const existing = await svc.getMemory(memoryId);
    if (!existing || existing.agentId !== agentId) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }

    await svc.deleteMemory(memoryId);
    res.json({ ok: true });
  });

  return router;
}
