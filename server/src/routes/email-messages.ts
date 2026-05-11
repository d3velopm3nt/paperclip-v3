// v3: email inbox API — list/detail for processed inbound mail.
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { emailAccounts, emailAttachments, emailMessages, issueComments, issues, agentWakeupRequests } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { resolveEmailAttachmentsRoot } from "../home-paths.js";
import { emailProcessorService } from "../services/email-processor.js";
import { fileAttachmentToClientFolder } from "../services/client-storage.js";

export function emailMessageRoutes(db: Db) {
  const router = Router();

  // GET /api/companies/:companyId/email-messages?state=pending&accountRole=inbound&limit=100
  router.get("/companies/:companyId/email-messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const accountRole = typeof req.query.accountRole === "string" ? req.query.accountRole : null;
    const matchedAgentId = typeof req.query.matchedAgentId === "string" ? req.query.matchedAgentId : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    // email_messages has no companyId — join via email_accounts.
    const accountQuery = db
      .select({ id: emailAccounts.id, label: emailAccounts.label, role: emailAccounts.role })
      .from(emailAccounts)
      .where(
        accountRole
          ? and(eq(emailAccounts.companyId, companyId), eq(emailAccounts.role, accountRole))
          : eq(emailAccounts.companyId, companyId),
      );
    const accountRows = await accountQuery;
    if (accountRows.length === 0) {
      res.json([]);
      return;
    }
    const accountIds = accountRows.map((r) => r.id);

    const whereClause = and(
      inArray(emailMessages.emailAccountId, accountIds),
      ...(state ? [eq(emailMessages.processingState, state)] : []),
      ...(matchedAgentId ? [eq(emailMessages.matchedAgentId, matchedAgentId)] : []),
    );

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

  // GET /api/companies/:companyId/issues/:issueId/emails — emails linked to an issue (with attachments)
  router.get("/companies/:companyId/issues/:issueId/emails", async (req, res) => {
    const { companyId, issueId } = req.params;
    assertCompanyAccess(req, companyId);
    const accountIds = (await db.select({ id: emailAccounts.id }).from(emailAccounts)
      .where(eq(emailAccounts.companyId, companyId))).map((r) => r.id);
    if (accountIds.length === 0) { res.json([]); return; }

    const msgs = await db.select().from(emailMessages)
      .where(and(inArray(emailMessages.emailAccountId, accountIds), eq(emailMessages.issueId, issueId)))
      .orderBy(desc(emailMessages.receivedAt));

    const result = await Promise.all(msgs.map(async (msg) => {
      const attachments = await db.select().from(emailAttachments)
        .where(eq(emailAttachments.emailMessageId, msg.id))
        .orderBy(emailAttachments.filename);
      return { ...msg, attachments };
    }));
    res.json(result);
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
        filedAt: a.filedAt?.toISOString() ?? null,
        filedPath: a.filedPath ?? null,
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
    // ?preview=true or inline attachments → serve inline so browser can render
    const isPreview = req.query.preview === "true" || att.isInline;
    if (!isPreview) {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(att.filename)}"`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(att.filename)}"`);
    }
    createReadStream(resolved).pipe(res);
  });

  // GET /api/email-messages/:id/html — sanitized HTML body with cid: refs replaced.
  router.get("/email-messages/:id/html", async (req, res) => {
    const { id } = req.params;
    const [msg] = await db
      .select({ htmlBody: emailMessages.htmlBody, emailAccountId: emailMessages.emailAccountId })
      .from(emailMessages)
      .where(eq(emailMessages.id, id))
      .limit(1);
    if (!msg) throw notFound("Email message not found");
    const [account] = await db
      .select({ companyId: emailAccounts.companyId })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, msg.emailAccountId))
      .limit(1);
    if (!account) throw notFound("Parent email account missing");
    assertCompanyAccess(req, account.companyId);

    if (!msg.htmlBody) {
      res.json({ html: null });
      return;
    }

    // Replace cid: references with API URLs so inline images render
    const inlineAtts = await db
      .select({ id: emailAttachments.id, contentId: emailAttachments.contentId })
      .from(emailAttachments)
      .where(and(eq(emailAttachments.emailMessageId, id), eq(emailAttachments.isInline, true)));

    let html = msg.htmlBody;
    for (const att of inlineAtts) {
      if (att.contentId) {
        const cid = att.contentId.replace(/^<|>$/g, "");
        const url = `/api/email-messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(att.id)}?preview=true`;
        html = html.replaceAll(`cid:${cid}`, url);
      }
    }

    res.json({ html });
  });

  // PATCH /api/email-messages/:id — link to an issue (issueId)
  router.patch("/email-messages/:id", async (req, res) => {
    const { id } = req.params;
    const [msg] = await db.select({ id: emailMessages.id, emailAccountId: emailMessages.emailAccountId })
      .from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
    if (!msg) throw notFound("Email message not found");
    const [account] = await db.select({ companyId: emailAccounts.companyId })
      .from(emailAccounts).where(eq(emailAccounts.id, msg.emailAccountId)).limit(1);
    if (!account) throw notFound("Parent email account missing");
    assertCompanyAccess(req, account.companyId);

    const prevMsg = await db.select({ issueId: emailMessages.issueId, fromAddr: emailMessages.fromAddr, subject: emailMessages.subject })
      .from(emailMessages).where(eq(emailMessages.id, id)).limit(1).then((r) => r[0]);

    const patch: Record<string, unknown> = {};
    if ("issueId" in req.body) patch.issueId = req.body.issueId ?? null;
    if ("approvalId" in req.body) patch.approvalId = req.body.approvalId ?? null;

    const [updated] = await db.update(emailMessages).set(patch).where(eq(emailMessages.id, id)).returning();

    // When issueId is set, auto-post a comment so the agent sees the linked email + attachments
    const newIssueId = typeof patch.issueId === "string" ? patch.issueId : null;
    if (newIssueId) {
      const atts = await db.select({ filename: emailAttachments.filename, contentType: emailAttachments.contentType, storagePath: emailAttachments.storagePath, isInline: emailAttachments.isInline, sizeBytes: emailAttachments.sizeBytes })
        .from(emailAttachments)
        .where(and(eq(emailAttachments.emailMessageId, id), eq(emailAttachments.isInline, false)));

      const attLines = atts.map((a) => `  - ${a.filename} (${(a.sizeBytes / 1024).toFixed(0)} KB) → \`${a.storagePath}\``).join("\n");
      const commentBody = [
        `📧 **Email linked:** "${prevMsg?.subject || "(no subject)"}"`,
        `**From:** ${prevMsg?.fromAddr || "unknown"}`,
        atts.length > 0
          ? `\n**${atts.length} attachment${atts.length !== 1 ? "s" : ""} on disk:**\n${attLines}`
          : "\nNo attachments.",
        `\nUse \`list_issue_emails\` MCP tool to query these from the agent.`,
      ].join("\n");

      await db.insert(issueComments).values({
        issueId: newIssueId,
        companyId: account.companyId,
        body: commentBody,
        authorAgentId: null,
      }).catch(() => {});

      // Unblock issue — if blocked, set back to in_progress and create wakeup request
      const [blockedIssue] = await db
        .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
        .from(issues)
        .where(and(eq(issues.id, newIssueId), eq(issues.status, "blocked")))
        .limit(1);
      if (blockedIssue) {
        await db.update(issues)
          .set({ status: "in_progress", updatedAt: new Date() })
          .where(eq(issues.id, newIssueId))
          .catch(() => {});
        if (blockedIssue.assigneeAgentId) {
          await db.insert(agentWakeupRequests).values({
            companyId: account.companyId,
            agentId: blockedIssue.assigneeAgentId,
            source: "assignment",
            triggerDetail: "email_linked",
            reason: "issue_unblocked",
            payload: { issueId: newIssueId },
            status: "pending",
          }).catch(() => {});
        }
      }
    }

    res.json(updated);
  });

  // DELETE /api/email-messages/:id — removes the email and all derived
  // history (plans, approvals, tokens, workflow runs, wakeup requests, and
  // the linked triage issue + comments if no other email references it).
  // Use with care; intended for clearing corrupt test data.
  router.delete("/email-messages/:id", async (req, res) => {
    const { id } = req.params;
    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
    if (!msg) throw notFound("Email message not found");
    const [account] = await db
      .select({ companyId: emailAccounts.companyId })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, msg.emailAccountId))
      .limit(1);
    if (!account) throw notFound("Parent email account missing");
    assertCompanyAccess(req, account.companyId);

    const result = await emailProcessorService(db).deleteWithHistory(id);
    res.json(result);
  });

  // POST /api/email-messages/:id/reprocess — resets state + re-runs routing.
  router.post("/email-messages/:id/reprocess", async (req, res) => {
    const { id } = req.params;
    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
    if (!msg) throw notFound("Email message not found");
    const [account] = await db
      .select({ companyId: emailAccounts.companyId })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, msg.emailAccountId))
      .limit(1);
    if (!account) throw notFound("Parent email account missing");
    assertCompanyAccess(req, account.companyId);

    try {
      await emailProcessorService(db).reprocess(id);
    } catch (err) {
      throw badRequest(
        `Reprocess failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const [updated] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
    res.json(updated);
  });

  // POST /api/email-messages/:id/attachments/:attachmentId/file
  // Manually file an attachment to a chosen folder (Drive folder ID or local path).
  router.post("/email-messages/:id/attachments/:attachmentId/file", async (req, res) => {
    const { id, attachmentId } = req.params;
    const { driveFolderId, localPath, clientId } = req.body as {
      driveFolderId?: string;
      localPath?: string;
      clientId?: string;
    };

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

    const root = resolveEmailAttachmentsRoot();
    const resolved = path.resolve(att.storagePath);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw badRequest("Attachment path outside storage root");
    if (!existsSync(resolved)) throw notFound("Attachment file missing on disk");

    if (clientId) {
      // File via client folder logic (handles both Drive and local)
      await fileAttachmentToClientFolder(db, att.storagePath, att.filename, clientId, "emails", att.id);
    } else if (driveFolderId) {
      // File to an arbitrary Drive folder
      const { getAuthenticatedDriveClient } = await import("../services/gdrive-auth.js");
      const drive = await getAuthenticatedDriveClient(db);
      if (!drive) { res.status(422).json({ error: "Google Drive not connected" }); return; }
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(resolved);
      const result = await drive.files.create({
        requestBody: { name: att.filename, parents: [driveFolderId] },
        media: { body: Buffer.from(content) },
        fields: "id",
      });
      const filedPath = result.data.id ? `drive:${result.data.id}` : `drive:${driveFolderId}/${att.filename}`;
      await db.update(emailAttachments).set({ filedAt: new Date(), filedPath }).where(eq(emailAttachments.id, att.id));
    } else if (localPath) {
      const { mkdir, copyFile } = await import("node:fs/promises");
      await mkdir(localPath, { recursive: true });
      const dest = path.join(localPath, att.filename);
      await copyFile(resolved, dest);
      await db.update(emailAttachments).set({ filedAt: new Date(), filedPath: dest }).where(eq(emailAttachments.id, att.id));
    } else {
      throw badRequest("Provide driveFolderId, localPath, or clientId");
    }

    const [updatedAtt] = await db.select().from(emailAttachments).where(eq(emailAttachments.id, att.id)).limit(1);
    res.json({
      id: updatedAtt!.id,
      filedAt: updatedAtt!.filedAt?.toISOString() ?? null,
      filedPath: updatedAtt!.filedPath ?? null,
    });
  });

  return router;
}
