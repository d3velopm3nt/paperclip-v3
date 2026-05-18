// v3: workflow viewer API — list runs by source + fetch full run with stages.
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { workflowEngine } from "../services/workflow-engine.js";
import { inboundEmailWorkflow } from "../services/workflows/inbound-email.js";

const KNOWN_WORKFLOWS = {
  inbound_email: inboundEmailWorkflow,
} as const;

export function workflowRunRoutes(db: Db) {
  const router = Router();
  const engine = workflowEngine(db);

  // GET /api/companies/:companyId/workflow-runs?type=inbound_email&limit=50
  // Lists ALL recent workflow runs for a company. Used by the workflows index
  // page so operators can see every email's pipeline without drilling in.
  router.get("/companies/:companyId/workflow-runs", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const type = typeof req.query.type === "string" ? req.query.type : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const conditions = [eq(workflowRuns.companyId, companyId)];
    if (type) conditions.push(eq(workflowRuns.workflowType, type));
    if (status) conditions.push(eq(workflowRuns.overallStatus, status));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(where)
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);
    res.json(rows);
  });

  // GET /api/workflow-runs/by-source/:workflowType/:sourceId?limit=10
  router.get("/workflow-runs/by-source/:workflowType/:sourceId", async (req, res) => {
    const { workflowType, sourceId } = req.params;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const runs = await engine.listRuns(workflowType, sourceId, limit);
    if (runs.length > 0) assertCompanyAccess(req, runs[0]!.companyId);
    res.json(runs);
  });

  // POST /api/workflow-runs/:workflowType/:sourceId/run
  // Manually re-evaluate the workflow against the source.
  router.post("/workflow-runs/:workflowType/:sourceId/run", async (req, res) => {
    const { workflowType, sourceId } = req.params;
    const def = (KNOWN_WORKFLOWS as Record<string, typeof inboundEmailWorkflow>)[workflowType];
    if (!def) throw badRequest(`Unknown workflow type: ${workflowType}`);
    const result = await engine.runWorkflow(def, sourceId);
    if (!result) {
      res.status(204).end();
      return;
    }
    const { run, stages } = await engine.getRun(result.runId);
    if (!run) throw notFound("Run not found after creation");
    assertCompanyAccess(req, run.companyId);
    res.status(201).json({ run, stages });
  });

  // GET /api/workflow-runs/:id
  router.get("/workflow-runs/:id", async (req, res) => {
    const { id } = req.params;
    const { run, stages } = await engine.getRun(id);
    if (!run) throw notFound("Workflow run not found");
    assertCompanyAccess(req, run.companyId);
    res.json({ run, stages });
  });

  return router;
}

void workflowRuns; // type import retained for future filtering helpers
