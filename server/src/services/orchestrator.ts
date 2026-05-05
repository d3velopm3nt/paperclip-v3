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

  const stdin = `Human: ${userMessage}`;

  logger.info(
    { companyId, platform: input.platform, fromType: input.fromType, fromAddr: input.fromAddr },
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
