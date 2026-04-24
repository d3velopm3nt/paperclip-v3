// v3: email inbox API — list/detail for processed inbound mail.
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { emailAccounts, emailAttachments, emailMessages } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { resolveEmailAttachmentsRoot } from "../home-paths.js";

export function emailMessageRoutes(db: Db) {
  const router = Router();

  // GET /api/companies/:companyId/email-messages?state=pending&limit=100
  router.get("/companies/:companyId/email-messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    // email_messages has no companyId — join via email_accounts.
    const accountRows = await db
      .select({ id: emailAccounts.id, label: emailAccounts.label })
      .from(emailAccounts)
      .where(eq(emailAccounts.companyId, companyId));
    if (accountRows.length === 0) {
      res.json([]);
      return;
    }
    const accountIds = accountRows.map((r) => r.id);

    const whereClause = state
      ? and(inArray(emailMessages.emailAccountId, accountIds), eq(emailMessages.processingState, state))
      : inArray(emailMessages.emailAccountId, accountIds);

    const rows = await db
      .select()
      .from(emailMessages)
      .where(whereClause)
      .orderBy(desc(emailMessages.receivedAt))
      .limit(limit);

    const labelByAccount = new Map(accountRows.map((a) => [a.id, a.label]));
    res.json(
      rows.map((r) => ({
        ...r,
        accountLabel: labelByAccount.get(r.emailAccountId) ?? null,
      })),
    );
  });

  // GET /api/email-messages/:id  — includes attachments
  router.get("/email-messages/:id", async (req, res) => {
    const { id } = req.params;
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
    if (!row) throw notFound("Email message not found");
    const [account] = await db
      .select({ id: emailAccounts.id, companyId: emailAccounts.companyId, label: emailAccounts.label })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, row.emailAccountId))
      .limit(1);
    if (!account) throw notFound("Parent email account missing");
    assertCompanyAccess(req, account.companyId);

    const attachments = await db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, id))
      .orderBy(emailAttachments.filename);

    res.json({
      ...row,
      accountLabel: account.label,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        contentId: a.contentId,
        isInline: a.isInline,
        sizeBytes: a.sizeBytes,
      })),
    });
  });

  // GET /api/email-messages/:id/attachments/:attachmentId  — stream the file.
  router.get("/email-messages/:id/attachments/:attachmentId", async (req, res) => {
    const { id, attachmentId } = req.params;
    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
    if (!msg) throw notFound("Email message not found");
    const [account] = await db
      .select({ companyId: emailAccounts.companyId })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, msg.emailAccountId))
      .limit(1);
    if (!account) throw notFound("Parent email account missing");
    assertCompanyAccess(req, account.companyId);

    const [att] = await db
      .select()
      .from(emailAttachments)
      .where(and(eq(emailAttachments.id, attachmentId), eq(emailAttachments.emailMessageId, id)))
      .limit(1);
    if (!att) throw notFound("Attachment not found");

    // Safety: reject if the stored path escaped the attachment root.
    const root = resolveEmailAttachmentsRoot();
    const resolved = path.resolve(att.storagePath);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw badRequest("Attachment path outside storage root");
    }
    if (!existsSync(resolved)) throw notFound("Attachment file missing on disk");

    res.setHeader("Content-Type", att.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(statSync(resolved).size));
    if (!att.isInline) {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(att.filename)}"`);
    }
    createReadStream(resolved).pipe(res);
  });

  return router;
}
