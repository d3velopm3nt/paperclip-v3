// v3: email accounts CRUD API
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { emailAccountService } from "../services/email-accounts.js";

const REQUIRED_CREATE_FIELDS = [
  "label",
  "imapHost",
  "imapPort",
  "imapUser",
  "imapPassword",
  "fromName",
  "fromEmail",
] as const;

// Defense in depth — service already strips imapPasswordEnc but this guarantees
// it never leaks even if a future service method forgets.
function stripPassword<T extends object>(account: T): Omit<T, "imapPasswordEnc"> {
  const { imapPasswordEnc: _enc, ...safe } = account as T & { imapPasswordEnc?: unknown };
  return safe;
}

function validateCreateBody(body: Record<string, unknown>) {
  for (const field of REQUIRED_CREATE_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw badRequest(`Missing required field: ${field}`);
    }
  }
  if (typeof body.imapPort !== "number" || !Number.isInteger(body.imapPort)) {
    throw badRequest("imapPort must be an integer");
  }
}

export function emailAccountRoutes(db: Db) {
  const router = Router();
  const svc = emailAccountService(db);

  // GET /api/companies/:companyId/email-accounts
  router.get("/companies/:companyId/email-accounts", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const accounts = await svc.list(companyId);
    res.json(accounts.map(stripPassword));
  });

  // POST /api/companies/:companyId/email-accounts
  router.post("/companies/:companyId/email-accounts", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    validateCreateBody(req.body as Record<string, unknown>);
    const account = await svc.create(companyId, {
      label: req.body.label,
      imapHost: req.body.imapHost,
      imapPort: req.body.imapPort,
      imapUser: req.body.imapUser,
      imapPassword: req.body.imapPassword,
      imapTls: req.body.imapTls,
      folder: req.body.folder,
      fromName: req.body.fromName,
      fromEmail: req.body.fromEmail,
      replyTo: req.body.replyTo ?? null,
      pollIntervalSec: req.body.pollIntervalSec,
      active: req.body.active,
    });
    res.status(201).json(stripPassword(account));
  });

  // GET /api/email-accounts/:id
  router.get("/email-accounts/:id", async (req, res) => {
    const { id } = req.params;
    const account = await svc.getById(id);
    if (!account) {
      res.status(404).json({ error: "Email account not found" });
      return;
    }
    assertCompanyAccess(req, account.companyId);
    res.json(stripPassword(account));
  });

  // PATCH /api/email-accounts/:id
  router.patch("/email-accounts/:id", async (req, res) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Email account not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(id, {
      label: req.body.label,
      imapHost: req.body.imapHost,
      imapPort: req.body.imapPort,
      imapUser: req.body.imapUser,
      imapPassword: req.body.imapPassword,
      imapTls: req.body.imapTls,
      folder: req.body.folder,
      fromName: req.body.fromName,
      fromEmail: req.body.fromEmail,
      replyTo: req.body.replyTo,
      pollIntervalSec: req.body.pollIntervalSec,
      active: req.body.active,
    });
    res.json(stripPassword(updated));
  });

  // DELETE /api/email-accounts/:id
  router.delete("/email-accounts/:id", async (req, res) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Email account not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await svc.delete(id);
    res.status(204).send();
  });

  // POST /api/email-accounts/:id/test-connection
  router.post("/email-accounts/:id/test-connection", async (req, res) => {
    const { id } = req.params;
    const account = await svc.getById(id);
    if (!account) {
      res.status(404).json({ error: "Email account not found" });
      return;
    }
    assertCompanyAccess(req, account.companyId);
    const result = await svc.testConnection(account);
    res.json(result);
  });

  return router;
}
