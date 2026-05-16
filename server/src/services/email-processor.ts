// v3: parses raw IMAP RFC-822 bytes → email_messages + email_attachments rows,
// saves attachment blobs to the filesystem. Pure of IMAP — takes Buffer in,
// returns the inserted message id.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  blockedSenderDomains,
  emailAccounts,
  emailMessages,
  emailAttachments,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { saveAttachment } from "./attachment-storage.js";
import { ensureClientFolder, fileAttachmentToClientFolder, hasStorageRoot, notifyStorageNotConfigured } from "./client-storage.js";
import { clientService } from "./clients.js";
import { contactService } from "./contacts.js";
import { issueService } from "./issues.js";
import { sendEmailFromAccount } from "./email-sender.js";
import { workflowEngine } from "./workflow-engine.js";
import { inboundEmailWorkflow } from "./workflows/inbound-email.js";
import { logger } from "../middleware/logger.js";
import { routeInboundMessage } from "./inbound-router.js";

export interface ProcessEmailInput {
  emailAccountId: string;
  rawBytes: Buffer;
  // If caller already knows the IMAP INTERNALDATE it can override the parsed Date
  fallbackReceivedAt?: Date;
}

export interface ProcessEmailResult {
  emailMessageId: string;
  duplicated: boolean;
  attachmentCount: number;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractEmailAddresses(input: unknown): string[] {
  if (!input) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.flatMap((v) => extractEmailAddresses(v));
  if (typeof input === "object") {
    const obj = input as { value?: Array<{ address?: string }>; address?: string };
    if (Array.isArray(obj.value)) {
      return obj.value.map((v) => v.address).filter((v): v is string => !!v);
    }
    if (typeof obj.address === "string") return [obj.address];
  }
  return [];
}

export function emailProcessorService(db: Db) {
  async function processRawMessage(input: ProcessEmailInput): Promise<ProcessEmailResult> {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(input.rawBytes);

    const messageIdHeader = parsed.messageId ?? `<no-id-${Date.now()}@paperclip>`;
    const inReplyToHeader = (parsed.inReplyTo ?? null) || null;
    const referencesHeaders = asArray(parsed.references).filter((s): s is string => typeof s === "string");
    const fromAddr = extractEmailAddresses(parsed.from)[0] ?? "";
    const toAddrs = extractEmailAddresses(parsed.to);
    const subject = parsed.subject ?? "";
    const body = parsed.text ?? parsed.html ?? "";
    const htmlBody = typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : null;
    const receivedAt = parsed.date ?? input.fallbackReceivedAt ?? new Date();

    // Dedup check — unique index on (emailAccountId, messageIdHeader) would
    // throw, but a pre-check gives us a clean duplicated=true return instead
    // of noisy error logs.
    const existing = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.emailAccountId, input.emailAccountId),
          eq(emailMessages.messageIdHeader, messageIdHeader),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { emailMessageId: existing[0].id, duplicated: true, attachmentCount: 0 };
    }

    const [inserted] = await db
      .insert(emailMessages)
      .values({
        emailAccountId: input.emailAccountId,
        messageIdHeader,
        inReplyToHeader,
        referencesHeaders,
        fromAddr,
        toAddrs,
        subject,
        body: typeof body === "string" ? body : "",
        htmlBody: htmlBody ?? null,
        receivedAt,
        rawHeaders: Object.fromEntries(parsed.headers ?? []) as Record<string, unknown>,
      })
      .returning();

    // Build attachment list. Some senders omit a text part and send a single-part
    // message where the whole email IS the attachment (no multipart wrapper). In
    // that case mailparser leaves parsed.attachments empty and exposes the content
    // only through the top-level Content-Type header. We synthesise a synthetic
    // attachment entry so the file is always saved regardless of MIME structure.
    const attachments = asArray(parsed.attachments);
    const topCtHeader = parsed.headers.get("content-type");
    const topCt = (typeof topCtHeader === "string" ? topCtHeader : (topCtHeader as { value?: string } | undefined)?.value ?? "").toLowerCase();
    if (
      attachments.length === 0 &&
      topCt &&
      !topCt.startsWith("text/") &&
      !topCt.startsWith("multipart/")
    ) {
      const rawBody = input.rawBytes;
      // Extract base64 payload after the blank-line header/body separator.
      const sep = rawBody.indexOf("\r\n\r\n");
      const payloadStr = sep !== -1 ? rawBody.slice(sep + 4).toString("ascii").replace(/\s/g, "") : "";
      if (payloadStr) {
        const decoded = Buffer.from(payloadStr, "base64");
        const ext = topCt.split("/")[1]?.split(";")[0]?.trim() ?? "bin";
        const guessedName = subject ? `${subject}.${ext}` : `attachment.${ext}`;
        attachments.push({
          content: decoded,
          filename: guessedName,
          contentType: topCt.split(";")[0]?.trim() ?? topCt,
          contentDisposition: "attachment",
          cid: undefined,
          headers: new Map(),
          checksum: "",
          size: decoded.length,
          related: false,
          type: "attachment",
        } as (typeof attachments)[number]);
      }
    }

    let attachmentCount = 0;
    const savedAttachmentNames: string[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      const raw = att.content;
      // Accept Buffer or any typed array (Uint8Array subtype, e.g. from edge-case parsers).
      const content: Buffer | null = Buffer.isBuffer(raw)
        ? raw
        : (raw as unknown) instanceof Uint8Array
          ? Buffer.from(raw as unknown as Uint8Array)
          : null;
      if (!content || content.length === 0) {
        logger.debug(
          { emailMessageId: inserted!.id, filename: att.filename, contentType: att.contentType },
          "email-processor: skipped attachment — no buffer content",
        );
        continue;
      }
      const rawName = att.filename ?? `attachment-${i + 1}`;
      // Prefix with index to avoid intra-message filename collisions.
      const filename = `${String(i + 1).padStart(2, "0")}-${rawName}`;
      try {
        const saved = saveAttachment({
          emailMessageId: inserted!.id,
          filename,
          content,
        });
        await db.insert(emailAttachments).values({
          emailMessageId: inserted!.id,
          filename: rawName,
          contentType: att.contentType ?? "application/octet-stream",
          contentId: att.cid ?? null,
          isInline: att.contentDisposition === "inline",
          sizeBytes: saved.sizeBytes,
          storagePath: saved.storagePath,
        });
        attachmentCount++;
        savedAttachmentNames.push(rawName);
      } catch (err) {
        logger.warn(
          { err, emailMessageId: inserted!.id, filename: rawName },
          "Failed to save email attachment",
        );
      }
    }

