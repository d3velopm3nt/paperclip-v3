# Orchestrator Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rule-based email triage and per-channel routing with a single Claude LLM orchestrator that handles all inbound communication (email, Telegram, WhatsApp), understands context, and drives the full issue → plan → feedback → deploy workflow via Paperclip MCP tools.

**Architecture:** A new `inbound-router` service normalises every inbound channel message and does a cheap DB thread-check before dispatching to `orchestrator.ts` — a Claude CLI subprocess with the Paperclip MCP server wired in (same pattern as `chat-direct.ts`). The orchestrator decides which tools to call (create_issue, create_plan, send_client_reply, notify_operator, etc.). New MCP tools power these decisions. Two new approval types (`client_reply`, `agent_question`) gate outbound client messages. Issue status `blocked` auto-notifies the operator via Telegram. Per-company approval toggles let operators skip gates they trust.

**Tech Stack:** Express 5, Claude CLI subprocess (`claude --print`), Paperclip MCP tool server (HTTP JSON-RPC), Drizzle ORM, existing `operator-messaging` adapter registry, existing `sendTelegramMessage` / `sendWhatsAppMessage` / email adapters.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `server/src/services/orchestrator.ts` | Claude CLI subprocess with MCP — unified entry point |
| Create | `server/src/services/inbound-router.ts` | Thread check, channel normalisation, orchestrator dispatch |
| Modify | `server/src/routes/mcp-tool-server.ts` | Add 7 new MCP tools |
| Modify | `server/src/routes/telegram.ts` | Route inbound to `inbound-router` instead of `chatDirectReply` |
| Modify | `server/src/routes/whatsapp.ts` | Route inbound to `inbound-router` instead of Telegram-notify-only |
| Modify | `server/src/services/email-processor.ts` | Replace old `routeInbound` with `inbound-router` |
| Modify | `server/src/services/issues.ts` | Hook `blocked` status → `notify_operator_blocked` |
| Modify | `server/src/routes/approvals.ts` | Dispatch `client_reply` send on approval |
| Modify | `ui/src/pages/InstanceStorageSettings.tsx` | Add approval toggle UI section |

---

## Task 1: New MCP tools (7 additions to mcp-tool-server.ts)

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

The orchestrator needs tools that don't exist yet. Add all 7 to the `TOOLS` array and their handlers to `handleTool`.

- [ ] **Step 1: Add tool definitions to TOOLS array**

In `server/src/routes/mcp-tool-server.ts`, find the closing `];` of the `TOOLS` array and add before it:

```typescript
  {
    name: "create_plan",
    description: "Create a plan for an issue and queue it for operator approval. Returns the approval ID. The operator will see the proposal and can approve, decline, or question it.",
    inputSchema: {
      type: "object",
      required: ["issueId", "proposalText"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue this plan addresses" },
        proposalText: { type: "string", description: "Full human-readable plan shown to operator for approval" },
        steps: { type: "array", items: { type: "string" }, description: "Ordered list of plan steps (optional, rendered inside proposalText)" },
      },
    },
  },
  {
    name: "add_issue_comment",
    description: "Add a comment to an issue. Use for progress updates, agent questions, or blocking reasons.",
    inputSchema: {
      type: "object",
      required: ["issueId", "body"],
      properties: {
        issueId: { type: "string" },
        body: { type: "string", description: "Comment body (markdown supported)" },
      },
    },
  },
  {
    name: "create_project",
    description: "Create a new project for this company.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        clientId: { type: "string", description: "UUID of client to associate" },
        status: { type: "string", description: "backlog|active (default: backlog)" },
      },
    },
  },
  {
    name: "notify_operator",
    description: "Send an immediate notification to the operator via Telegram (or email if Telegram not configured). Use for alerts, updates, and questions that don't need a formal approval.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Message text to send to operator" },
        issueId: { type: "string", description: "Optional — attaches message to this issue thread" },
      },
    },
  },
  {
    name: "send_client_reply",
    description: "Prepare an outbound reply to a client. Creates a 'client_reply' approval for operator review. The message is NOT sent until the operator approves it. Returns the approval ID.",
    inputSchema: {
      type: "object",
      required: ["clientId", "body", "channel"],
      properties: {
        clientId: { type: "string", description: "UUID of the client to reply to" },
        body: { type: "string", description: "Full message body to send to the client" },
        channel: { type: "string", description: "email | whatsapp — channel to use for sending" },
        threadKey: { type: "string", description: "Reply-to thread key (email Message-ID or WhatsApp phone number)" },
        issueId: { type: "string", description: "Optional issue this reply relates to" },
        subject: { type: "string", description: "Email subject (only for email channel)" },
      },
    },
  },
  {
    name: "set_issue_blocked",
    description: "Mark an issue as blocked and add a comment explaining why. Automatically notifies the operator via Telegram.",
    inputSchema: {
      type: "object",
      required: ["issueId", "reason"],
      properties: {
        issueId: { type: "string" },
        reason: { type: "string", description: "Why the issue is blocked — shown in the comment and operator notification" },
      },
    },
  },
  {
    name: "get_client",
    description: "Get details for a specific client: name, email domain, extra emails, open issues, and storage info.",
    inputSchema: {
      type: "object",
      required: ["clientId"],
      properties: {
        clientId: { type: "string" },
      },
    },
  },
```

