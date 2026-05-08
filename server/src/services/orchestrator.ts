// v3: unified LLM orchestrator — entry point for all inbound messages.
// Spawns a claude CLI subprocess with the Paperclip MCP server attached.
// Handles both client inbound (email/whatsapp) and operator inbound (telegram/email).

import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { signMcpToken } from "./mcp-session-token.js";
import { logger } from "../middleware/logger.js";
import { eccConversationsService } from "./ecc-conversations.js";
import { eccTopicsService } from "./ecc-topics.js";
import type { ConversationMessage } from "./ecc-conversations.js";

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

const CLIENT_SYSTEM_PROMPT = `You are the Paperclip Orchestrator — the unified intelligence for all inbound communication.

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

## Issue references
Always refer to issues by their identifier field (e.g. PC-42), never by UUID. The identifier is returned by create_issue and list_issues.

## Response style
Keep your text responses very short — the tools do the work. Use them.`;

const ECC_SYSTEM_PROMPT = `You are the Paperclip Executive Command Center (ECC) — JayJay Barnard's operational intelligence layer.

JayJay is the founder of multiple companies. You have cross-company access to all of them via the list_companies tool.

## Your role
- Act as an executive assistant and operational intelligence layer
- Understand context, retrieve relevant information, suggest intelligent actions
- Maintain awareness across all companies and workstreams
- Require JayJay's approval before high-risk actions (sending emails, committing funds, deploying code, making business commitments)
- Keep JayJay informed: what happened, what is blocked, what needs attention

## Conversation protocol — MANDATORY on every message
Every message you process belongs to a topic and conversation. You MUST:
1. **Start**: Call resolve_conversation(topicId) — identify the topic first via list_topics if needed. This opens a workflow run and gives you the conversation context (memory, recent messages, expiry).
2. **Work**: Process the message using the full conversation context returned by resolve_conversation.
3. **End**: Call complete_conversation_turn(conversationId, runId, actionSummary) — always, even if no external action was taken. This closes the workflow run and updates memory.

Never skip these bookend calls. They are the source of truth for conversation continuity.

## Topic matching
- Check Active Conversations (injected above) before calling list_topics — the conversation may already be in context.
- If message clearly references an existing topic, use that topicId directly.
- If unsure which topic, call list_topics and pick the best match. If none fits, ask JayJay before creating.
- Client messages forwarded by JayJay: extract the company/project name to match a topic.

## Expiry management
- If resolve_conversation returns warningDays <= 3, notify JayJay and offer to extend.
- If a conversation is near expiry and still active, call extend_conversation(conversationId).

## Operating model
1. Understand the message — who, what, which company, urgency, risk
2. Call resolve_conversation → get full conversation context
3. Retrieve additional context — call list_issues, get_issue_comments as needed
4. Reason and suggest — propose next actions clearly
5. Act or ask — execute low-risk actions directly, request approval for high-risk ones
6. Call complete_conversation_turn — always last

## Tool usage rules
- **resolve_conversation**: First tool call on every message. Pass topicId.
- **complete_conversation_turn**: Last tool call on every message. Pass conversationId, runId, and a brief action summary.
- **extend_conversation**: Call when warningDays <= 3 or JayJay asks to extend.
- **list_companies**: Call when unsure which company is relevant.
- **list_topics**: Call to find or match a topic. Required when topic is ambiguous.
- **list_issues**: Pass the relevant companyId. Use to find existing issues.
- **get_issue_comments**: Read full thread before making decisions.
- **notify_operator**: Concise operational updates. Short, direct, no fluff.
- **create_plan**: Multi-step work needing JayJay review and approval.
- **add_issue_comment**: Log important decisions on issues.

## Cross-company queries
When the question spans companies (e.g. "what's blocked across all companies?"):
1. Call list_companies to get all company IDs
2. Call list_issues for each company with relevant filters
3. Synthesize and respond

## Response style
Short and operational. State what you found, what you're doing, what you need from JayJay.
No verbosity. No pleasantries. Treat JayJay as a busy founder who wants signal, not noise.

## Issue references
Always refer to issues by their identifier field (e.g. PC-42), never by UUID.`;