    if (attachmentCount > 0) {
      // Record a per-message folder hint (human convenience).
      const folder = `${inserted!.id}`;
      await db
        .update(emailMessages)
        .set({ attachmentsPath: folder })
        .where(eq(emailMessages.id, inserted!.id));
    }

    // v3: route inbound email through the unified orchestrator.
    // Failures here don't discard the email; the row stays at pending.
    try {
      const [emailAccount] = await db
        .select({ companyId: emailAccounts.companyId, triageAgentId: emailAccounts.triageAgentId })
        .from(emailAccounts)
        .where(eq(emailAccounts.id, input.emailAccountId))
        .limit(1);

      let eaRouted = false;
      let ingestClientId: string | null = null;
      if (emailAccount) {
        // Self-loop guard: skip emails from our own agent_voice accounts.
        const ownVoice = await db
          .select({ fromEmail: emailAccounts.fromEmail })
          .from(emailAccounts)
          .where(and(eq(emailAccounts.companyId, emailAccount.companyId), eq(emailAccounts.role, "agent_voice")));
        const ownSet = new Set(ownVoice.map((r) => r.fromEmail.toLowerCase()));
        if (ownSet.has(fromAddr.toLowerCase())) {
          await db.update(emailMessages).set({
            processingState: "ignored",
            matchedCompanyId: emailAccount.companyId,
            processedAt: new Date(),
            errorText: `Self-loop: from=${fromAddr} is one of our agent_voice accounts.`,
          }).where(eq(emailMessages.id, inserted!.id));
          logger.info({ emailMessageId: inserted!.id, fromAddr }, "email-processor: ignored self-loop email");
        } else {
          // Spam check: silently discard emails from blocked sender domains.
          const senderDomain = fromAddr.split("@")[1]?.toLowerCase() ?? "";
          if (senderDomain) {
            const [blocked] = await db
              .select({ id: blockedSenderDomains.id })
              .from(blockedSenderDomains)
              .where(and(
                eq(blockedSenderDomains.companyId, emailAccount.companyId),
                eq(blockedSenderDomains.domain, senderDomain),
              ))
              .limit(1);
            if (blocked) {
              await db.update(emailMessages).set({
                processingState: "ignored",
                matchedCompanyId: emailAccount.companyId,
                processedAt: new Date(),
                errorText: `Blocked domain: ${senderDomain}`,
              }).where(eq(emailMessages.id, inserted!.id));
              logger.info({ emailMessageId: inserted!.id, senderDomain }, "email-processor: discarded email from blocked domain");
              return { emailMessageId: inserted!.id, duplicated: false, attachmentCount };
            }
          }

          // Fire-and-forget: warn operator once/day if no storage root configured.
          void hasStorageRoot(db, emailAccount.companyId).then((has) => {
            if (!has) void notifyStorageNotConfigured(db, emailAccount.companyId);
          });

          // Synchronous client match — stamp matchedClientId immediately so attachment
          // filing and folder creation work even when EA handles the email async.
          try {
            let clientRec = await clientService(db).matchByEmail(emailAccount.companyId, fromAddr);
            if (!clientRec) {
              const domain = fromAddr.split("@")[1]?.toLowerCase() ?? "";
              if (domain) {
                const name = domain.split(".").slice(0, -1).join(".") || domain;
                clientRec = await clientService(db).create(emailAccount.companyId, {
                  name: name.charAt(0).toUpperCase() + name.slice(1),
                  emailDomain: domain,
                });
                logger.info({ companyId: emailAccount.companyId, emailMessageId: inserted!.id, domain }, "email-processor: auto-created client stub on ingest");
              }
            }
            if (clientRec) {
              ingestClientId = clientRec.id;
              await db.update(emailMessages)
                .set({ matchedClientId: clientRec.id, matchedCompanyId: emailAccount.companyId })
                .where(eq(emailMessages.id, inserted!.id));
              ensureClientFolder(db, clientRec.id).catch(() => {});
            }
          } catch (err) {
            logger.warn({ err, emailMessageId: inserted!.id }, "email-processor: ingest client match failed");
          }

          // EA routing: if the account's triage agent is an EA, skip the
          // orchestrator and wake the EA directly with { emailMessageId }.
          if (emailAccount.triageAgentId) {
            const [triageAgentRow] = await db
              .select({ adapterType: agents.adapterType })
              .from(agents)
              .where(eq(agents.id, emailAccount.triageAgentId))
              .limit(1);
            if (triageAgentRow?.adapterType === "ea") {
              // EA agents have companyId=null, so bypass heartbeatService budget
              // check and insert the wakeup request directly with the email
              // account's companyId so the EA knows which inbox triggered it.
              await db.insert(agentWakeupRequests).values({
                companyId: emailAccount.companyId,
                agentId: emailAccount.triageAgentId,
                source: "assignment",
                triggerDetail: "system",
                reason: "email-triage",
                payload: { emailMessageId: inserted!.id },
                status: "queued",
                requestedByActorType: "system",
                requestedByActorId: "email-processor",
              });
              await db.update(emailMessages).set({
                matchedCompanyId: emailAccount.companyId,
                matchedAgentId: emailAccount.triageAgentId,
                processingState: "analyzing",
              }).where(eq(emailMessages.id, inserted!.id));
              logger.info(
                { emailMessageId: inserted!.id, triageAgentId: emailAccount.triageAgentId },
                "email-processor: EA triage — woke EA, skipped issue creation",
              );
              eaRouted = true;
            }
          }
          if (!eaRouted) {
            await routeInboundMessage(db, {
              companyId: emailAccount.companyId,
              platform: "email",
              fromAddr,
              body: typeof body === "string" ? body : "",
              subject,
              threadKey: messageIdHeader,
              attachmentSummaries: savedAttachmentNames,
            });
          }
        }
      }

      // File attachments to client folder (fire-and-forget, non-fatal)
      if (attachmentCount > 0 && ingestClientId) {
        const clientId = ingestClientId;
        ensureClientFolder(db, clientId)
          .then(() =>
            db.select({ id: emailAttachments.id, storagePath: emailAttachments.storagePath, filename: emailAttachments.filename })
              .from(emailAttachments)
              .where(eq(emailAttachments.emailMessageId, inserted!.id))
          )
          .then((atts) => {
            for (const att of atts) {
              void fileAttachmentToClientFolder(db, att.storagePath, att.filename, clientId, "Emails", att.id);
            }
          }).catch(() => {});
      }

      // Workflow eval is for inbound triage only. Agent-voice replies and
      // other non-triage paths set matchedAgentId/issueId by other means.
      // Skip workflow for self-loop emails (ignored by routeInbound loop guard).
      const [acctState] = await db
        .select({ role: emailAccounts.role, processingState: emailMessages.processingState })
        .from(emailAccounts)
        .innerJoin(emailMessages, eq(emailMessages.id, inserted!.id))
        .where(eq(emailAccounts.id, input.emailAccountId))
        .limit(1);
      if (!eaRouted && acctState?.role === "inbound" && acctState?.processingState !== "ignored") {
        workflowEngine(db).runFireAndForget(inboundEmailWorkflow, inserted!.id);
      }
    } catch (err) {
      logger.warn(
        { err, emailMessageId: inserted!.id },
        "email-processor: route/propose failed, leaving message in pending",
      );
      await db
        .update(emailMessages)
        .set({
          processingState: "error",
          errorText: (err as Error).message.slice(0, 1000),
          processedAt: new Date(),
        })
        .where(eq(emailMessages.id, inserted!.id));
    }