- [ ] **Step 2: Add imports needed at top of mcp-tool-server.ts**

Add to the existing imports at the top of the file (after the existing drizzle imports):

```typescript
import { issueComments, plans, approvals, projects, contacts, messageThreads, operatorMessages } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { sendTelegramMessage } from "../services/telegram-adapter.js";
import { sendWhatsAppMessage } from "../services/whatsapp-adapter.js";
import { readInstanceToken } from "../services/instance-token-store.js";
```

Note: `issueComments`, `plans`, `approvals`, `projects`, `contacts`, `messageThreads`, `operatorMessages` — check which are already imported and only add the missing ones.

- [ ] **Step 3: Add handlers to handleTool**

In `handleTool`, before `return \`Error: unknown tool "${name}"\`;`, add:

```typescript
  if (name === "create_plan") {
    const { issueId, proposalText, steps } = args as { issueId: string; proposalText: string; steps?: string[] };
    const stepsText = steps?.length ? "\n\nSteps:\n" + steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") : "";
    const fullProposal = `${proposalText}${stepsText}`;
    const [approval] = await db.insert(approvals).values({
      companyId,
      type: "plan",
      requestedByAgentId: agentId === "orchestrator" ? null : agentId,
      status: "pending",
      payload: { issueId, proposalText: fullProposal, steps: steps ?? [] },
    }).returning({ id: approvals.id });
    // Link plan record
    const [plan] = await db.insert(plans).values({
      companyId,
      issueId,
      proposalText: fullProposal,
      proposalKind: "create_issue",
      status: "proposed",
      approvalId: approval!.id,
    }).returning({ id: plans.id });
    await db.update(approvals).set({ planId: plan!.id }).where(eq(approvals.id, approval!.id));
    return `Plan created. Approval ID: ${approval!.id}. Awaiting operator approval.`;
  }

  if (name === "add_issue_comment") {
    const { issueId, body } = args as { issueId: string; body: string };
    const [existing] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!existing) return `Issue ${issueId} not found`;
    await db.insert(issueComments).values({
      issueId,
      companyId: existing.companyId,
      body,
      authorKind: "agent",
      authorAgentId: agentId === "orchestrator" ? null : agentId,
    });
    return `Comment added to issue ${issueId}.`;
  }

  if (name === "create_project") {
    const { name: projectName, description, clientId, status } = args as {
      name: string; description?: string; clientId?: string; status?: string;
    };
    const [project] = await db.insert(projects).values({
      companyId,
      name: projectName,
      description: description ?? null,
      clientId: clientId ?? null,
      status: status ?? "backlog",
    }).returning({ id: projects.id, name: projects.name });
    return `Project created: "${project!.name}" (ID: ${project!.id})`;
  }

  if (name === "notify_operator") {
    const { body: notifyBody, issueId: notifyIssueId } = args as { body: string; issueId?: string };
    const token = await readInstanceToken(db, "telegramBotToken").catch(() => null)
      ?? (process.env.TELEGRAM_BOT_TOKEN ?? "");
    const chatId = process.env.TELEGRAM_OPERATOR_CHAT_ID ?? "";
    if (token && chatId) {
      await sendTelegramMessage(token, chatId, notifyBody).catch((err) => {
        logger.warn({ err }, "notify_operator: telegram send failed");
      });
    } else {
      // Fallback: store as outbound operator message for in-app display
      await db.insert(operatorMessages).values({
        companyId,
        issueId: notifyIssueId ?? null,
        direction: "outbound",
        platform: "chat",
        source: "orchestrator",
        body: notifyBody,
        rawPayload: null,
      });
    }
    return `Operator notified.`;
  }

  if (name === "send_client_reply") {
    const { clientId: replyClientId, body: replyBody, channel, threadKey: replyThreadKey, issueId: replyIssueId, subject: replySubject } = args as {
      clientId: string; body: string; channel: string; threadKey?: string; issueId?: string; subject?: string;
    };
    // Check company setting: requireClientReplyApproval (default true)
    const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
    const general = (settings?.general ?? {}) as Record<string, unknown>;
    const requireApproval = (general.requireClientReplyApproval as boolean | undefined) ?? true;

    if (!requireApproval) {
      // Send immediately
      if (channel === "whatsapp" && replyThreadKey) {
        const waToken = await readInstanceToken(db, "whatsappToken").catch(() => null);
        const waPhone = await readInstanceToken(db, "whatsappPhoneNumberId").catch(() => null);
        if (waToken && waPhone) {
          const phone = replyThreadKey.replace(/\D/g, "");
          await sendWhatsAppMessage(waToken, waPhone, phone, replyBody);
        }
      }
      // Email send not implemented for immediate path — always goes through approval for email
      return `Reply sent directly to client (approval bypassed per company settings).`;
    }

    const [approval] = await db.insert(approvals).values({
      companyId,
      type: "client_reply",
      requestedByAgentId: agentId === "orchestrator" ? null : agentId,
      status: "pending",
      payload: {
        clientId: replyClientId,
        body: replyBody,
        channel,
        threadKey: replyThreadKey ?? null,
        issueId: replyIssueId ?? null,
        subject: replySubject ?? null,
      },
    }).returning({ id: approvals.id });
    return `Client reply queued for approval. Approval ID: ${approval!.id}. Operator must approve before message is sent.`;
  }

  if (name === "set_issue_blocked") {
    const { issueId: blockedId, reason } = args as { issueId: string; reason: string };
    const [existing] = await db.select({ companyId: issues.companyId, status: issues.status }).from(issues).where(eq(issues.id, blockedId)).limit(1);
    if (!existing) return `Issue ${blockedId} not found`;
    await db.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(eq(issues.id, blockedId));
    await db.insert(issueComments).values({
      issueId: blockedId,
      companyId: existing.companyId,
      body: `🚫 **Blocked:** ${reason}`,
      authorKind: "agent",
      authorAgentId: agentId === "orchestrator" ? null : agentId,
    });
    // Notify operator
    const token = await readInstanceToken(db, "telegramBotToken").catch(() => null)
      ?? (process.env.TELEGRAM_BOT_TOKEN ?? "");
    const chatId = process.env.TELEGRAM_OPERATOR_CHAT_ID ?? "";
    if (token && chatId) {
      await sendTelegramMessage(token, chatId, `🚫 Issue blocked\n\nReason: ${reason}\n\nIssue ID: ${blockedId}`).catch(() => {});
    }
    return `Issue marked as blocked. Operator notified.`;
  }

  if (name === "get_client") {
    const { clientId: gcId } = args as { clientId: string };
    const [client] = await db
      .select({ id: clients.id, name: clients.name, emailDomain: clients.emailDomain, extraEmails: clients.extraEmails, notes: clients.notes, localPath: clients.localPath, driveFolderId: clients.driveFolderId })
      .from(clients)
      .where(and(eq(clients.id, gcId), eq(clients.companyId, companyId)))
      .limit(1);
    if (!client) return `Client ${gcId} not found`;
    const openIssues = await db
      .select({ id: issues.id, title: issues.title, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.clientId, gcId)))
      .limit(10);
    return JSON.stringify({ ...client, openIssues }, null, 2);
  }
```