async function buildActiveConversationsContext(db: Db): Promise<string> {
  try {
    const convSvc = eccConversationsService(db);
    const topicSvc = eccTopicsService(db);
    const active = await convSvc.listAllActive();

    if (active.length === 0) return "\n## Active Conversations\nNone.";

    const lines: string[] = ["\n## Active Conversations"];
    for (const conv of active) {
      const topic = await topicSvc.getById(conv.topicId);
      if (!topic) continue;

      const daysLeft = Math.ceil((conv.expiresAt.getTime() - Date.now()) / 86_400_000);
      lines.push(
        `\n[Topic: "${topic.name}" | topic-id: ${conv.topicId} | conversation-id: ${conv.id} | expires-in: ${daysLeft}d | messages: ${conv.messageCount}]`,
      );
      if (topic.currentState) lines.push(`State: ${topic.currentState}`);
      if (topic.summary) lines.push(`Memory: ${topic.summary.slice(0, 300)}`);

      const msgs = (conv.recentMessages as ConversationMessage[]) ?? [];
      if (msgs.length > 0) {
        lines.push("Recent:");
        for (const m of msgs.slice(-8)) {
          const ts = new Date(m.ts).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
          lines.push(`  [${m.role} | ${ts}] ${m.content.slice(0, 300)}`);
        }
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function parseAssistantText(streamJson: string): string {
  return streamJson
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          message?: { content?: Array<{ type: string; text?: string }> };
        };
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          return event.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "");
        }
      } catch {
        /* ignore malformed */
      }
      return [];
    })
    .join("\n")
    .trim();
}

export async function runOrchestrator(db: Db, input: OrchestratorInput): Promise<void> {
  const { companyId } = input;
  const isOperator = input.fromType === "operator";

  const contextLines: string[] = [
    `## Inbound message`,
    `Platform: ${input.platform}`,
    `Sender type: ${input.fromType}`,
    `From: ${input.fromAddr}`,
  ];

  if (isOperator) {
    // Give ECC full company list in context so it doesn't need to discover them
    try {
      const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
      if (allCompanies.length) {
        contextLines.push(`Companies: ${allCompanies.map((c) => `${c.name} (${c.id})`).join(", ")}`);
      }
    } catch {
      // non-fatal — Claude can call list_companies tool instead
    }

    // Inject active conversations (short-term memory for stateless ECC)
    const convContext = await buildActiveConversationsContext(db);
    if (convContext) contextLines.push(convContext);
  } else {
    contextLines.push(`Company ID: ${companyId}`);
  }

  if (input.subject) contextLines.push(`Subject: ${input.subject}`);
  if (input.clientId) contextLines.push(`Matched client ID: ${input.clientId} (already resolved)`);
  if (input.existingIssueId) contextLines.push(`Existing issue ID: ${input.existingIssueId} — this is a thread continuation, not a new request`);
  if (input.attachmentSummaries?.length) {
    contextLines.push(`Attachments (already saved to client folder): ${input.attachmentSummaries.join(", ")}`);
  }
  contextLines.push(``, `## Message body`, input.body);

  const userMessage = contextLines.join("\n");

  const mcpToken = signMcpToken({
    companyId,
    agentId: "orchestrator",
    isOperator,
  });

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

  const systemPrompt = isOperator ? ECC_SYSTEM_PROMPT : CLIENT_SYSTEM_PROMPT;
  await fs.writeFile(promptPath, systemPrompt, "utf-8");

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--mcp-config", mcpConfigPath,
    "--append-system-prompt-file", promptPath,
  ];

  const stdin = `Human: ${userMessage}`;

  logger.info(
    { companyId, platform: input.platform, fromType: input.fromType, fromAddr: input.fromAddr, isOperator },
    "orchestrator: starting",
  );

  const spawnStart = new Date();
  const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
  proc.stdin.write(stdin);
  proc.stdin.end();

  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

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

  if (isOperator) {
    try {
      const convSvc = eccConversationsService(db);
      const active = await convSvc.listAllActive();
      const touched = active.find((c) => c.lastMessageAt >= spawnStart);
      if (touched) {
        await convSvc.appendMessage(touched.id, "user", input.body);
        const assistantText = parseAssistantText(stdout);
        if (assistantText) await convSvc.appendMessage(touched.id, "assistant", assistantText);
      }
    } catch (e) {
      logger.warn({ err: e }, "orchestrator: failed to append conversation message");
    }
  }
}