    return {
      emailMessageId: inserted!.id,
      duplicated: false,
      attachmentCount,
    };
  }

  async function deleteWithHistory(emailMessageId: string): Promise<{
    deletedPlans: number;
    deletedWorkflowRuns: number;
    deletedComments: number;
    deletedIssue: boolean;
  }> {
    const [email] = await db
      .select({ id: emailMessages.id, issueId: emailMessages.issueId })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);
    if (!email) throw new Error(`email not found: ${emailMessageId}`);

    const {
      approvals,
      approvalComments,
      plans,
      planDecisionTokens,
      workflowRuns,
      agentWakeupRequests,
      issueComments,
      issues,
    } = await import("@paperclipai/db");
    const { sql } = await import("drizzle-orm");

    return db.transaction(async (tx) => {
      // 1. Plans referencing this email — collect ids first.
      const planRows = await tx
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.sourceEmailMessageId, emailMessageId));
      const planIds = planRows.map((r) => r.id);

      // 2. Approvals + their comments + plan_decision_tokens (tokens cascade
      //    with plans, but explicit delete keeps the order safe). Approval
      //    comments do NOT cascade, so they have to come down first.
      if (planIds.length > 0) {
        await tx.delete(planDecisionTokens).where(inArray(planDecisionTokens.planId, planIds));
        const approvalRows = await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(inArray(approvals.planId, planIds));
        const approvalIds = approvalRows.map((r) => r.id);
        if (approvalIds.length > 0) {
          await tx.delete(approvalComments).where(inArray(approvalComments.approvalId, approvalIds));
        }
        // Detach email_messages.approval_id (no cascade) so the approval delete
        // doesn't blow up on a sibling email pointing at the same approval.
        if (approvalIds.length > 0) {
          await tx
            .update(emailMessages)
            .set({ approvalId: null })
            .where(inArray(emailMessages.approvalId, approvalIds));
        }
        await tx.delete(approvals).where(inArray(approvals.planId, planIds));
        await tx.delete(plans).where(inArray(plans.id, planIds));
      }

      // 3. Workflow runs for this source — cascade drops stage results.
      const runs = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(eq(workflowRuns.sourceId, emailMessageId));
      if (runs.length > 0) {
        await tx.delete(workflowRuns).where(eq(workflowRuns.sourceId, emailMessageId));
      }

      // 4. Agent wakeup requests that reference this email or its triage issue.
      //    heartbeat_runs has FK → agent_wakeup_requests (no cascade), so
      //    nullify heartbeat_runs.wakeup_request_id first.
      const { heartbeatRuns: hbRuns } = await import("@paperclipai/db");
      const wakeupIdRows = await tx
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          email.issueId
            ? sql`${agentWakeupRequests.payload}->>'emailMessageId' = ${emailMessageId} OR ${agentWakeupRequests.payload}->>'issueId' = ${email.issueId}`
            : sql`${agentWakeupRequests.payload}->>'emailMessageId' = ${emailMessageId}`,
        );
      const wakeupIds = wakeupIdRows.map((r) => r.id);
      if (wakeupIds.length > 0) {
        await tx
          .update(hbRuns)
          .set({ wakeupRequestId: null })
          .where(inArray(hbRuns.wakeupRequestId, wakeupIds));
        await tx.delete(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeupIds));
      }

      // 5. Triage issue cleanup — delete only if no OTHER emails reference
      //    this issue (avoid orphaning a thread someone still needs).
      let deletedIssue = false;
      let deletedComments = 0;
      if (email.issueId) {
        // Detach this email first so the orphan check is honest.
        await tx
          .update(emailMessages)
          .set({ issueId: null })
          .where(eq(emailMessages.id, emailMessageId));

        const otherEmails = await tx
          .select({ id: emailMessages.id })
          .from(emailMessages)
          .where(eq(emailMessages.issueId, email.issueId));
        if (otherEmails.length === 0) {
          const cs = await tx
            .delete(issueComments)
            .where(eq(issueComments.issueId, email.issueId))
            .returning({ id: issueComments.id });
          deletedComments = cs.length;
          await tx.delete(issues).where(eq(issues.id, email.issueId));
          deletedIssue = true;
        }
      }

      // 6. Finally, delete the email row (cascades email_attachments).
      await tx.delete(emailMessages).where(eq(emailMessages.id, emailMessageId));

      logger.info(
        { emailMessageId, deletedPlans: planIds.length, deletedRuns: runs.length, deletedIssue, deletedComments },
        "email-processor: deleted with history",
      );
      return {
        deletedPlans: planIds.length,
        deletedWorkflowRuns: runs.length,
        deletedComments,
        deletedIssue,
      };
    });
  }

  async function reprocess(emailMessageId: string): Promise<void> {
    const [row] = await db
      .select({
        id: emailMessages.id,
        emailAccountId: emailMessages.emailAccountId,
        fromAddr: emailMessages.fromAddr,
        toAddrs: emailMessages.toAddrs,
        subject: emailMessages.subject,
        body: emailMessages.body,
        messageIdHeader: emailMessages.messageIdHeader,
      })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);
    if (!row) throw new Error(`email not found: ${emailMessageId}`);

    // Reset state — clear prior linkage so routing starts fresh.
    // Plans/approvals/issues are left in place for the audit trail.
    await db
      .update(emailMessages)
      .set({
        processingState: "pending",
        errorText: null,
        processedAt: null,
        issueId: null,
        approvalId: null,
        matchedAgentId: null,
        matchedClientId: null,
        matchedCompanyId: null,
      })
      .where(eq(emailMessages.id, emailMessageId));

    // Clear old attachment filing status — re-filed fresh this run.
    await db
      .update(emailAttachments)
      .set({ filedAt: null, filedPath: null })
      .where(eq(emailAttachments.emailMessageId, emailMessageId));

    const [account] = await db
      .select({
        companyId: emailAccounts.companyId,
        role: emailAccounts.role,
        triageAgentId: emailAccounts.triageAgentId,
      })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, row.emailAccountId))
      .limit(1);
    if (!account) return;

    const { companyId } = account;

    // Self-loop guard — same as ingest path
    const ownVoice = await db
      .select({ fromEmail: emailAccounts.fromEmail })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.companyId, companyId), eq(emailAccounts.role, "agent_voice")));
    if (new Set(ownVoice.map((r) => r.fromEmail.toLowerCase())).has(row.fromAddr.toLowerCase())) {
      await db.update(emailMessages).set({
        processingState: "ignored",
        matchedCompanyId: companyId,
        processedAt: new Date(),
        errorText: `Self-loop: from=${row.fromAddr} is one of our agent_voice accounts.`,
      }).where(eq(emailMessages.id, emailMessageId));
      return;
    }

    // Client matching — do synchronously so matchedClientId is available immediately.
    // Auto-create a stub client if the sender domain doesn't match any known client.
    let clientRec = await clientService(db).matchByEmail(companyId, row.fromAddr);
    if (!clientRec) {
      const domain = row.fromAddr.split("@")[1]?.toLowerCase() ?? "";
      if (domain) {
        const name = domain.split(".").slice(0, -1).join(".") || domain;
        clientRec = await clientService(db).create(companyId, {
          name: name.charAt(0).toUpperCase() + name.slice(1),
          emailDomain: domain,
        });
        logger.info({ companyId, emailMessageId, domain }, "email-processor: auto-created client stub during reprocess");
      }
    }

    // Stamp company + client match immediately so the log shows correct state.
    await db.update(emailMessages).set({
      matchedCompanyId: companyId,
      matchedClientId: clientRec?.id ?? null,
      processedAt: new Date(),
      processingState: "analyzing",
    }).where(eq(emailMessages.id, emailMessageId));

    // Ensure client storage folder exists so attachments can be filed.
    if (clientRec) {
      ensureClientFolder(db, clientRec.id).catch(() => {});
    }

    // Route: EA triage agent → wake directly; otherwise use orchestrator.
    let eaRouted = false;
    if (account.triageAgentId) {
      const [triageAgent] = await db
        .select({ adapterType: agents.adapterType })
        .from(agents)
        .where(eq(agents.id, account.triageAgentId))
        .limit(1);
      if (triageAgent?.adapterType === "ea") {
        await db.insert(agentWakeupRequests).values({
          companyId,
          agentId: account.triageAgentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "email-triage",
          payload: { emailMessageId },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: "email-processor",
        });
        await db.update(emailMessages).set({
          matchedAgentId: account.triageAgentId,
        }).where(eq(emailMessages.id, emailMessageId));
        eaRouted = true;
        logger.info({ emailMessageId, triageAgentId: account.triageAgentId }, "email-processor: reprocess — woke EA");
      }
    }

    if (!eaRouted) {
      const attRows = await db
        .select({ filename: emailAttachments.filename })
        .from(emailAttachments)
        .where(eq(emailAttachments.emailMessageId, emailMessageId));
      await routeInboundMessage(db, {
        companyId,
        platform: "email",
        fromAddr: row.fromAddr,
        body: row.body,
        subject: row.subject,
        threadKey: row.messageIdHeader,
        attachmentSummaries: attRows.map((a) => a.filename),
      });
    }

    if (account.role === "inbound") {
      workflowEngine(db).runFireAndForget(inboundEmailWorkflow, row.id);
    }

    // File attachments now that matchedClientId is set.
    // Await so we can reliably advance state afterward.
    if (clientRec) {
      const { backfillClientAttachments } = await import("./client-storage.js");
      await backfillClientAttachments(db, clientRec.id).catch(() => {});
    }

    // If no plan was created, advance "analyzing" → "executed" so the badge doesn't stick.
    // For EA-routed emails: EA runs async after this; if it later calls plan-gate it
    // will override "executed" → "plan_proposed". Safe to set now.
    const [cur] = await db
      .select({ processingState: emailMessages.processingState })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);
    if (cur?.processingState === "analyzing") {
      await db.update(emailMessages).set({
        processingState: "executed",
        processedAt: new Date(),
      }).where(eq(emailMessages.id, emailMessageId));
    }
  }

  return { processRawMessage, reprocess, deleteWithHistory };
}

