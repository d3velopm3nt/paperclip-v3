// v3: platform-agnostic operator↔agent messaging.
//
// Adapters translate raw platform payloads into InboundMessage.
// operatorMessagingService.handleInbound routes them to the right agent/room.
// operatorMessagingService.sendToOperator sends outbound on the same platform thread.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  emailAccounts,
  issues,
  messageThreads,
  operatorMessages,
  roomMembers,
  rooms,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InboundMessage {
  platform: "email" | "telegram" | "sms";
  from: string;
  body: string;
  subject?: string;
  threadKey?: string;
  raw: unknown;
}

export interface OutboundMessage {
  to: string[];
  body: string;
  html?: string;
  subject?: string;
  threadKey?: string;
}

export interface MessagePlatformAdapter {
  platform: "email" | "telegram" | "sms";
  send(msg: OutboundMessage): Promise<{ threadKey: string }>;
  reply(threadKey: string, body: string, html?: string): Promise<void>;
}

// ─── Adapter Registry ─────────────────────────────────────────────────────────

const adapterRegistry = new Map<string, MessagePlatformAdapter>();

export function registerAdapter(adapter: MessagePlatformAdapter): void {
  adapterRegistry.set(adapter.platform, adapter);
}

export function getAdapter(platform: string): MessagePlatformAdapter | null {
  return adapterRegistry.get(platform) ?? null;
}

// ─── EmailAdapter ─────────────────────────────────────────────────────────────