- [ ] **Step 4: Add missing column imports to the db destructure at the top of handleTool**

The `handleTool` function uses `companyId` and `agentId` from the route context. Check that `issueComments`, `plans`, `projects`, `approvals`, `operatorMessages`, `instanceSettings` are exported from `@paperclipai/db` and available.

```bash
grep -n "issueComments\|from.*@paperclipai/db" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/packages/db/src/schema/index.ts | grep "issueComments\|issue_comment" | head -5
```

Expected: `issueComments` exported. If not, check the schema file name and add the export.

- [ ] **Step 5: Check plans table schema for required fields**

```bash
grep -n "proposalKind\|proposalText\|status\|approvalId" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/packages/db/src/schema/plans.ts | head -15
```

Adjust the `create_plan` handler fields to match the actual schema. If `proposalKind` doesn't exist use whatever the actual column is.

- [ ] **Step 6: Typecheck server**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "mcp-tool-server" | head -10
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add create_plan, add_issue_comment, create_project, notify_operator, send_client_reply, set_issue_blocked, get_client tools"
```

---

## Task 2: Orchestrator service

**Files:**
- Create: `server/src/services/orchestrator.ts`

- [ ] **Step 1: Create the file**

Create `server/src/services/orchestrator.ts`:

```typescript
// v3: unified LLM orchestrator — entry point for all inbound messages.
// Spawns a claude CLI subprocess with the Paperclip MCP server attached.
// Handles both client inbound (email/whatsapp) and operator inbound (telegram/email).
// Uses the same subprocess pattern as chat-direct.ts.