// v3: route an inserted email_messages row through client match + plan gate.
// Minimal routing: propose a single `create_issue` plan so the user sees the
// inbound request in the approvals queue. Real triage (reply vs delegate vs
// clarify) is the next step once a triage-agent service is available.
async function routeInbound(
  db: Db,
  emailMessageId: string,
  emailAccountId: string,
  fromAddr: string,
  toAddrs: string[],
  subject: string,
): Promise<void> {
  const [account] = await db
    .select({
      companyId: emailAccounts.companyId,
      address: emailAccounts.fromEmail,
      label: emailAccounts.label,
      role: emailAccounts.role,
      triageAgentId: emailAccounts.triageAgentId,
      teamEmails: emailAccounts.teamEmails,
      autoAcknowledge: emailAccounts.autoAcknowledge,
      ackSubject: emailAccounts.ackSubject,
      ackBody: emailAccounts.ackBody,
      replyFromAccountId: emailAccounts.replyFromAccountId,
    })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, emailAccountId))
    .limit(1);
  if (!account) return;

  // Loop guard: if the sender is one of our own agent_voice accounts (the AI
  // sending a questions/plan email that landed back in an inbound inbox), skip
  // everything — no triage, no auto-ack. Scope to agent_voice only: operator
  // replies (inbound → agent_voice) must NOT be blocked, they carry [plan-id]
  // tags and must reach routeOperatorReply.
  const ownAgentVoiceAddresses = await db
    .select({ fromEmail: emailAccounts.fromEmail })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.companyId, account.companyId), eq(emailAccounts.role, "agent_voice")));
  const ownSet = new Set(ownAgentVoiceAddresses.map((r) => r.fromEmail.toLowerCase()));
  if (ownSet.has(fromAddr.toLowerCase())) {
    await db
      .update(emailMessages)
      .set({
        processingState: "ignored",
        matchedCompanyId: account.companyId,
        processedAt: new Date(),
        errorText: `Self-loop: from=${fromAddr} is one of our agent_voice accounts.`,
      })
      .where(eq(emailMessages.id, emailMessageId));
    logger.info(
      { emailMessageId, fromAddr, emailAccountId },
      "email-processor: ignored self-loop email (from own account)",
    );
    return;
  }

  // Threading: if this email is a reply to one we've processed before, append
  // it to that thread's existing triage issue (as a comment) and wake the same
  // agent — don't create a brand new triage issue. The plan-gate approval flow
  // on the original plan continues normally.
  const didThread = await tryContinueThread(db, emailMessageId);
  if (didThread) return;
  // Agent-voice accounts receive operator replies, not client requests.
  // Route them to a separate handler that can recognise approval/rejection
  // tags or treat the body as a follow-up comment on the linked triage issue.
  if (account.role !== "inbound") {
    await routeOperatorReply(db, emailMessageId, account.companyId, fromAddr, subject);
    return;
  }

  // Send acknowledgement reply to sender if enabled. Uses reply_from override
  // if set, otherwise the inbox itself. Fire-and-forget — failures log only.
  if (account.autoAcknowledge) {
    const [srcMsg] = await db
      .select({ messageIdHeader: emailMessages.messageIdHeader })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);
    const replyBody =
      renderAckTemplate(account.ackBody, { from: fromAddr, subject }) ||
      renderAckTemplate(DEFAULT_ACK_BODY, { from: fromAddr, subject });
    const replySubject =
      renderAckTemplate(account.ackSubject, { from: fromAddr, subject }) ||
      renderAckTemplate(DEFAULT_ACK_SUBJECT, { from: fromAddr, subject });
    sendEmailFromAccount(db, {
      accountId: account.replyFromAccountId ?? emailAccountId,
      to: fromAddr,
      subject: replySubject,
      text: replyBody,
      inReplyTo: srcMsg?.messageIdHeader ?? null,
      references: srcMsg?.messageIdHeader ? [srcMsg.messageIdHeader] : null,
    }).catch((err) =>
      logger.warn({ err, emailMessageId }, "email-processor: ack send failed"),
    );
  }

  const companyId = account.companyId;
  const clientRec = await clientService(db).matchByEmail(companyId, fromAddr);

  // Upsert contact stub from sender — name starts null, filled later via update_contact.
  const contactRec = await contactService(db).upsertByEmail(
    companyId,
    fromAddr,
    clientRec?.id ?? null,
  );

  // Auto-link project if client has exactly one non-archived project.
  let autoProject: { id: string; name: string } | null = null;
  if (clientRec) {
    const clientProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.clientId, clientRec.id), isNull(projects.archivedAt)))
      .limit(2);
    if (clientProjects.length === 1) autoProject = clientProjects[0]!;
  }

  // Stamp matchedCompanyId + matchedClientId + matchedContactId before planning.
  await db
    .update(emailMessages)
    .set({
      matchedCompanyId: companyId,
      matchedClientId: clientRec?.id ?? null,
      matchedContactId: contactRec.id,
      processingState: "analyzing",
    })
    .where(eq(emailMessages.id, emailMessageId));

  // Pick triage agent: per-inbox triageAgentId wins; otherwise the first
  // company agent with role='ceo'. If neither exists, leave the email pending
  // so operators can fix the agent config and reroute.
  let triageAgentId: string | null = account.triageAgentId;
  if (!triageAgentId) {
    const [fallback] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
      .limit(1);
    triageAgentId = fallback?.id ?? null;
  }
  if (!triageAgentId) {
    logger.warn({ companyId, emailMessageId }, "email-processor: no triage agent, skipping plan");
    await db
      .update(emailMessages)
      .set({ processingState: "pending", errorText: "No triage agent configured" })
      .where(eq(emailMessages.id, emailMessageId));
    return;
  }

  // Create a triage issue assigned to the triage agent. The agent reads the
  // email via /api/email-messages, reviews client/project context, and posts
  // a plan via POST /api/companies/:companyId/plans. This reuses Paperclip's
  // agent runtime (adapter, skills, wakeup) instead of embedding a second
  // decision system here.
  const clientLine = clientRec ? `${clientRec.name} (id=${clientRec.id})` : "(no client matched)";
  const projectLine = autoProject ? `${autoProject.name} (id=${autoProject.id})` : "(none — pick one if needed)";

  const ackNote = account.autoAcknowledge
    ? "An automatic acknowledgement was sent to the sender so they know the email arrived. **This ack is courtesy only — it is NOT your response.** You still must propose a plan or ask clarifying questions below."
    : "No acknowledgement was sent. Your plan / questions will be the first response the sender sees.";

  const description = [
    `# Task: triage inbound email and propose a plan`,
    ``,
    `A client email has arrived on **${account.address}** (${account.label}).`,
    `Review its content, the client history, and — if a project is linked — the codebase.`,
    `Then propose ONE of the plan kinds below via the API so the operator can approve.`,
    ``,
    `> ${ackNote}`,
    ``,
    `## Email`,
    `- Email message id: \`${emailMessageId}\``,
    `- From: ${fromAddr}`,
    `- Subject: ${subject || "(no subject)"}`,
    `- API: \`GET /api/email-messages/${emailMessageId}\` (returns body + attachments metadata)`,
    ``,
    `## Context`,
    `- Client: ${clientLine}`,
    `- Project: ${projectLine}`,
    ``,
    `## You MUST do one of these — not none`,
    ``,
    `Call \`POST /api/companies/${companyId}/plans\` with a JSON body:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "agentId": "${triageAgentId}",`,
    `  "kind": "create_issue" | "reply_to_sender" | "request_clarification" | "request_operator_input",`,
    `  "proposalText": "<your full plan / reply / questions>",`,
    `  "confidence": "low" | "medium" | "high",`,
    `  "clientId": ${clientRec ? `"${clientRec.id}"` : "null"},`,
    `  "projectId": ${autoProject ? `"${autoProject.id}"` : "null"},`,
    `  "sourceEmailMessageId": "${emailMessageId}",`,
    `  "definitionOfDone": ["acceptance criterion 1", "criterion 2", "..."],`,
    `  "proposalMeta": {`,
    `    "reply": {`,
    `      "text": "(plain-text body — required for reply_to_sender / request_clarification)",`,
    `      "html": "(optional HTML body — preferred; uses simple inline styles for email clients)"`,
    `    },`,
    `    "questions": [  // for request_operator_input only`,
    `      { "id": "client", "kind": "client", "question": "Which client?", "suggestedAnswer": "..." },`,
    `      { "id": "project", "kind": "project", "question": "Which project?", "suggestedAnswer": "..." },`,
    `      { "id": "dod", "kind": "dod", "question": "What's the definition of done?" }`,
    `    ]`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `### Decision guide`,
    `- **create_issue** — you have enough info to scope work. **REQUIRED:** clientId + projectId + non-empty definitionOfDone. proposalText = the full plan (goals, steps, agents, skills, estimate). Server will reject with 422 if any of these are missing.`,
    `- **request_clarification** — you need info from the **sender** (the client). proposalText = short rationale for the operator; proposalMeta.reply.text/html = the actual email we send to the client (be specific: 2-4 questions, not generic "tell us more").`,
    `- **request_operator_input** — you need info from the **operator** (the human running this app) — typically: which existing client/project to attach to, what counts as done, scope confirmation. proposalText = why you need input; proposalMeta.questions = the questions list. The operator gets a styled email + can reply directly.`,
    `- **reply_to_sender** — direct answer / status update without creating internal work. proposalText = why; proposalMeta.reply.text/html = the email body.`,
    ``,
    `### YOUR ROLE: delegate only`,
    `You are a triage agent. You read emails, understand context, and delegate work.`,
    `You do NOT create clients, projects, or any other platform objects directly.`,
    `**NEVER call POST /api/companies/:id/clients or POST /api/companies/:id/projects.**`,
    `Those endpoints are owned by the ops agent. Calling them yourself bypasses audit trails and governance.`,
    ``,
    `### Readiness checklist for create_issue`,
    `Before you submit kind="create_issue", you must have:`,
    `  1. **clientId** — must be an existing client id. If missing, STOP and delegate to ops agent (see below).`,
    `  2. **projectId** — must be an existing project id. If missing, STOP and delegate to ops agent (see below).`,
    `  3. **definitionOfDone** — concrete acceptance criteria (e.g. "homepage hero text updated", "deployed to production"). At least 1 entry.`,
    `If any are missing, do NOT submit create_issue. Use the ops agent delegation flow below.`,
    ``,
    `### Delegating to the Ops Agent (REQUIRED for missing client/project)`,
    ``,
    `When you need a new client or project created, create a sub-issue for the ops agent rather than emailing the operator.`,
    `This keeps the work inside Paperclip and resumes you automatically when the ops agent finishes.`,
    ``,
    `**Step 1 — Find the ops agent:**`,
    `\`\`\``,
    `GET /api/companies/${companyId}/agents`,
    `\`\`\``,
    `Find the agent with role="ops". If none exists, fall back to request_operator_input.`,
    ``,
    `**Step 2 — Create the sub-issue:**`,
    `\`\`\``,
    `POST /api/companies/${companyId}/issues`,
    `Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`,
    `{`,
    `  "title": "[ops] create_client: <name> <<email>>",`,
    `  "description": "JSON block with: name, emailDomain, extraEmails, notes. Context: email from <fromAddr>, subject: <subject>.",`,
    `  "parentId": "<this triage issue id>",`,
    `  "assigneeAgentId": "<ops agent id>",`,
    `  "status": "todo"`,
    `}`,
    `\`\`\``,
    `For project creation: title \`[ops] create_project: <name> for clientId=<id>\`.`,
    `For both at once: title \`[ops] create_client_and_project: <client name> / <project name>\`.`,
    ``,
    `**Step 3 — Block yourself:**`,
    `\`\`\``,
    `PATCH /api/issues/<this triage issue id>`,
    `{ "status": "blocked" }`,
    `\`\`\``,
    `Post a comment: "Delegated to ops agent (sub-issue <id>). Waiting for client/project creation."`,
    ``,
    `**Step 4 — When you wake again** (ops agent closed the sub-issue):`,
    `Read the sub-issue comments for the clientId/projectId, then resume and propose create_issue.`,
    ``,
    `### Important rules`,
    `- The auto-acknowledgement is NOT a plan. Do not skip this step because an ack was sent.`,
    `- Always include proposalMeta.reply.text (and reply.html if you can) for clarification / reply kinds — that is what gets emailed.`,
    `- Use plain text for .text and well-formed HTML with inline styles for .html. The dispatcher will send both as a multipart email.`,
    `- Operator reviews via /governance/plans and approves. Do NOT email the sender directly outside the plan-gate.`,
    `- Include X-Paperclip-Run-Id header on all API mutations.`,
  ].join("\n");

  try {
    const issue = await issueService(db).create(companyId, {
      title: `Email triage: ${subject || "(no subject)"} — from ${fromAddr}`,
      description,
      clientId: clientRec?.id ?? null,
      projectId: autoProject?.id ?? null,
      assigneeAgentId: triageAgentId,
      createdByAgentId: triageAgentId,
      status: "in_progress",
    });
    // Link the inbound email to the triage issue so the UI can show the
    // connection from either side. Flip processing state so it doesn't stay
    // in 'analyzing' forever.
    await db
      .update(emailMessages)
      .set({
        issueId: issue.id,
        matchedAgentId: triageAgentId,
        processingState: "plan_proposed",
        processedAt: new Date(),
      })
      .where(eq(emailMessages.id, emailMessageId));

    // Wake the triage agent via heartbeatService — this also creates the
    // heartbeat_runs row + acquires the issue execution lock + runs budget
    // and policy gates. Inserting agent_wakeup_requests directly skips all
    // of that and the agent never runs.
    const { heartbeatService } = await import("./heartbeat.js");
    try {
      await heartbeatService(db).wakeup(triageAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "email-triage",
        payload: { issueId: issue.id, emailMessageId },
        contextSnapshot: { issueId: issue.id, emailMessageId },
        requestedByActorType: "system",
      });
    } catch (err) {
      logger.warn({ err, triageAgentId, issueId: issue.id }, "email-processor: triage wakeup failed");
    }

    logger.info(
      { emailMessageId, issueId: issue.id, triageAgentId },
      "email-processor: created triage issue + queued wakeup",
    );
  } catch (err) {
    logger.warn({ err, emailMessageId }, "email-processor: failed to create triage issue");
    await db
      .update(emailMessages)
      .set({
        processingState: "error",
        errorText: (err as Error).message.slice(0, 1000),
      })
      .where(eq(emailMessages.id, emailMessageId));
  }
}

