// v3: normalises all inbound channel messages and dispatches to the orchestrator.
// Step 1: thread check (cheap DB lookup) — existing conversation → pass existingIssueId to orchestrator.
// Step 2: identify sender type (client vs operator) by platform + address.
// Step 3: dispatch to orchestrator.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clients, issues, messageThreads, operatorMessages } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { runOrchestrator } from "./orchestrator.js";


export interface InboundChannelMessage {
  companyId: string;
  platform: "email" | "telegram" | "whatsapp";
  fromAddr: string;
  body: string;
  subject?: string;
  threadKey: string;
  attachmentSummaries?: string[];
}

export async function routeInboundMessage(db: Db, msg: InboundChannelMessage): Promise<void> {
  const { companyId, platform, fromAddr, threadKey } = msg;

  // Thread check: does an existing issue own this thread key?
  const existingThread = await db
    .select({ issueId: operatorMessages.issueId, issueStatus: issues.status })
    .from(messageThreads)
    .innerJoin(operatorMessages, eq(operatorMessages.id, messageThreads.operatorMessageId))
    .leftJoin(issues, eq(issues.id, operatorMessages.issueId))
    .where(and(
      eq(messageThreads.platform, platform),
      eq(messageThreads.threadKey, threadKey),
      eq(operatorMessages.companyId, companyId),
    ))
    .orderBy(desc(messageThreads.id))
    .limit(1);

  const existingIssueId = existingThread[0]?.issueId ?? null;

  // Identify sender
  let fromType: "client" | "operator" = "operator";
  let clientId: string | undefined;

  if (platform === "whatsapp") {
    fromType = "client";
    clientId = await resolveClientByPhone(db, companyId, fromAddr);
  } else if (platform === "telegram") {
    fromType = "operator";
  } else if (platform === "email") {
    const resolved = await resolveClientByEmail(db, companyId, fromAddr);
    if (resolved) {
      fromType = "client";
      clientId = resolved;
    }
  }

  logger.info(
    { companyId, platform, fromType, clientId: clientId ?? null, existingIssueId },
    "inbound-router: dispatching",
  );

  // Persist inbound message so Channels tab can show it
  void db.insert(operatorMessages).values({
    companyId,
    direction: "inbound",
    platform,
    source: fromType === "operator" ? "telegram" : platform,
    body: msg.body,
    rawPayload: null,
  }).catch(() => {});

  await runOrchestrator(db, {
    companyId,
    platform,
    fromType,
    fromAddr,
    threadKey,
    body: msg.body,
    subject: msg.subject,
    attachmentSummaries: msg.attachmentSummaries,
    clientId,
    existingIssueId: existingIssueId ?? undefined,
  });
}

async function resolveClientByPhone(db: Db, companyId: string, phone: string): Promise<string | undefined> {
  const normalized = phone.replace(/\D/g, "");
  const rows = await db
    .select({ id: clients.id, extraEmails: clients.extraEmails })
    .from(clients)
    .where(eq(clients.companyId, companyId));
  for (const row of rows) {
    const extras = (row.extraEmails ?? []) as string[];
    if (extras.some((e) => e.replace(/\D/g, "") === normalized)) return row.id;
  }
  return undefined;
}

async function resolveClientByEmail(db: Db, companyId: string, email: string): Promise<string | undefined> {
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";

  if (domain) {
    const [byDomain] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.companyId, companyId), eq(clients.emailDomain, domain)))
      .limit(1);
    if (byDomain) return byDomain.id;
  }

  const rows = await db
    .select({ id: clients.id, extraEmails: clients.extraEmails })
    .from(clients)
    .where(eq(clients.companyId, companyId));
  for (const row of rows) {
    const extras = (row.extraEmails ?? []) as string[];
    if (extras.some((e) => e.toLowerCase() === lower)) return row.id;
  }
  return undefined;
}
