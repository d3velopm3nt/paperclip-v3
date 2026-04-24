// v3: parses raw IMAP RFC-822 bytes → email_messages + email_attachments rows,
// saves attachment blobs to the filesystem. Pure of IMAP — takes Buffer in,
// returns the inserted message id.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  emailAccounts,
  emailMessages,
  emailAttachments,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { saveAttachment } from "./attachment-storage.js";
import { clientService } from "./clients.js";
import { issueService } from "./issues.js";
import { sendEmailFromAccount } from "./email-sender.js";
import { logger } from "../middleware/logger.js";

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
        receivedAt,
        rawHeaders: Object.fromEntries(parsed.headers ?? []) as Record<string, unknown>,
      })
      .returning();

    const attachments = asArray(parsed.attachments);
    let attachmentCount = 0;
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      const content = att.content;
      if (!content || !Buffer.isBuffer(content)) continue;
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

    // v3: route inbound email — match to a client + propose a plan via the gate.
    // Failures here don't discard the email; the row stays at pending and
    // operators can retry later.
    try {
      await routeInbound(db, inserted!.id, input.emailAccountId, fromAddr, toAddrs, subject);
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

  async function reprocess(emailMessageId: string): Promise<void> {
    const [row] = await db
      .select({
        id: emailMessages.id,
        emailAccountId: emailMessages.emailAccountId,
        fromAddr: emailMessages.fromAddr,
        toAddrs: emailMessages.toAddrs,
        subject: emailMessages.subject,
      })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);
    if (!row) throw new Error(`email not found: ${emailMessageId}`);

    // Reset state + clear prior processing artefacts so routeInbound can
    // re-propose a plan. Pending plans for this email are left in place;
    // deletion is intentionally out of scope (audit trail).
    await db
      .update(emailMessages)
      .set({
        processingState: "pending",
        errorText: null,
        processedAt: null,
      })
      .where(eq(emailMessages.id, emailMessageId));

    await routeInbound(db, row.id, row.emailAccountId, row.fromAddr, row.toAddrs ?? [], row.subject);
  }

  return { processRawMessage, reprocess };
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
  // Threading: if this email is a reply to one we've processed before, append
  // it to that thread's existing triage issue (as a comment) and wake the same
  // agent — don't create a brand new triage issue. The plan-gate approval flow
  // on the original plan continues normally.
  const didThread = await tryContinueThread(db, emailMessageId);
  if (didThread) return;
  const [account] = await db
    .select({
      companyId: emailAccounts.companyId,
      address: emailAccounts.fromEmail,
      label: emailAccounts.label,
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

  // Stamp matchedCompanyId + matchedClientId even before planning so the
  // inbox can filter by client.
  await db
    .update(emailMessages)
    .set({
      matchedCompanyId: companyId,
      matchedClientId: clientRec?.id ?? null,
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

  const description = [
    `# Task: triage inbound email and propose a plan`,
    ``,
    `A client email has arrived on **${account.address}** (${account.label}).`,
    `Review its content, the client history, and — if a project is linked — the codebase.`,
    `Then propose ONE of the following plan kinds via the API so the operator can approve.`,
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
    `## How to respond`,
    ``,
    `Call \`POST /api/companies/${companyId}/plans\` with a JSON body:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "agentId": "${triageAgentId}",`,
    `  "kind": "create_issue" | "reply_to_sender" | "request_clarification",`,
    `  "proposalText": "<your full plan / reply / questions>",`,
    `  "confidence": "low" | "medium" | "high",`,
    `  "clientId": ${clientRec ? `"${clientRec.id}"` : "null"},`,
    `  "projectId": ${autoProject ? `"${autoProject.id}"` : "null"},`,
    `  "sourceEmailMessageId": "${emailMessageId}",`,
    `  "proposalMeta": {`,
    `    "reply": { "text": "(for reply_to_sender / request_clarification: body to send)" }`,
    `  }`,
    `}`,
    `\`\`\``,
    ``,
    `### Decision guide`,
    `- **create_issue** — you have enough info to scope the work. proposalText = the full plan (goals, steps, agents, skills, estimate).`,
    `- **request_clarification** — you need more info from the sender. proposalText = short rationale; proposalMeta.reply.text = the email we send back.`,
    `- **reply_to_sender** — direct answer / acknowledgement without creating internal work. proposalText = why you're replying; proposalMeta.reply.text = the email body.`,
    ``,
    `The operator will review via /governance/plans and approve. Do NOT take direct action outside the plan-gate.`,
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

    // Wake the triage agent directly — issueService.create doesn't call the
    // assignment-wakeup hook (that only fires from route handlers), so without
    // this the agent idles until the next heartbeat poll.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: triageAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "email-triage",
      payload: { issueId: issue.id, emailMessageId },
      status: "queued",
      requestedByActorType: "system",
    });

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

export // Continue an existing triage thread when the inbound email is a reply.
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

  // Wake the assigned agent if any — direct insert into the wakeup queue so
  // we don't need to import the heartbeat service here.
  if (issue.assigneeAgentId) {
    await db.insert(agentWakeupRequests).values({
      companyId: issue.companyId,
      agentId: issue.assigneeAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "thread-reply",
      payload: { issueId: issue.id, emailMessageId },
      status: "queued",
      requestedByActorType: "system",
    });
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