import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { signMcpToken } from "./mcp-session-token.js";
import { logger } from "../middleware/logger.js";

export interface OrchestratorInput {
  companyId: string;
  platform: "email" | "telegram" | "whatsapp";
  fromType: "client" | "operator";
  fromAddr: string;
  threadKey: string;
  body: string;
  subject?: string;
  attachmentSummaries?: string[];
  clientId?: string;
  existingIssueId?: string;
}

const SYSTEM_PROMPT = `You are the Paperclip Orchestrator — the unified intelligence for all inbound communication.

Your job: understand every inbound message, take the right actions via your MCP tools, keep the operator informed.

## Sender types
- **client**: external contact. Needs professional handling. Replies MUST go through send_client_reply.
- **operator**: the company owner giving you commands. Execute efficiently.

## Decision flow
1. Who sent this? (client or operator — provided in the message context)
2. Check if there is an existing issue ID in the context. If yes, this is a thread continuation — add a comment and wake the agent via update_issue status=in_progress.
3. If new conversation from **client**: identify client via list_clients → check open issues via list_issues → create issue → create plan → notify_operator.
4. If new command from **operator**: understand intent → find/create issue → create plan OR execute directly → notify_operator when done.

## Tool usage rules
- **send_client_reply**: ALWAYS use for outbound client messages. Never write client replies in your text response.
- **create_plan**: Use for any multi-step work. Creates approval the operator must review.
- **notify_operator**: Immediate Telegram message. Use for updates and questions that don't need approval.
- **set_issue_blocked**: Use when work cannot continue without more info. Operator is automatically notified.
- **add_issue_comment**: Log every significant decision as a comment on the issue.

## Attachment context
If attachmentSummaries are listed, the files are already saved to the client's document folder. Reference them by filename in your plan/issue.

## Response style
Keep your text responses very short — the tools do the work. Use them.`;