export // Operator replies arrive on agent_voice accounts (e.g. someone replied to a
// plan-pending notification, or used the "Ask a question" mailto link).
// Recognise [plan-<id>] subject tags and treat the body as either a decision
// or a follow-up comment on the triage issue.
const PLAN_TAG_RE = /\[plan-([0-9a-f-]{36})\]/i;
const APPROVE_RE = /^\s*(approve[d]?|yes|ok|👍)\s*[!.]?\s*$/im;
const REJECT_RE = /^\s*(reject(ed)?|no|nope|👎)\s*[!.]?\s*$/im;

async function routeOperatorReply(
  db: Db,
  emailMessageId: string,
  companyId: string,
  _fromAddr: string,
  subject: string,
): Promise<void> {
  // Try thread continuation first — the reply's References chain will include
  // the original inbound client email's Message-ID (which is in the DB with an
  // issueId), even though the AI's outbound reply is not stored.
  const threadHandled = await tryContinueThread(db, emailMessageId);
  if (threadHandled) return;

  const [msg] = await db
    .select({ body: emailMessages.body, fromAddr: emailMessages.fromAddr })
    .from(emailMessages)
    .where(eq(emailMessages.id, emailMessageId))
    .limit(1);

  const planMatch = subject.match(PLAN_TAG_RE);
  if (!planMatch) {
    // No [plan-<id>] tag → treat as free-form operator message.
    // Route via OperatorMessageService (mention → agent, room, or auto-route).
    const [voiceAcct] = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.companyId, companyId), eq(emailAccounts.role, "agent_voice")))
      .limit(1);

    if (voiceAcct && msg) {
      const { operatorMessagingService } = await import("./operator-messaging.js");
      const [srcMsg] = await db
        .select({
          body: emailMessages.body,
          subject: emailMessages.subject,
          messageIdHeader: emailMessages.messageIdHeader,
        })
        .from(emailMessages)
        .where(eq(emailMessages.id, emailMessageId))
        .limit(1);
      if (srcMsg) {
        await operatorMessagingService(db).handleInbound(companyId, voiceAcct.id, {
          platform: "email",
          from: _fromAddr,
          body: srcMsg.body,
          subject: srcMsg.subject || undefined,
          threadKey: srcMsg.messageIdHeader || undefined,
          raw: { emailMessageId, subject, fromAddr: _fromAddr },
        });
      }
    }

    await db
      .update(emailMessages)
      .set({
        processingState: "executed",
        matchedCompanyId: companyId,
        processedAt: new Date(),
      })
      .where(eq(emailMessages.id, emailMessageId));
    logger.info(
      { emailMessageId, subject, companyId },
      "email-processor: untagged agent_voice message routed via operator-messaging",
    );
    return;
  }

  const planId = planMatch[1]!;
  const { plans } = await import("@paperclipai/db");
  const [plan] = await db
    .select({
      id: plans.id,
      decision: plans.decision,
      sourceEmailMessageId: plans.sourceEmailMessageId,
      companyId: plans.companyId,
    })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  if (!plan) {
    await db
      .update(emailMessages)
      .set({
        processingState: "error",
        matchedCompanyId: companyId,
        processedAt: new Date(),
        errorText: `Plan ${planId} not found`,
      })
      .where(eq(emailMessages.id, emailMessageId));
    return;
  }

  const body = (msg?.body ?? "").trim();
  const stripped = body.replace(/^>.*$/gm, "").trim(); // drop quoted reply lines

  // 1. Decision keyword: approve / reject — only when plan still pending.
  if (plan.decision === "pending") {
    const isApprove = APPROVE_RE.test(stripped);
    const isReject = REJECT_RE.test(stripped);
    if (isApprove || isReject) {
      const decision = isApprove ? "approved" : "rejected";
      const { planGateService } = await import("./plan-gate.js");
      const gate = planGateService(db);
      try {
        await gate.recordDecision(plan.id, decision, null, `Decided via email reply from ${msg?.fromAddr ?? "operator"}`);
        if (decision === "approved") {
          try { await gate.executePlan(plan.id); }
          catch (err) {
            logger.warn({ err, planId }, "email-processor: post-approval execute failed");
          }
        }
        await db
          .update(emailMessages)
          .set({
            processingState: "executed",
            matchedCompanyId: companyId,
            processedAt: new Date(),
          })
          .where(eq(emailMessages.id, emailMessageId));
        logger.info({ emailMessageId, planId, decision }, "email-processor: applied operator email decision");
        return;
      } catch (err) {
        logger.warn({ err, planId, decision }, "email-processor: failed to record decision");
      }
    }
  }

  // 2. Otherwise: treat as a follow-up note. Attach to the triage issue if
  // the plan has one, so the agent sees the operator's question on next wake.
  if (plan.sourceEmailMessageId) {
    const [src] = await db
      .select({ issueId: emailMessages.issueId })
      .from(emailMessages)
      .where(eq(emailMessages.id, plan.sourceEmailMessageId))
      .limit(1);
    if (src?.issueId) {
      const commentBody = [
        `**Operator follow-up via email** (re: plan \`${planId}\`)`,
        ``,
        `From: ${msg?.fromAddr ?? "(unknown)"}`,
        `Subject: ${subject}`,
        ``,
        `> ${stripped.slice(0, 1500) || "(empty)"}`,
        ``,
        `Re-read the email thread + this note. Update the plan via POST /api/companies/${companyId}/plans if needed, or reply for more clarification.`,
      ].join("\n");
      await db.insert(issueComments).values({
        companyId,
        issueId: src.issueId,
        body: commentBody,
        authorUserId: "operator-email-reply",
      });
      // Wake the assignee so the agent processes the note immediately.
      const [issue] = await db.select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues).where(eq(issues.id, src.issueId)).limit(1);
      if (issue?.assigneeAgentId) {
        const { heartbeatService } = await import("./heartbeat.js");
        try {
          await heartbeatService(db).wakeup(issue.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "operator-reply",
            payload: { issueId: src.issueId, planId, emailMessageId },
            contextSnapshot: { issueId: src.issueId, emailMessageId },
            requestedByActorType: "system",
          });
        } catch (err) {
          logger.warn({ err, agentId: issue.assigneeAgentId, issueId: src.issueId }, "email-processor: operator-reply wakeup failed");
        }
      }
      await db
        .update(emailMessages)
        .set({
          processingState: "plan_proposed",
          matchedCompanyId: companyId,
          issueId: src.issueId,
          processedAt: new Date(),
        })
        .where(eq(emailMessages.id, emailMessageId));
      logger.info({ emailMessageId, planId, issueId: src.issueId }, "email-processor: routed operator reply to triage issue");
      return;
    }
  }

  // No issue to attach to — just mark ignored with explanation.
  await db
    .update(emailMessages)
    .set({
      processingState: "ignored",
      matchedCompanyId: companyId,
      processedAt: new Date(),
      errorText: `Plan ${planId} has no source issue — operator reply could not be routed.`,
    })
    .where(eq(emailMessages.id, emailMessageId));
}