export function createEmailAdapter(db: Db, voiceAccountId: string): MessagePlatformAdapter {
  return {
    platform: "email",

    async send(msg: OutboundMessage): Promise<{ threadKey: string }> {
      const { sendEmailFromAccount } = await import("./email-sender.js");
      const sent = await sendEmailFromAccount(db, {
        accountId: voiceAccountId,
        to: msg.to,
        subject: msg.subject ?? "(no subject)",
        text: msg.body,
        html: msg.html,
      });
      return { threadKey: sent.messageId ?? "" };
    },

    async reply(threadKey: string, body: string, html?: string): Promise<void> {
      const { sendEmailFromAccount } = await import("./email-sender.js");
      await sendEmailFromAccount(db, {
        accountId: voiceAccountId,
        to: [],
        subject: "",
        text: body,
        html,
        inReplyTo: threadKey,
        references: [threadKey],
      });
    },
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function operatorMessagingService(db: Db) {
  // ── Mention parsing ────────────────────────────────────────────────────────

  function parseMentions(text: string): { agentNames: string[]; roomSlugs: string[] } {
    const matches = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1]!.toLowerCase());
    return { agentNames: matches, roomSlugs: matches };
  }

  // ── Agent resolution ───────────────────────────────────────────────────────

  async function resolveAgentByName(
    companyId: string,
    name: string,
  ): Promise<{ id: string; companyId: string } | null> {
    const rows = await db
      .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const needle = name.toLowerCase().replace(/-/g, " ");
    return (
      rows.find(
        (r) =>
          r.name.toLowerCase() === needle ||
          r.name.toLowerCase().replace(/\s+/g, "-") === name.toLowerCase(),
      ) ?? null
    );
  }

  async function resolveRoomBySlug(
    companyId: string,
    slug: string,
  ): Promise<{ id: string; companyId: string; requireApproval: boolean } | null> {
    const [row] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.companyId, companyId), eq(rooms.slug, slug)))
      .limit(1);
    return row ?? null;
  }

  // ── Content-based auto-route ───────────────────────────────────────────────

  async function autoRouteAgent(companyId: string, body: string): Promise<string | null> {
    const companyAgents = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const lower = body.toLowerCase();
    const byRole = (role: string) => companyAgents.find((a) => a.role === role);

    if (/\b(code|bug|feature|deploy|infra|technical|dev|implement)\b/.test(lower)) {
      return byRole("cto")?.id ?? byRole("ceo")?.id ?? null;
    }
    if (/\b(design|ui|ux|layout|visual)\b/.test(lower)) {
      return byRole("designer")?.id ?? byRole("ceo")?.id ?? null;
    }
    return byRole("ceo")?.id ?? companyAgents[0]?.id ?? null;
  }

  // ── Issue + wakeup helpers ─────────────────────────────────────────────────

  async function ensureIssue(
    companyId: string,
    agentId: string,
    title: string,
    description: string,
  ): Promise<string> {
    const { issueService } = await import("./issues.js");
    const issue = await issueService(db).create(companyId, {
      title,
      description,
      assigneeAgentId: agentId,
      status: "todo",
      createdByAgentId: agentId,
    });
    return issue.id;
  }

  async function wakeAgent(
    companyId: string,
    agentId: string,
    issueId: string,
    reason: string,
  ): Promise<void> {
    const { heartbeatService } = await import("./heartbeat.js");
    try {
      await heartbeatService(db).wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason,
        payload: { issueId },
        requestedByActorType: "system",
        contextSnapshot: { issueId },
      });
    } catch (err) {
      logger.warn({ err, agentId, issueId }, "operator-messaging: wakeup failed");
    }
  }

  async function storeMessage(
    companyId: string,
    issueId: string | null,
    roomId: string | null,
    direction: "inbound" | "outbound",
    platform: string,
    body: string,
    raw: unknown,
    fromAgentId?: string | null,
  ): Promise<string> {
    const [row] = await db
      .insert(operatorMessages)
      .values({
        companyId,
        issueId,
        roomId,
        direction,
        platform,
        body,
        rawPayload: raw as Record<string, unknown> | null,
        fromAgentId: fromAgentId ?? null,
      })
      .returning({ id: operatorMessages.id });
    return row!.id;
  }

  async function storeThreadKey(msgId: string, platform: string, threadKey: string): Promise<void> {
    if (!threadKey) return;
    await db.insert(messageThreads).values({ operatorMessageId: msgId, platform, threadKey });
  }

  async function findThreadKeyForIssue(issueId: string, platform: string): Promise<string | null> {
    const rows = await db
      .select({ threadKey: messageThreads.threadKey })
      .from(messageThreads)
      .innerJoin(operatorMessages, eq(operatorMessages.id, messageThreads.operatorMessageId))
      .where(and(eq(operatorMessages.issueId, issueId), eq(messageThreads.platform, platform)))
      .limit(1);
    return rows[0]?.threadKey ?? null;
  }

  // ── handleInbound ──────────────────────────────────────────────────────────

  async function handleInbound(
    companyId: string,
    voiceAccountId: string,
    msg: InboundMessage,
  ): Promise<void> {
    const fullText = `${msg.subject ?? ""} ${msg.body}`;
    const { agentNames, roomSlugs } = parseMentions(fullText);

    // Try @room-slug first
    for (const slug of roomSlugs) {
      const room = await resolveRoomBySlug(companyId, slug);
      if (!room) continue;

      const members = await db
        .select()
        .from(roomMembers)
        .where(eq(roomMembers.roomId, room.id));

      const title = `[room:${slug}] ${msg.subject ?? msg.body.slice(0, 80)}`;
      const description = [
        `**Operator message to room #${slug}**`,
        ``,
        `From: ${msg.from}`,
        ``,
        msg.body,
      ].join("\n");

      const msgId = await storeMessage(
        companyId,
        null,
        room.id,
        "inbound",
        msg.platform,
        msg.body,
        msg.raw,
      );
      if (msg.threadKey) await storeThreadKey(msgId, msg.platform, msg.threadKey);

      for (const member of members.filter((m) => m.agentId && !m.isOperator)) {
        const issueId = await ensureIssue(companyId, member.agentId!, title, description);
        await db
          .update(operatorMessages)
          .set({ issueId })
          .where(eq(operatorMessages.id, msgId));
        await wakeAgent(companyId, member.agentId!, issueId, "room-message");
      }
      logger.info({ companyId, roomId: room.id, slug }, "operator-messaging: room fanout");
      return;
    }

    // Try @agent-name direct
    for (const name of agentNames) {
      const agent = await resolveAgentByName(companyId, name);
      if (!agent) continue;

      const title = `[direct] ${msg.subject ?? msg.body.slice(0, 80)}`;
      const description = [
        `**Direct operator message to @${name}**`,
        ``,
        `From: ${msg.from}`,
        ``,
        msg.body,
      ].join("\n");

      const issueId = await ensureIssue(companyId, agent.id, title, description);
      const msgId = await storeMessage(
        companyId,
        issueId,
        null,
        "inbound",
        msg.platform,
        msg.body,
        msg.raw,
      );
      if (msg.threadKey) await storeThreadKey(msgId, msg.platform, msg.threadKey);
      await wakeAgent(companyId, agent.id, issueId, "direct-operator-message");
      logger.info({ companyId, agentId: agent.id, name }, "operator-messaging: direct route");
      return;
    }

    // Auto-route (no mention matched)
    const agentId = await autoRouteAgent(companyId, msg.body);
    if (!agentId) {
      logger.warn({ companyId }, "operator-messaging: no agent found for auto-route");
      return;
    }

    const title = `[operator] ${msg.subject ?? msg.body.slice(0, 80)}`;
    const description = [
      `**Operator message (auto-routed)**`,
      ``,
      `From: ${msg.from}`,
      ``,
      msg.body,
    ].join("\n");

    const issueId = await ensureIssue(companyId, agentId, title, description);
    const msgId = await storeMessage(
      companyId,
      issueId,
      null,
      "inbound",
      msg.platform,
      msg.body,
      msg.raw,
    );
    if (msg.threadKey) await storeThreadKey(msgId, msg.platform, msg.threadKey);
    await wakeAgent(companyId, agentId, issueId, "operator-message-auto-routed");
    logger.info({ companyId, agentId }, "operator-messaging: auto-routed");
  }

  // ── sendToOperator ─────────────────────────────────────────────────────────

  async function sendToOperator(
    companyId: string,
    voiceAccountId: string,
    agentId: string,
    body: string,
    issueId: string | null,
    platform?: string,
  ): Promise<void> {
    // Auto-detect platform from existing thread if not specified
    if (!platform && issueId) {
      const [thread] = await db
        .select({ platform: messageThreads.platform })
        .from(messageThreads)
        .innerJoin(operatorMessages, eq(operatorMessages.id, messageThreads.operatorMessageId))
        .where(eq(operatorMessages.issueId, issueId))
        .limit(1);
      platform = thread?.platform ?? "email";
    }
    platform ??= "email";
    const adapter = getAdapter(platform);
    if (!adapter) {
      logger.warn({ platform }, "operator-messaging: no adapter registered");
      return;
    }

    const threadKey: string | null = issueId
      ? await findThreadKeyForIssue(issueId, platform)
      : null;

    const [company] = await db
      .select({ ownerEmail: companies.ownerEmail })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    const [agentRow] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    const agentName = agentRow?.name ?? "Agent";
    const to = company?.ownerEmail ? [company.ownerEmail] : [];
    if (to.length === 0) {
      logger.warn({ companyId }, "operator-messaging: no ownerEmail for outbound");
      return;
    }

    let newThreadKey: string;
    if (threadKey) {
      await adapter.reply(threadKey, `**${agentName}:** ${body}`);
      newThreadKey = threadKey;
    } else {
      const [issue] = issueId
        ? await db
            .select({ title: issues.title })
            .from(issues)
            .where(eq(issues.id, issueId))
            .limit(1)
        : [null];
      const subject = issue?.title ? `Re: ${issue.title}` : `Message from ${agentName}`;
      const sent = await adapter.send({
        to,
        subject,
        body: `**${agentName}:** ${body}`,
      });
      newThreadKey = sent.threadKey;
    }

    const msgId = await storeMessage(
      companyId,
      issueId,
      null,
      "outbound",
      platform,
      body,
      null,
      agentId,
    );
    if (newThreadKey) await storeThreadKey(msgId, platform, newThreadKey);
    logger.info({ companyId, agentId, issueId }, "operator-messaging: sent to operator");
  }

  return { handleInbound, sendToOperator, parseMentions };
}
