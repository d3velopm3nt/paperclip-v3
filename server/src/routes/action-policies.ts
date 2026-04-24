// v3: action policies CRUD + seed defaults.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { actionPolicyService } from "../services/action-policies.js";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function actionPolicyRoutes(db: Db) {
  const router = Router();
  const svc = actionPolicyService(db);

  // GET /api/companies/:companyId/action-policies
  router.get("/companies/:companyId/action-policies", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const policies = await svc.list(companyId);
    res.json(policies);
  });

  // POST /api/companies/:companyId/action-policies
  // Scope defaults to "company" when omitted, with scopeRefId=companyId.
  router.post("/companies/:companyId/action-policies", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as {
      actionType?: string;
      scope?: "company" | "client" | "project" | "agent";
      scopeRefId?: string;
      requiresApproval?: boolean;
      immediateEmail?: boolean;
      paramsJson?: Record<string, unknown>;
    };
    if (!body.actionType || typeof body.actionType !== "string") {
      throw badRequest("actionType required");
    }
    const scope = body.scope ?? "company";
    const scopeRefId = body.scopeRefId ?? (scope === "company" ? companyId : undefined);
    if (!scopeRefId) throw badRequest("scopeRefId required for non-company scope");
    const row = await svc.create(companyId, {
      scope,
      scopeRefId,
      actionType: body.actionType,
      requiresApproval: body.requiresApproval,
      immediateEmail: body.immediateEmail,
      paramsJson: body.paramsJson,
    });
    res.status(201).json(row);
  });

  // POST /api/companies/:companyId/action-policies/seed-defaults
  // Idempotent — inserts any missing defaults, leaves existing rows alone.
  router.post("/companies/:companyId/action-policies/seed-defaults", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    await svc.seedDefaults(companyId);
    const policies = await svc.list(companyId);
    res.json({ seeded: true, policies });
  });

  // PATCH /api/action-policies/:id
  router.patch("/action-policies/:id", async (req, res) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) throw notFound("Action policy not found");
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(id, req.body);
    if (!updated) throw notFound("Action policy not found");
    res.json(updated);
  });

  // DELETE /api/action-policies/:id
  router.delete("/action-policies/:id", async (req, res) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) throw notFound("Action policy not found");
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(id);
    res.status(204).send();
  });

  return router;
}