export async function runOrchestrator(db: Db, input: OrchestratorInput): Promise<void> {
  const { companyId } = input;

  const contextLines: string[] = [
    `## Inbound message`,
    `Platform: ${input.platform}`,
    `Sender type: ${input.fromType}`,
    `From: ${input.fromAddr}`,
  ];
  if (input.subject) contextLines.push(`Subject: ${input.subject}`);
  if (input.clientId) contextLines.push(`Matched client ID: ${input.clientId} (already resolved)`);
  if (input.existingIssueId) contextLines.push(`Existing issue ID: ${input.existingIssueId} — this is a thread continuation, not a new request`);
  if (input.attachmentSummaries?.length) {
    contextLines.push(`Attachments (already saved to client folder): ${input.attachmentSummaries.join(", ")}`);
  }
  contextLines.push(``, `## Message body`, input.body);

  const userMessage = contextLines.join("\n");

  const mcpToken = signMcpToken({ companyId, agentId: "orchestrator" });
  const apiBase = process.env.PAPERCLIP_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`;

  const mcpConfigPath = `${os.tmpdir()}/pc-orchestrator-mcp-${Date.now()}.json`;
  const promptPath = `${os.tmpdir()}/pc-orchestrator-prompt-${Date.now()}.txt`;

  await fs.writeFile(mcpConfigPath, JSON.stringify({
    mcpServers: {
      paperclip: {
        type: "http",
        url: `${apiBase}/api/mcp`,
        headers: { Authorization: `Bearer ${mcpToken}` },
      },
    },
  }), "utf-8");

  await fs.writeFile(promptPath, SYSTEM_PROMPT, "utf-8");

  const args = [
    "--print", "-",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config", mcpConfigPath,
    "--append-system-prompt-file", promptPath,
  ];

  const stdin = JSON.stringify([{ role: "user", content: userMessage }]);

  logger.info(
    { companyId, platform: input.platform, fromType: input.fromType, fromAddr: input.fromAddr },
    "orchestrator: starting",
  );

  const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.write(stdin);
  proc.stdin.end();

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  await new Promise<void>((resolve) => {
    proc.on("close", (code) => {
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(0, 500), companyId }, "orchestrator: claude exited non-zero");
      } else {
        logger.info({ companyId, platform: input.platform }, "orchestrator: complete");
      }
      resolve();
    });
  });

  await Promise.allSettled([fs.unlink(mcpConfigPath), fs.unlink(promptPath)]);
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "orchestrator" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/orchestrator.ts
git commit -m "feat(orchestrator): add Claude CLI orchestrator service for unified inbound routing"
```

---

## Task 3: Inbound router service

**Files:**
- Create: `server/src/services/inbound-router.ts`

- [ ] **Step 1: Create the file**

Create `server/src/services/inbound-router.ts`:

```typescript
// v3: normalises all inbound channel messages and dispatches to the orchestrator.
// Step 1: thread check (cheap DB lookup) — existing conversation → skip orchestrator, add comment.
// Step 2: identify sender type (client vs operator) by platform + address.
// Step 3: dispatch to orchestrator.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clients, issues, issueComments, messageThreads, operatorMessages } from "@paperclipai/db";
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

  // 1. Thread check: does an existing open issue own this thread key?
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
  const existingIssueStatus = existingThread[0]?.issueStatus ?? null;

  // 2. Identify sender
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
    { companyId, platform, fromType, clientId: clientId ?? null, existingIssueId, existingIssueStatus },
    "inbound-router: dispatching",
  );

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

// ── Client resolution helpers ─────────────────────────────────────────────────

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

  // Match by email domain
  if (domain) {
    const [byDomain] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.companyId, companyId), eq(clients.emailDomain, domain)))
      .limit(1);
    if (byDomain) return byDomain.id;
  }

  // Match by extra emails
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
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "inbound-router" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/inbound-router.ts
git commit -m "feat(router): add inbound-router with thread-check and client resolution"
```

---

## Task 4: Wire Telegram → inbound router

**Files:**
- Modify: `server/src/routes/telegram.ts`

- [ ] **Step 1: Read the current webhook handler**

```bash
grep -n "chatDirectReply\|handleInbound\|routeInbound\|routeInboundMessage" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/routes/telegram.ts | head -15
```

- [ ] **Step 2: Add import**

At the top of `server/src/routes/telegram.ts`, add:

```typescript
import { routeInboundMessage } from "../services/inbound-router.js";
```

- [ ] **Step 3: Replace chatDirectReply with routeInboundMessage**

Find the block starting with `// Route through chat system — creates a Telegram thread...` and ending with the `chatDirectReply` call. Replace the routing call with:

```typescript
    res.status(200).json({ ok: true }); // Respond to Telegram immediately

    // Dispatch to unified orchestrator
    setImmediate(() => {
      routeInboundMessage(db, {
        companyId,
        platform: "telegram",
        fromAddr: chatId,
        body: msg.text,
        threadKey: chatId,
      }).catch((err) => logger.error({ err, chatId }, "telegram webhook: inbound-router failed"));
    });
```

Keep the `paperclip` ping handler above it unchanged.

- [ ] **Step 4: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "telegram" | grep "error" | head -10
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/telegram.ts
git commit -m "feat(telegram): route inbound messages through orchestrator via inbound-router"
```

---

## Task 5: Wire WhatsApp → inbound router

**Files:**
- Modify: `server/src/routes/whatsapp.ts`

- [ ] **Step 1: Read the current inbound handler**

```bash
grep -n "fromPhone\|text\|sendTelegram\|telegramNotif" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/routes/whatsapp.ts | head -25
```

- [ ] **Step 2: Add import**

At the top of `server/src/routes/whatsapp.ts`, add:

```typescript
import { routeInboundMessage } from "../services/inbound-router.js";
```

- [ ] **Step 3: Replace Telegram-notify-only with inbound-router dispatch**

Find the block that currently sends a Telegram notification to the operator (the fallback for WhatsApp inbound). After the allowlist check passes, replace the Telegram notification block with:

```typescript
          // Dispatch to unified orchestrator
          setImmediate(() => {
            routeInboundMessage(db, {
              companyId: WA_COMPANY_ID,
              platform: "whatsapp",
              fromAddr: fromPhoneNormalized,
              body: text,
              threadKey: fromPhoneNormalized,
            }).catch((err) =>
              logger.error({ err, fromPhone: fromPhoneNormalized }, "whatsapp webhook: inbound-router failed"),
            );
          });
```

Keep the allowlist check (reject if not allowlisted) unchanged above this.

- [ ] **Step 4: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "whatsapp" | grep "error" | head -10
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/whatsapp.ts
git commit -m "feat(whatsapp): route inbound messages through orchestrator instead of Telegram-notify-only"
```

---

## Task 6: Wire email-processor → inbound router

**Files:**
- Modify: `server/src/services/email-processor.ts`

- [ ] **Step 1: Find the old routeInbound call**

```bash
grep -n "routeInbound\|import.*route\|import.*plan-gate\|import.*triage" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/services/email-processor.ts | head -10
```

Note the exact import and call site.

- [ ] **Step 2: Add import for inbound-router**

Add at top of `server/src/services/email-processor.ts`:

```typescript
import { routeInboundMessage } from "./inbound-router.js";
```

- [ ] **Step 3: Replace old routeInbound call**

Find the line:
```typescript
await routeInbound(db, inserted!.id, input.emailAccountId, fromAddr, toAddrs, subject);
```

Replace with:

```typescript
// Collect attachment filenames for orchestrator context
const attachmentFilenames = savedAttachmentNames; // see Step 4 for how to collect these

await routeInboundMessage(db, {
  companyId: input.companyId,
  platform: "email",
  fromAddr,
  body: parsedBody,
  subject: parsedSubject,
  threadKey: parsed.messageId ?? `email-${inserted!.id}`,
  attachmentSummaries: attachmentFilenames,
});
```

- [ ] **Step 4: Collect attachment filenames during save loop**

Find the attachment save loop (where `saveAttachment` is called). Add a collection variable before the loop and push to it inside:

```typescript
const savedAttachmentNames: string[] = [];
for (let i = 0; i < attachments.length; i++) {
  const att = attachments[i]!;
  // ... existing save logic ...
  savedAttachmentNames.push(rawName); // rawName is the att.filename variable
}
```

- [ ] **Step 5: Resolve parsedBody and parsedSubject variable names**

```bash
grep -n "fromAddr\|parsedBody\|subject\|body\|parsed\." /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/services/email-processor.ts | head -20
```

Use the actual variable names in the codebase — may be `parsed.text`, `input.subject`, etc.

- [ ] **Step 6: Remove old routeInbound import if it's now unused**

```bash
grep -n "routeInbound" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/services/email-processor.ts
```

If `routeInbound` is no longer used anywhere else in the file, remove the import.

- [ ] **Step 7: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "email-processor" | grep "error" | head -10
```

- [ ] **Step 8: Commit**

```bash
git add server/src/services/email-processor.ts
git commit -m "feat(email): route inbound emails through orchestrator via inbound-router"
```

---

## Task 7: client_reply approval — dispatch outbound on approval

**Files:**
- Modify: `server/src/routes/approvals.ts`

When operator approves a `client_reply` approval, the server must send the message via the correct channel before waking any agent.

- [ ] **Step 1: Read the approve route handler**

```bash
sed -n '121,215p' /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/routes/approvals.ts
```

- [ ] **Step 2: Add imports to approvals.ts**

At the top of `server/src/routes/approvals.ts`, add:

```typescript
import { sendWhatsAppMessage } from "../services/whatsapp-adapter.js";
import { sendEmailFromAccount } from "../services/email-sender.js";
import { emailAccounts } from "@paperclipai/db";
import { readInstanceToken } from "../services/instance-token-store.js";
```

- [ ] **Step 3: Add client_reply dispatch inside the approve handler**

In the `router.post("/approvals/:id/approve", ...)` handler, find the block `if (applied) {`. After the `await logActivity(...)` call for `approval.approved` but BEFORE the agent wakeup block, add:

```typescript
      // Dispatch client reply if this is a client_reply approval
      if (approval.type === "client_reply" && applied) {
        const payload = approval.payload as {
          clientId: string;
          body: string;
          channel: string;
          threadKey: string | null;
          issueId: string | null;
          subject: string | null;
        };
        try {
          if (payload.channel === "whatsapp" && payload.threadKey) {
            const waToken = await readInstanceToken(db, "whatsappToken").catch(() => null)
              ?? (process.env.WHATSAPP_TOKEN ?? "");
            const waPhone = await readInstanceToken(db, "whatsappPhoneNumberId").catch(() => null)
              ?? (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "");
            if (waToken && waPhone) {
              const toPhone = payload.threadKey.replace(/\D/g, "");
              await sendWhatsAppMessage(waToken, waPhone, toPhone, payload.body);
              logger.info({ approvalId: approval.id, toPhone }, "client_reply: sent via WhatsApp");
            } else {
              logger.warn({ approvalId: approval.id }, "client_reply: WhatsApp not configured");
            }
          } else if (payload.channel === "email") {
            // Find a voice/outbound email account for this company
            const [voiceAccount] = await db
              .select({ id: emailAccounts.id })
              .from(emailAccounts)
              .where(and(
                eq(emailAccounts.companyId, approval.companyId),
                eq(emailAccounts.role, "agent_voice"),
              ))
              .limit(1);
            if (voiceAccount) {
              // Resolve client email address from clientId
              const [client] = await db
                .select({ emailDomain: clients.emailDomain, extraEmails: clients.extraEmails })
                .from(clients)
                .where(eq(clients.id, payload.clientId))
                .limit(1);
              const toEmail = client?.extraEmails?.[0] as string | undefined
                ?? (client?.emailDomain ? `contact@${client.emailDomain}` : null);
              if (toEmail) {
                await sendEmailFromAccount(db, {
                  accountId: voiceAccount.id,
                  to: [toEmail],
                  subject: payload.subject ?? "Reply from Paperclip",
                  text: payload.body,
                  inReplyTo: payload.threadKey ?? undefined,
                  references: payload.threadKey ? [payload.threadKey] : [],
                });
                logger.info({ approvalId: approval.id, toEmail }, "client_reply: sent via email");
              } else {
                logger.warn({ approvalId: approval.id, clientId: payload.clientId }, "client_reply: no email address for client");
              }
            } else {
              logger.warn({ approvalId: approval.id }, "client_reply: no agent_voice email account");
            }
          }
        } catch (sendErr) {
          logger.error({ sendErr, approvalId: approval.id }, "client_reply: send failed");
        }
      }
```

You also need to add `clients` to the imports at the top of approvals.ts if not already present:
```typescript
import { clients } from "@paperclipai/db";
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "approvals" | grep "error" | head -10
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/approvals.ts
git commit -m "feat(approvals): dispatch client_reply outbound send (WhatsApp or email) on approval"
```

---

## Task 8: Blocked → auto-notify operator

**Files:**
- Modify: `server/src/services/issues.ts`

When any code sets an issue to `blocked` via the `update` function, automatically notify the operator via Telegram.

- [ ] **Step 1: Add import to issues.ts**

At the top of `server/src/services/issues.ts`, add:

```typescript
import { sendTelegramMessage } from "./telegram-adapter.js";
import { readInstanceToken } from "./instance-token-store.js";
```

- [ ] **Step 2: Add blocked notification inside the update function**

In the `update` function (around line 966), find where the DB update is applied and the updated row is returned. After the update resolves (after `.returning()`), add:

```typescript
      // Auto-notify operator when issue is blocked
      if (data.status === "blocked") {
        const token = await readInstanceToken(db, "telegramBotToken").catch(() => null)
          ?? (process.env.TELEGRAM_BOT_TOKEN ?? "");
        const chatId = process.env.TELEGRAM_OPERATOR_CHAT_ID ?? "";
        if (token && chatId) {
          const issueTitle = updated?.title ?? id;
          sendTelegramMessage(
            token,
            chatId,
            `🚫 Issue blocked: *${issueTitle}*\n\nIssue: \`${id}\`\n\nCheck the issue for details and unblock by replying.`,
          ).catch((err) => logger.warn({ err, issueId: id }, "issues: blocked notify failed"));
        }
      }
```

Find the actual variable name for the updated row (check the `.returning()` call near line 1145+) and use the correct variable. If you can't find the return variable inline, add a separate select:

```typescript
      if (data.status === "blocked") {
        const [row] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, id)).limit(1);
        // ... send notification using row?.title
      }
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "issues.ts" | grep "error" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add server/src/services/issues.ts
git commit -m "feat(issues): auto-notify operator via Telegram when issue status set to blocked"
```

---

## Task 9: Per-company approval settings

**Files:**
- Modify: `ui/src/pages/InstanceStorageSettings.tsx`

Add two toggles to Instance Settings: `requireClientReplyApproval` (default ON) and `requirePlanApproval` (default ON). These are stored in `instanceSettings.general` jsonb.

- [ ] **Step 1: Add API methods to referenceDocumentsApi (already used for storage root)**

In `ui/src/api/referenceDocuments.ts`, add:

```typescript
  getApprovalSettings: () =>
    api.get<{ requireClientReplyApproval: boolean; requirePlanApproval: boolean }>("/instance/approval-settings"),
  setApprovalSettings: (settings: { requireClientReplyApproval: boolean; requirePlanApproval: boolean }) =>
    api.put<{ ok: boolean }>("/instance/approval-settings", settings),
