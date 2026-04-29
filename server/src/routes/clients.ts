// v3: clients CRUD + sender-domain matching.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { clientService } from "../services/clients.js";
import { contactService } from "../services/contacts.js";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function clientRoutes(db: Db) {
  const router = Router();
  const svc = clientService(db);
  const contactSvc = contactService(db);

  router.get("/companies/:companyId/clients", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  // Team = contacts belonging to isMyCompany clients
  router.get("/companies/:companyId/team", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const allClients = await svc.list(companyId);
    const myCompanyIds = allClients.filter((c) => c.isMyCompany).map((c) => c.id);
    if (myCompanyIds.length === 0) { res.json([]); return; }
    const all = await contactSvc.list(companyId);
    res.json(all.filter((c) => c.clientId && myCompanyIds.includes(c.clientId)));
  });

  router.post("/companies/:companyId/clients", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as {
      name?: string;
      emailDomain?: string | null;
      extraEmails?: string[];
      trustLevel?: string;
      isMyCompany?: boolean;
      notes?: string | null;
    };
    if (!body.name || typeof body.name !== "string") throw badRequest("name required");
    const row = await svc.create(companyId, {
      name: body.name,
      emailDomain: body.emailDomain ?? null,
      extraEmails: body.extraEmails,
      trustLevel: body.trustLevel,
      isMyCompany: body.isMyCompany ?? false,
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

  // ── Contacts sub-resource ────────────────────────────────────────────────

  router.get("/clients/:clientId/contacts", async (req, res) => {
    const client = await svc.getById(req.params.clientId);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    const all = await contactSvc.list(client.companyId);
    res.json(all.filter((c) => c.clientId === client.id));
  });

  router.post("/clients/:clientId/contacts", async (req, res) => {
    const client = await svc.getById(req.params.clientId);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    const body = req.body as { email?: string; firstName?: string | null; lastName?: string | null; phone?: string | null; role?: string | null; notes?: string | null };
    if (!body.email) throw badRequest("email required");
    const row = await contactSvc.upsertByEmail(client.companyId, body.email, client.id);
    if (body.firstName !== undefined || body.lastName !== undefined || body.role !== undefined) {
      const updated = await contactSvc.update(client.companyId, row.id, { firstName: body.firstName, lastName: body.lastName, role: body.role, phone: body.phone, notes: body.notes });
      res.status(201).json(updated ?? row);
    } else {
      res.status(201).json(row);
    }
  });

  router.patch("/contacts/:contactId", async (req, res) => {
    const body = req.body as { firstName?: string | null; lastName?: string | null; phone?: string | null; role?: string | null; notes?: string | null };
    // resolve companyId from contact's clientId
    const allContacts = await contactSvc.list(""); // need to find by id across companies — use search
    // Direct DB lookup via contactSvc.getById requires companyId. Use a workaround: find from actor's companies.
    const actor = (req as unknown as { actor?: { companyIds?: string[] } }).actor;
    const companyIds: string[] = actor?.companyIds ?? [];
    let found = null;
    for (const cid of companyIds) {
      const c = await contactSvc.getById(cid, req.params.contactId);
      if (c) { found = c; break; }
    }
    if (!found) throw notFound("Contact not found");
    assertCompanyAccess(req, found.companyId);
    const updated = await contactSvc.update(found.companyId, req.params.contactId, body);
    if (!updated) throw notFound("Contact not found");
    res.json(updated);
  });

  router.delete("/contacts/:contactId", async (req, res) => {
    const actor = (req as unknown as { actor?: { companyIds?: string[] } }).actor;
    const companyIds: string[] = actor?.companyIds ?? [];
    let found = null;
    for (const cid of companyIds) {
      const c = await contactSvc.getById(cid, req.params.contactId);
      if (c) { found = c; break; }
    }
    if (!found) throw notFound("Contact not found");
    assertCompanyAccess(req, found.companyId);
    await contactSvc.remove(found.companyId, req.params.contactId);
    res.status(204).send();
  });

  return router;
}
