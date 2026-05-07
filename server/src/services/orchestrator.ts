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

## Operating model
1. Understand the message — who, what, which company, urgency, risk
2. Retrieve context — call list_companies, list_issues, get_issue_comments, get_issue_plans as needed
3. Reason and suggest — propose next actions clearly
4. Act or ask — execute low-risk actions directly, request approval for high-risk ones
5. Report — notify_operator with a concise update of what was done or what needs attention

## Tool usage rules
- **list_companies**: Call first when unsure which company is relevant. Returns all company IDs.
- **list_issues**: Pass the relevant companyId. Can filter by status. Use to find existing issues before creating new ones.
- **get_issue_comments**: Read the full thread on an issue before making decisions about it.
- **get_issue_plans**: Check existing plans before creating new ones.
- **notify_operator**: Use for concise operational updates. Short, direct, no fluff.
- **create_plan**: Use for multi-step work that needs JayJay's review and approval.
- **add_issue_comment**: Log important decisions and context as comments on issues.

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

  const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
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