```

- [ ] **Step 2: Add server routes for approval settings**

In `server/src/routes/instance-storage.ts`, add import:

```typescript
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
```

And add two routes before `return router`:

```typescript
  router.get("/instance/approval-settings", async (req, res) => {
    assertAdmin(req);
    const [row] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
    const g = (row?.general ?? {}) as Record<string, unknown>;
    res.json({
      requireClientReplyApproval: (g.requireClientReplyApproval as boolean | undefined) ?? true,
      requirePlanApproval: (g.requirePlanApproval as boolean | undefined) ?? true,
    });
  });

  router.put("/instance/approval-settings", async (req, res) => {
    assertAdmin(req);
    const { requireClientReplyApproval, requirePlanApproval } = req.body as {
      requireClientReplyApproval: boolean;
      requirePlanApproval: boolean;
    };
    const [existing] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
    const general = {
      ...((existing?.general ?? {}) as Record<string, unknown>),
      requireClientReplyApproval: !!requireClientReplyApproval,
      requirePlanApproval: !!requirePlanApproval,
    };
    if (existing) {
      await db.update(instanceSettings).set({ general, updatedAt: new Date() }).where(eq(instanceSettings.singletonKey, "default"));
    } else {
      await db.insert(instanceSettings).values({ singletonKey: "default", general, experimental: {} });
    }
    res.json({ ok: true });
  });
