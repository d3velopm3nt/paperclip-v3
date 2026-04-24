// v3: plan-gate decision endpoints + read helpers.
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, emailAccounts, plans } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { planGateService } from "../services/plan-gate.js";

export function planRoutes(db: Db) {
  const router = Router();
  const svc = planGateService(db);

  // GET /api/companies/:companyId/plans?decision=pending
  router.get("/companies/:companyId/plans", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const decision = typeof req.query.decision === "string" ? req.query.decision : null;
    const whereClause = decision
      ? and(eq(plans.companyId, companyId), eq(plans.decision, decision))
      : eq(plans.companyId, companyId);
    const rows = await db
      .select()
      .from(plans)
      .where(whereClause)
      .orderBy(desc(plans.proposedAt))
      .limit(200);
    res.json(rows);
  });

  // GET /api/plans/:id — includes linked approval row.
  router.get("/plans/:id", async (req, res) => {
    const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
    if (!plan) throw notFound("Plan not found");
    assertCompanyAccess(req, plan.companyId);
    const [approval] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.planId, plan.id), eq(approvals.type, "plan")))
      .limit(1);
    res.json({ ...plan, approval: approval ?? null });
  });

  // POST /api/plans/:id/decision { decision: 'approved'|'rejected'|'revision_requested', note? }
  router.post("/plans/:id/decision", async (req, res) => {
    const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
    if (!plan) throw notFound("Plan not found");
    assertCompanyAccess(req, plan.companyId);
    const body = req.body as { decision?: string; note?: string };
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected" && decision !== "revision_requested") {
      throw badRequest("decision must be approved | rejected | revision_requested");
    }
    const actor = (req as { actor?: { userId?: string } }).actor;
    await svc.recordDecision(plan.id, decision, actor?.userId ?? null, body.note);
    const [updated] = await db.select().from(plans).where(eq(plans.id, plan.id)).limit(1);
    res.json(updated);
  });

  return router;
}
