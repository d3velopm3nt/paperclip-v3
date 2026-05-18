import { Router } from "express";
import { eq } from "drizzle-orm";
import { agentTemplates } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { agentTemplatesService } from "../services/agent-templates.js";
import { generateWorkforce } from "../services/workforce-generator.js";
import { assertBoard, assertInstanceAdmin } from "./authz.js";
import { badRequest, conflict, notFound, forbidden } from "../errors.js";

export function agentTemplateRoutes(db: Db): Router {
  const router = Router();
  const svc = agentTemplatesService(db);

  router.get("/agent-templates", async (req, res) => {
    assertBoard(req);
    const templates = await svc.listTemplates();
    res.json(templates);
  });

  router.post("/agent-templates", async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as {
      name: string;
      slug: string;
      description?: string;
      category: string;
      agentDefinitions: Record<string, unknown>[];
      teamStructure: Record<string, unknown>[];
    };
    if (!body.name?.trim() || !body.slug?.trim()) throw badRequest("name and slug are required");
    const existing = await db
      .select({ id: agentTemplates.id })
      .from(agentTemplates)
      .where(eq(agentTemplates.slug, body.slug.trim()))
      .limit(1);
    if (existing[0]) throw conflict("A template with that slug already exists");
    const [created] = await db
      .insert(agentTemplates)
      .values({
        name: body.name.trim(),
        slug: body.slug.trim(),
        description: body.description?.trim() ?? null,
        category: body.category ?? "custom",
        sourceType: "custom",
        agentDefinitions: body.agentDefinitions ?? [],
        teamStructure: body.teamStructure ?? [],
      })
      .returning();
    res.status(201).json(created);
  });

  // Must be registered BEFORE /:id routes to avoid "save-as-template" being matched as an id param
  router.post("/agent-templates/save-as-template", async (req, res) => {
    assertBoard(req);
    const { agentId, subtree, name, slug, description, category } = req.body as {
      agentId: string;
      subtree: boolean;
      name: string;
      slug: string;
      description?: string;
      category: string;
    };
    if (!agentId || !name || !slug) throw badRequest("agentId, name, and slug are required");
    const template = await svc.saveAsTemplate(agentId, {
      subtree: subtree ?? false,
      name,
      slug,
      description,
      category,
    });
    res.status(201).json(template);
  });

  // Must be before /:id routes to avoid "generate" matching as an id param
  router.post("/agent-templates/generate", async (req, res) => {
    assertInstanceAdmin(req);
    const { prompt } = req.body as { prompt?: string };
    if (!prompt?.trim()) throw badRequest("prompt required");
    try {
      const result = await generateWorkforce(prompt.trim());
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "generation failed";
      res.status(500).json({ error: msg });
    }
  });

  router.get("/agent-templates/:id", async (req, res) => {
    assertBoard(req);
    const template = await svc.getTemplate(req.params.id);
    if (!template) throw notFound("agent template");
    res.json(template);
  });

  router.put("/agent-templates/:id", async (req, res) => {
    assertInstanceAdmin(req);
    const updated = await svc.updateTemplate(req.params.id, req.body);
    if (!updated) throw notFound("agent template");
    res.json(updated);
  });

  router.delete("/agent-templates/:id", async (req, res) => {
    assertInstanceAdmin(req);
    try {
      const deleted = await svc.deleteTemplate(req.params.id);
      if (!deleted) throw notFound("agent template");
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === "Built-in templates cannot be deleted") {
        throw forbidden(err.message);
      }
      throw err;
    }
  });

  router.post("/agent-templates/:id/deploy", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.body as { companyId?: string };
    if (!companyId) throw badRequest("companyId is required");
    const template = await svc.getTemplate(req.params.id);
    if (!template) throw notFound("agent template");
    const result = await svc.deployTemplate(req.params.id, companyId);
    res.json(result);
  });

  return router;
}