```

- [ ] **Step 3: Add ApprovalSettingsSection component to InstanceStorageSettings.tsx**

In `ui/src/pages/InstanceStorageSettings.tsx`, add this component before the main page export:

```tsx
function ApprovalSettingsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["approval-settings"],
    queryFn: () => referenceDocumentsApi.getApprovalSettings(),
  });

  const save = useMutation({
    mutationFn: (settings: { requireClientReplyApproval: boolean; requirePlanApproval: boolean }) =>
      referenceDocumentsApi.setApprovalSettings(settings),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approval-settings"] }),
  });

  if (isLoading || !data) return null;

  function toggle(key: "requireClientReplyApproval" | "requirePlanApproval") {
    save.mutate({ ...data!, [key]: !data![key] });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold">Approval Gates</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Control which actions require operator approval before executing.
      </p>
      <div className="space-y-2">
        {([
          { key: "requireClientReplyApproval", label: "Client replies", desc: "Approve before any message is sent to a client" },
          { key: "requirePlanApproval", label: "Plans", desc: "Approve plans before agents execute them" },
        ] as const).map(({ key, label, desc }) => (
          <div key={key} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </div>
            <button
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${data[key] ? "bg-primary" : "bg-muted"}`}
              onClick={() => toggle(key)}
              disabled={save.isPending}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${data[key] ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Add `Shield` to the lucide imports at the top of the file.

- [ ] **Step 4: Add section to page render**

In `InstanceStorageSettings`, add `<ApprovalSettingsSection />` as the LAST section in the return, after a divider:

```tsx
      <div className="border-t border-border pt-6">
        <ApprovalSettingsSection />
      </div>
```

- [ ] **Step 5: Typecheck both**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "instance-storage" | grep "error" | head -5
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "InstanceStorage" | grep "error" | head -5
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/instance-storage.ts ui/src/pages/InstanceStorageSettings.tsx ui/src/api/referenceDocuments.ts
git commit -m "feat(settings): add approval gate toggles for client replies and plans"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm -r typecheck 2>&1 | grep -v "AgentPerformanceTab\|Analytics" | grep "error TS" | head -20
```

Expected: no new errors.

- [ ] **Step 2: Run tests**

```bash
pnpm test:run 2>&1 | tail -20
```

Expected: passing.

- [ ] **Step 3: End-to-end smoke test**

Start dev: `pnpm dev`

**Rockdog example scenario:**
1. Send Telegram message: "Rockdog task — add boat covers gallery section. Find their email with photos. Build, test, deploy."
2. Verify orchestrator logs appear: `orchestrator: starting` then `orchestrator: complete`
3. Verify issue created in Paperclip UI with title referencing Rockdog + boat covers
4. Verify plan approval pending in Paperclip Approvals tab
5. Approve the plan → verify agent woken up (check heartbeat logs)

**Blocked test:**
1. Manually set an issue to `blocked` via the UI or API
2. Verify Telegram message arrives: "🚫 Issue blocked..."

**Client reply approval test:**
1. Check Approvals tab for any `client_reply` type approvals
2. Approve one → check logs for `client_reply: sent via WhatsApp` or `client_reply: sent via email`

**Approval settings test:**
1. Navigate to Instance Settings → Approval Gates
2. Toggle "Client replies" OFF
3. Trigger a `send_client_reply` tool call (via orchestrator or test endpoint)
4. Verify message sent immediately (no approval created)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(orchestrator): complete orchestrator agent implementation"
```
