// v3: clients CRUD + sender-domain matching.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { clientService } from "../services/clients.js";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function clientRoutes(db: Db) {
  const router = Router();
  const svc = clientService(db);

  router.get("/companies/:companyId/clients", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/clients", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as {
      name?: string;
      emailDomain?: string | null;
      extraEmails?: string[];
      trustLevel?: string;
      notes?: string | null;
    };
    if (!body.name || typeof body.name !== "string") throw badRequest("name required");
    const row = await svc.create(companyId, {
      name: body.name,
      emailDomain: body.emailDomain ?? null,
      extraEmails: body.extraEmails,
      trustLevel: body.trustLevel,
      notes: body.notes ?? null,
    });
    res.status(201).json(row);
  });

  router.get("/clients/:id", async (req, res) => {
    const row = await svc.getById(req.params.id);
    if (!row) throw notFound("Client not found");
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  router.patch("/clients/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) throw notFound("Client not found");
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(req.params.id, req.body);
    if (!updated) throw notFound("Client not found");
    res.json(updated);
  });

  router.delete("/clients/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) throw notFound("Client not found");
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(req.params.id);
    res.status(204).send();
  });

  return router;
}
