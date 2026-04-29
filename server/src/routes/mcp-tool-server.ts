// server/src/routes/mcp-tool-server.ts
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, issues, projects, activityLog, emailMessages, emailAttachments, emailAccounts, clients } from "@paperclipai/db";
import { and, desc, eq, gte, ilike, or } from "drizzle-orm";
import { verifyMcpToken } from "../services/mcp-session-token.js";
import { logActivity } from "../services/activity-log.js";

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_issues",
    description: "List issues for this company. Filter by status, priority, or assignee agent.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: backlog|todo|in_progress|in_review|done|cancelled" },
        priority: { type: "string", description: "Filter by priority: critical|high|medium|low" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
      },
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue. Returns the created issue with its identifier (e.g. PAP-042).",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Issue title" },
        description: { type: "string", description: "Issue description" },
        priority: { type: "string", description: "critical|high|medium|low (default: medium)" },
        status: { type: "string", description: "backlog|todo|in_progress (default: backlog)" },
        projectId: { type: "string", description: "UUID of project to assign to" },
        assigneeAgentId: { type: "string", description: "UUID of agent to assign to" },
      },
    },
  },
  {
    name: "update_issue",
    description: "Update an existing issue's status, priority, or assignee.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue to update" },
        status: { type: "string", description: "New status" },
        priority: { type: "string", description: "New priority" },
        assigneeAgentId: { type: "string", description: "New assignee agent UUID, or null to unassign" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
      },
    },
  },
  {
    name: "list_agents",
    description: "List all agents in this company with their current status and role.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: active|idle|paused|error|terminated" },
      },
    },
  },
  {
    name: "list_projects",
    description: "List all projects in this company.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_activity",
    description: "Get recent activity log entries for this company.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries (default 20, max 50)" },
        agentId: { type: "string", description: "Filter by agent UUID" },
      },
    },
  },
  {
    name: "search_emails",
    description: "Search inbound emails received by this company. Filter by sender, subject keyword, processing state, or date. Returns message summaries with attachment counts.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Filter by sender address (partial match)" },
        subject: { type: "string", description: "Filter by subject line (partial match)" },
        state: { type: "string", description: "Filter by processing state: pending|analyzing|plan_proposed|clarifying|approved|declined|executed|ignored|error" },
        since: { type: "string", description: "ISO 8601 datetime — only emails received after this (e.g. 2025-01-01T00:00:00Z)" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
      },
    },
  },
  {
    name: "get_email",
    description: "Get full details of a single email: body, headers, processing state, matched agent/client, and attachment list.",
    inputSchema: {
      type: "object",
      required: ["emailId"],
      properties: {
        emailId: { type: "string", description: "UUID of the email message" },
      },
    },
  },
  {
    name: "list_email_attachments",
    description: "List all attachments for an email message, including filename, MIME type, size in bytes, and whether it is inline.",
    inputSchema: {
      type: "object",
      required: ["emailId"],
      properties: {
        emailId: { type: "string", description: "UUID of the email message" },
      },
    },
  },
  {
    name: "list_clients",
    description: "List clients for this company. Returns names, email domains, and extra contact addresses. Use this to resolve a contact name to an email address before calling search_emails.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filter by client name (partial match)" },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleTool(
  db: Db,
  companyId: string,
  callerAgentId: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === "list_issues") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    const filters = [eq(issues.companyId, companyId)];
    if (args.status) filters.push(eq(issues.status, String(args.status)));
    if (args.priority) filters.push(eq(issues.priority, String(args.priority)));

    const rows = await db
      .select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
        status: issues.status, priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId, description: issues.description,
      })
      .from(issues)
      .where(and(...filters))
      .orderBy(desc(issues.updatedAt))
      .limit(limit);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "create_issue") {
    const title = String(args.title ?? "").trim();
    if (!title) return "Error: title is required";

    const [created] = await db
      .insert(issues)
      .values({
        companyId,
        title,
        description: args.description ? String(args.description) : null,
        priority: (args.priority as string) ?? "medium",
        status: (args.status as string) ?? "backlog",
        projectId: args.projectId ? String(args.projectId) : null,
        assigneeAgentId: args.assigneeAgentId ? String(args.assigneeAgentId) : null,
        createdByAgentId: callerAgentId,
        originKind: "chat",
      })
      .returning();

    void logActivity(db, {
      companyId, actorType: "agent", actorId: callerAgentId ?? "chat",
      action: "issue.created", entityType: "issue", entityId: created!.id,
      agentId: callerAgentId,
      details: { title, via: "mcp-chat" },
    });

    return JSON.stringify(created, null, 2);
  }

  if (name === "update_issue") {
    const issueId = String(args.issueId ?? "").trim();
    if (!issueId) return "Error: issueId is required";

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (args.status !== undefined) patch.status = String(args.status);
    if (args.priority !== undefined) patch.priority = String(args.priority);
    if (args.title !== undefined) patch.title = String(args.title);
    if (args.description !== undefined) patch.description = String(args.description);
    if ("assigneeAgentId" in args) patch.assigneeAgentId = args.assigneeAgentId ? String(args.assigneeAgentId) : null;

    const [updated] = await db
      .update(issues)
      .set(patch)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .returning();

    if (!updated) return "Error: issue not found or access denied";

    void logActivity(db, {
      companyId, actorType: "agent", actorId: callerAgentId ?? "chat",
      action: "issue.updated", entityType: "issue", entityId: issueId,
      agentId: callerAgentId, details: { patch, via: "mcp-chat" },
    });

    return JSON.stringify(updated, null, 2);
  }

  if (name === "list_agents") {
    const filters = [eq(agents.companyId, companyId)];
    if (args.status) filters.push(eq(agents.status, String(args.status)));

    const rows = await db
      .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents)
      .where(and(...filters))
      .orderBy(agents.name);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "list_projects") {
    const rows = await db
      .select({ id: projects.id, name: projects.name, status: projects.status, description: projects.description })
      .from(projects)
      .where(eq(projects.companyId, companyId))
      .orderBy(projects.name);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "get_activity") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    const filters = [eq(activityLog.companyId, companyId)];
    if (args.agentId) filters.push(eq(activityLog.agentId, String(args.agentId)));

    const rows = await db
      .select({
        id: activityLog.id, action: activityLog.action,
        actorType: activityLog.actorType, entityType: activityLog.entityType,
        details: activityLog.details, createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(...filters))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "search_emails") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    const filters: ReturnType<typeof eq>[] = [eq(emailAccounts.companyId, companyId)];
    if (args.from) filters.push(ilike(emailMessages.fromAddr, `%${String(args.from)}%`));
    if (args.subject) filters.push(ilike(emailMessages.subject, `%${String(args.subject)}%`));
    if (args.state) filters.push(eq(emailMessages.processingState, String(args.state)));
    if (args.since) {
      const since = new Date(String(args.since));
      if (!isNaN(since.getTime())) filters.push(gte(emailMessages.receivedAt, since));
    }

    const rows = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        toAddrs: emailMessages.toAddrs,
        subject: emailMessages.subject,
        receivedAt: emailMessages.receivedAt,
        processingState: emailMessages.processingState,
        matchedAgentId: emailMessages.matchedAgentId,
        matchedClientId: emailMessages.matchedClientId,
        issueId: emailMessages.issueId,
        hasAttachments: emailMessages.attachmentsPath,
      })
      .from(emailMessages)
      .innerJoin(emailAccounts, eq(emailMessages.emailAccountId, emailAccounts.id))
      .where(and(...filters))
      .orderBy(desc(emailMessages.receivedAt))
      .limit(limit);

    // Fetch attachment counts in one query
    const ids = rows.map((r) => r.id);
    const attachCounts =
      ids.length > 0
        ? await db
            .select({ emailMessageId: emailAttachments.emailMessageId, id: emailAttachments.id })
            .from(emailAttachments)
            .where(
              or(...ids.map((id) => eq(emailAttachments.emailMessageId, id))),
            )
        : [];
    const countById = attachCounts.reduce<Record<string, number>>((acc, a) => {
      acc[a.emailMessageId] = (acc[a.emailMessageId] ?? 0) + 1;
      return acc;
    }, {});

    const result = rows.map(({ hasAttachments: _, ...r }) => ({
      ...r,
      attachmentCount: countById[r.id] ?? 0,
    }));

    return JSON.stringify(result, null, 2);
  }

  if (name === "get_email") {
    const emailId = String(args.emailId ?? "").trim();
    if (!emailId) return "Error: emailId is required";

    const [row] = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        toAddrs: emailMessages.toAddrs,
        subject: emailMessages.subject,
        body: emailMessages.body,
        receivedAt: emailMessages.receivedAt,
        processedAt: emailMessages.processedAt,
        processingState: emailMessages.processingState,
        inReplyToHeader: emailMessages.inReplyToHeader,
        referencesHeaders: emailMessages.referencesHeaders,
        matchedAgentId: emailMessages.matchedAgentId,
        matchedClientId: emailMessages.matchedClientId,
        issueId: emailMessages.issueId,
        approvalId: emailMessages.approvalId,
        errorText: emailMessages.errorText,
      })
      .from(emailMessages)
      .innerJoin(emailAccounts, eq(emailMessages.emailAccountId, emailAccounts.id))
      .where(and(eq(emailMessages.id, emailId), eq(emailAccounts.companyId, companyId)))
      .limit(1);

    if (!row) return "Error: email not found or access denied";

    const attachments = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        contentType: emailAttachments.contentType,
        sizeBytes: emailAttachments.sizeBytes,
        isInline: emailAttachments.isInline,
        contentId: emailAttachments.contentId,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, emailId));

    return JSON.stringify({ ...row, attachments }, null, 2);
  }

  if (name === "list_email_attachments") {
    const emailId = String(args.emailId ?? "").trim();
    if (!emailId) return "Error: emailId is required";

    // Verify company access via the parent message
    const [msg] = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .innerJoin(emailAccounts, eq(emailMessages.emailAccountId, emailAccounts.id))
      .where(and(eq(emailMessages.id, emailId), eq(emailAccounts.companyId, companyId)))
      .limit(1);

    if (!msg) return "Error: email not found or access denied";

    const attachments = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        contentType: emailAttachments.contentType,
        sizeBytes: emailAttachments.sizeBytes,
        isInline: emailAttachments.isInline,
        contentId: emailAttachments.contentId,
        createdAt: emailAttachments.createdAt,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, emailId))
      .orderBy(emailAttachments.createdAt);

    return JSON.stringify(attachments, null, 2);
  }

  if (name === "list_clients") {
    const filters = [eq(clients.companyId, companyId)];
    if (args.name) filters.push(ilike(clients.name, `%${String(args.name)}%`));

    const rows = await db
      .select({
        id: clients.id,
        name: clients.name,
        emailDomain: clients.emailDomain,
        extraEmails: clients.extraEmails,
        trustLevel: clients.trustLevel,
        notes: clients.notes,
      })
      .from(clients)
      .where(and(...filters))
      .orderBy(clients.name);

    return JSON.stringify(rows, null, 2);
  }

  return `Error: unknown tool "${name}"`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function mcpToolServerRoutes(db: Db): Router {
  const router = Router();

  router.post("/mcp", async (req, res) => {
    // Validate Bearer token
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const payload = verifyMcpToken(token);
    if (!payload) {
      res.status(401).json(err(null, -32600, "Unauthorized: invalid or expired MCP session token"));
      return;
    }

    const { companyId, agentId } = payload;
    const body = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

    if (body.jsonrpc !== "2.0") {
      res.json(err(body.id ?? null, -32600, "Invalid JSON-RPC version"));
      return;
    }

    const method = body.method ?? "";
    const id = body.id ?? null;

    if (method === "initialize") {
      res.json(ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "paperclip", version: "1.0.0" },
      }));
      return;
    }

    if (method === "notifications/initialized") {
      res.status(204).end();
      return;
    }

    if (method === "ping") {
      res.json(ok(id, {}));
      return;
    }

    if (method === "tools/list") {
      res.json(ok(id, { tools: TOOLS }));
      return;
    }

    if (method === "tools/call") {
      const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = params?.name ?? "";
      const toolArgs = params?.arguments ?? {};

      try {
        const result = await handleTool(db, companyId, agentId, toolName, toolArgs);
        res.json(ok(id, textContent(result)));
      } catch (toolErr) {
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        res.json(ok(id, textContent(`Error executing ${toolName}: ${msg}`)));
      }
      return;
    }

    res.json(err(id, -32601, `Method not found: ${method}`));
  });

  return router;
}