// Continue an existing triage thread when the inbound email is a reply.
// Returns true if we attached the email to a prior issue and woke its agent;
// false means the caller should take the normal "new triage issue" path.
async function tryContinueThread(db: Db, emailMessageId: string): Promise<boolean> {
  const [msg] = await db
    .select({
      id: emailMessages.id,
      fromAddr: emailMessages.fromAddr,
      subject: emailMessages.subject,
      body: emailMessages.body,
      inReplyToHeader: emailMessages.inReplyToHeader,
      referencesHeaders: emailMessages.referencesHeaders,
    })
    .from(emailMessages)
    .where(eq(emailMessages.id, emailMessageId))
    .limit(1);
  if (!msg) return false;

  const candidates = [
    ...(msg.inReplyToHeader ? [msg.inReplyToHeader] : []),
    ...(msg.referencesHeaders ?? []),
  ].filter(Boolean);
  if (candidates.length === 0) return false;

  // Find the earliest prior email in the thread that already has a linked
  // issue. Most recent inReplyTo first, falling back to references chain.
  const parents = await db
    .select({
      id: emailMessages.id,
      issueId: emailMessages.issueId,
      messageIdHeader: emailMessages.messageIdHeader,
    })
    .from(emailMessages)
    .where(inArray(emailMessages.messageIdHeader, candidates));
  const parent = parents.find((p) => p.issueId);
  if (!parent?.issueId) return false;

  const [issue] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(eq(issues.id, parent.issueId))
    .limit(1);
  if (!issue) return false;

  // Attach the new email to the same issue.
  await db
    .update(emailMessages)
    .set({
      issueId: issue.id,
      matchedCompanyId: issue.companyId,
      matchedAgentId: issue.assigneeAgentId,
      processingState: "plan_proposed",
      processedAt: new Date(),
    })
    .where(eq(emailMessages.id, emailMessageId));

  // Drop a summary comment so the agent sees the new signal when it wakes.
  const excerpt = (msg.body ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const commentBody = [
    `**Follow-up email received** from ${msg.fromAddr}`,
    ``,
    `Subject: ${msg.subject || "(no subject)"}`,
    `Email id: \`${emailMessageId}\` (fetch via GET /api/email-messages/${emailMessageId})`,
    ``,
    `Excerpt:`,
    `> ${excerpt || "(empty body)"}`,
    ``,
    `Re-evaluate the plan with this new information and post an updated plan via POST /api/companies/${issue.companyId}/plans if anything changes.`,
  ].join("\n");

  await db.insert(issueComments).values({
    companyId: issue.companyId,
    issueId: issue.id,
    body: commentBody,
    authorUserId: "email-thread",
  });

  // Wake the assigned agent via heartbeatService so it actually runs (raw
  // wakeup-table insert doesn't create the heartbeat_runs row).
  if (issue.assigneeAgentId) {
    const { heartbeatService } = await import("./heartbeat.js");
    try {
      await heartbeatService(db).wakeup(issue.assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "thread-reply",
        payload: { issueId: issue.id, emailMessageId },
        contextSnapshot: { issueId: issue.id, emailMessageId },
        requestedByActorType: "system",
      });
    } catch (err) {
      logger.warn({ err, agentId: issue.assigneeAgentId, issueId: issue.id }, "email-processor: thread-reply wakeup failed");
    }
  }

  logger.info(
    { emailMessageId, issueId: issue.id, parentEmailId: parent.id },
    "email-processor: attached to existing thread",
  );
  return true;
}

const DEFAULT_ACK_BODY =
  "Hi,\n\nThanks for your message — we received it and our team is reviewing it now. We'll be in touch shortly with next steps.\n\nBest,\nThe team";
export const DEFAULT_ACK_SUBJECT = "Re: {subject}";

function renderAckTemplate(
  template: string | null,
  vars: { from: string; subject: string },
): string {
  const raw = (template ?? "").trim();
  if (!raw) return "";
  return raw
    .replaceAll("{from}", vars.from)
    .replaceAll("{subject}", vars.subject || "(no subject)");
}

export type EmailProcessorService = ReturnType<typeof emailProcessorService>;
