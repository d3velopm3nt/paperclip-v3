// v3: unified LLM orchestrator — entry point for all inbound messages.
// Spawns a claude CLI subprocess with the Paperclip MCP server attached.
// Handles both client inbound (email/whatsapp) and operator inbound (telegram/email).

import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { approvals, companies, issues, operatorMessages, workflowRuns, workflowStageResults } from "@paperclipai/db";
import { and, desc, eq, gte, notInArray } from "drizzle-orm";
import { signMcpToken } from "./mcp-session-token.js";
import { logger } from "../middleware/logger.js";
import { eaConversationsService } from "./ea-conversations.js";
import { topicsService } from "./topics.js";
import { eaAgentsService } from "./ea-agents.js";
import { notifyOperatorTelegram } from "./telegram-polling.js";
import type { ConversationMessage } from "./ea-conversations.js";
import type { EaAgentMetadata } from "./ea-agents.js";

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
  inboundMessageId?: string;
}


async function buildActiveConversationsContext(db: Db): Promise<{ context: string; inboxTopicId: string }> {
  const topicSvc = topicsService(db);

  // Ensure EA Inbox topic exists for unmatched messages
  const allTopics = await topicSvc.list("active");
  let inboxTopic = allTopics.find((t) => t.name === "EA Inbox");
  if (!inboxTopic) {
    inboxTopic = await topicSvc.create({ name: "EA Inbox", companyId: null });
  }

  // Build companyId → name map for human-readable topic context
  const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const companyNames = new Map(companyRows.map((c) => [c.id, c.name]));

  const lines: string[] = [];

  // All available topics (for matching)
  const topicsExceptInbox = allTopics.filter((t) => t.name !== "EA Inbox");
  if (topicsExceptInbox.length > 0) {
    lines.push("\n## Available Topics");
    for (const t of topicsExceptInbox) {
      const companyLabel = t.companyId ? ` | company: ${companyNames.get(t.companyId) ?? t.companyId}` : "";
      lines.push(`- "${t.name}" | topic-id: ${t.id}${t.currentState ? ` | state: ${t.currentState}` : ""}${companyLabel}`);
    }
  }

  // Active conversations with memory
  try {
    const convSvc = eaConversationsService(db);
    const active = await convSvc.listAllActive();
    const activeNonInbox = active.filter((c) => c.topicId !== inboxTopic!.id);

    if (activeNonInbox.length > 0) {
      lines.push("\n## Active Conversations");
      for (const conv of activeNonInbox) {
        const topic = await topicSvc.getById(conv.topicId);
        if (!topic) continue;

        const daysLeft = Math.ceil((conv.expiresAt.getTime() - Date.now()) / 86_400_000);
        const topicCompany = topic.companyId ? ` | company: ${companyNames.get(topic.companyId) ?? topic.companyId}` : "";
        lines.push(
          `\n[Topic: "${topic.name}" | topic-id: ${conv.topicId} | conversation-id: ${conv.id} | expires-in: ${daysLeft}d | messages: ${conv.messageCount}${topicCompany}]`,
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
    }

    // Inbox recent messages — critical for multi-turn context when no topic matched yet.
    // Without this, replies like "yes create it" lose all memory of what was suggested.
    const inboxConv = active.find((c) => c.topicId === inboxTopic!.id);
    if (inboxConv) {
      const inboxMsgs = (inboxConv.recentMessages as ConversationMessage[]) ?? [];
      if (inboxMsgs.length > 0) {
        lines.push(`\n## Recent Inbox Messages (unassigned — use for context when JayJay replies to a previous suggestion)`);
        for (const m of inboxMsgs.slice(-5)) {
          const ts = new Date(m.ts).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
          lines.push(`  [${m.role} | ${ts}] ${m.content.slice(0, 300)}`);
        }
      }
    }
  } catch {
    // non-fatal
  }

  lines.push(`\n## Inbox fallback\nIf no topic matches, use topic-id: ${inboxTopic.id} (EA Inbox) for resolve_conversation, then notify_operator asking JayJay which topic to assign.`);

  // Recent issues across all companies (last 48h, non-closed) — lets ECC know what CCC handled
  try {
    const cutoff = new Date(Date.now() - 48 * 3_600_000);
    const recentIssues = await db
      .select({
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        companyName: companies.name,
      })
      .from(issues)
      .innerJoin(companies, eq(issues.companyId, companies.id))
      .where(
        and(
          gte(issues.updatedAt, cutoff),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(15);

    if (recentIssues.length > 0) {
      lines.push("\n## Recent Issues (last 48h, open)");
      for (const iss of recentIssues) {
        lines.push(`- ${iss.identifier ?? "?"} | ${iss.companyName} | ${iss.status} | ${iss.title}`);
      }
    }
  } catch {
    // non-fatal
  }

  // Pending plan approvals — ECC needs to know what's waiting for JayJay's decision
  try {
    const pendingPlans = await db
      .select({
        id: approvals.id,
        companyName: companies.name,
        payload: approvals.payload,
        createdAt: approvals.createdAt,
      })
      .from(approvals)
      .innerJoin(companies, eq(approvals.companyId, companies.id))
      .where(and(eq(approvals.type, "plan"), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt))
      .limit(10);

    if (pendingPlans.length > 0) {
      lines.push("\n## Pending Plan Approvals");
      for (const p of pendingPlans) {
        const pl = p.payload as Record<string, unknown>;
        const preview = typeof pl.proposalText === "string" ? pl.proposalText.slice(0, 200) : "";
        lines.push(`- approval-id: ${p.id} | company: ${p.companyName} | ${preview}${preview.length === 200 ? "…" : ""}`);
      }
      lines.push("\nUse approve_plan(approvalId, approved) to action these on JayJay's behalf.");
    }
  } catch {
    // non-fatal
  }

  return { context: lines.join("\n"), inboxTopicId: inboxTopic.id };
}

function parseSessionId(streamJson: string): string | null {
  for (const line of streamJson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.session_id === "string" && event.session_id) return event.session_id;
    } catch { /* skip */ }
  }
  return null;
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

  const eaSvc = eaAgentsService(db);
  const execAgent = await eaSvc.getEaAgent("operator");
  const clientAgent = await eaSvc.getEaAgent("client");
  const activeEaAgent = isOperator ? execAgent : clientAgent;

  const contextLines: string[] = [
    `## Inbound message`,
    `Platform: ${input.platform}`,
    `Sender type: ${input.fromType}`,
    `From: ${input.fromAddr}`,
  ];

  let operatorInboxTopicId: string | null = null;

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

    // Inject topics + active conversations + inbox fallback
    const { context: convContext, inboxTopicId } = await buildActiveConversationsContext(db);
    operatorInboxTopicId = inboxTopicId;
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

  // Create stub workflow run so the run always exists (even if agent fails before calling resolve_conversation).
  // resolve_conversation will adopt this run rather than creating a new one.
  let stubRunId: string | null = null;
  if (activeEaAgent) {
    try {
      const sourceId = input.inboundMessageId ?? randomUUID();
      const [stubRun] = await db.insert(workflowRuns).values({
        companyId,
        agentId: activeEaAgent.id,
        workflowType: "ecc_message",
        sourceTable: input.inboundMessageId ? "operator_messages" : "ecc_conversations",
        sourceId,
        overallStatus: "running",
        startedAt: new Date(),
      }).returning({ id: workflowRuns.id });
      stubRunId = stubRun?.id ?? null;
    } catch { /* non-fatal */ }
  }

  // Inject runId into context so the agent can pass it to complete_conversation_turn
  if (stubRunId) {
    contextLines.push(`\n## Workflow Run\nrun-id: ${stubRunId}\nPass this run-id to complete_conversation_turn as the runId argument.`);
  }

  contextLines.push(``, `## Message body`, input.body);

  const userMessage = contextLines.join("\n");

  const mcpToken = signMcpToken({
    companyId,
    agentId: activeEaAgent?.id ?? "orchestrator",
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

  const adapterCfg = (activeEaAgent?.adapterConfig as Record<string, unknown> | null) ?? {};
  const instructionsFilePath = typeof adapterCfg.instructionsFilePath === "string" && adapterCfg.instructionsFilePath
    ? adapterCfg.instructionsFilePath : null;

  let systemPrompt = "";
  if (instructionsFilePath) {
    try {
      systemPrompt = await fs.readFile(instructionsFilePath, "utf-8");
      logger.info({ agentId: activeEaAgent?.id, instructionsFilePath }, "orchestrator: loaded instructions from file");
    } catch (err) {
      logger.warn({ instructionsFilePath, err }, "orchestrator: failed to read instructions file — falling back to systemPrompt");
    }
  }
  if (!systemPrompt) {
    // Legacy fallback: systemPrompt text blob in adapterConfig
    const dbPrompt = adapterCfg.systemPrompt;
    systemPrompt = typeof dbPrompt === "string" && dbPrompt.length > 0 ? dbPrompt : "";
    if (!systemPrompt) {
      logger.warn({ companyId, platform: input.platform }, "orchestrator: no instructions found — run will use Claude defaults");
    }
  }
  // Inject agent memories into system prompt (same pattern as heartbeat service)
  let memorySection = "";
  if (activeEaAgent) {
    try {
      const { memoryLoaderService } = await import("./agent-runtime/memory-loader.js");
      const memoryLoader = memoryLoaderService(db);
      const memories = await memoryLoader.loadMemories(activeEaAgent.id);
      if (memories.length > 0) {
        memorySection = `\n\n---\n\n# Your Memories\n\nThese are your accumulated learnings. Use them to inform your work.\n\n${
          memories
            .map((m) => `## ${m.title}\n**Category:** ${m.category} | **Source:** ${m.source} | **Scope:** ${m.scope}\n\n${m.content}`)
            .join("\n\n---\n\n")
        }`;
        logger.info({ agentId: activeEaAgent.id, memoryCount: memories.length }, "orchestrator: injected agent memories");
      }
    } catch (memErr) {
      logger.warn({ err: memErr, agentId: activeEaAgent.id }, "orchestrator: failed to load agent memories");
    }
  }
  await fs.writeFile(promptPath, systemPrompt + memorySection, "utf-8");

  const agentMeta = (activeEaAgent?.metadata ?? {}) as EaAgentMetadata;
  const existingSessionId = agentMeta.claudeSessionId;

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config", mcpConfigPath,
    "--append-system-prompt-file", promptPath,
  ];

  if (existingSessionId) {
    args.push("--resume", existingSessionId);
    logger.info({ companyId, agentId: activeEaAgent?.id, sessionId: existingSessionId }, "orchestrator: resuming claude session");
  }

  const stdin = `Human: ${userMessage}`;

  logger.info(
    { companyId, platform: input.platform, fromType: input.fromType, fromAddr: input.fromAddr, isOperator },
    "orchestrator: starting",
  );

  const messagePreview = input.body.slice(0, 120);
  if (activeEaAgent) await eaSvc.setProcessing(activeEaAgent.id, "", "", messagePreview).catch(() => {});

  const spawnStart = new Date();
  let shouldClearSession = false;
  let stdout = "";

  const STALE_SESSION_RE = /session.*not found|no conversation found|invalid.*session|could not resume|no such session|session.*expired|failed to resume|unknown session|conversation.*not found/i;

  const spawnClaude = (spawnArgs: string[]) =>
    new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      let out = "", err = "";
      const proc = spawn("claude", spawnArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
      proc.stdin.write(stdin);
      proc.stdin.end();
      proc.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
      proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      proc.on("close", (code) => resolve({ stdout: out, stderr: err, exitCode: code ?? 0 }));
    });

  try {
    let result = await spawnClaude(args);

    // Session expired → strip --resume and retry immediately so user still gets a reply
    if (existingSessionId && STALE_SESSION_RE.test(result.stderr)) {
      shouldClearSession = true;
      logger.warn({ agentId: activeEaAgent?.id, sessionId: existingSessionId }, "orchestrator: stale session — retrying without --resume");
      const resumeIdx = args.indexOf("--resume");
      const freshArgs = resumeIdx >= 0 ? [...args.slice(0, resumeIdx), ...args.slice(resumeIdx + 2)] : args;
      result = await spawnClaude(freshArgs);
    }

    const { stdout: out, stderr, exitCode } = result;
    stdout = out;

    if (exitCode !== 0) {
      logger.warn({ code: exitCode, stderr: stderr.slice(0, 500), companyId }, "orchestrator: claude exited non-zero");
    } else {
      logger.info({ companyId, platform: input.platform }, "orchestrator: complete");
    }

    // Log stderr even on exit 0 so we can diagnose silent failures
    if (stderr.trim()) {
      logger.info({ companyId, exitCode, stderr: stderr.slice(0, 500) }, "orchestrator: claude stderr");
    }

    // If Claude exited non-zero and run is still running, mark it failed
    if (exitCode !== 0 && stubRunId) {
      shouldClearSession = true;
      const [runRow] = await db.select({ overallStatus: workflowRuns.overallStatus }).from(workflowRuns).where(eq(workflowRuns.id, stubRunId)).limit(1);
      if (runRow?.overallStatus === "running") {
        const now = new Date();
        const errText = stderr.slice(0, 300) || `Claude exited with code ${exitCode}`;
        await db.update(workflowRuns).set({ overallStatus: "failed", finishedAt: now }).where(eq(workflowRuns.id, stubRunId)).catch(() => {});
        await db.insert(workflowStageResults).values({
          runId: stubRunId, stageId: "claude_error", label: "Claude process error",
          status: "failed", expectations: [], actuals: { exitCode, stderr: errText },
          errorText: errText, ord: 98, computedAt: now,
        }).catch(() => {});
      }
    }

    await Promise.allSettled([fs.unlink(mcpConfigPath), fs.unlink(promptPath)]);

    // Save the session ID so the next message can resume the conversation (skip if we're about to clear it)
    if (activeEaAgent && !shouldClearSession) {
      const newSessionId = parseSessionId(stdout);
      if (newSessionId) {
        await eaSvc.saveSessionId(activeEaAgent.id, newSessionId).catch(() => {});
        logger.info({ agentId: activeEaAgent.id, sessionId: newSessionId }, "orchestrator: saved claude session id");
      }
    }
  } catch (orchErr) {
    logger.error({ err: orchErr, companyId, platform: input.platform }, "orchestrator: fatal error");
    const errMsg = orchErr instanceof Error ? orchErr.message : String(orchErr);
    // Mark stub run as failed
    if (stubRunId) {
      const now = new Date();
      await db.update(workflowRuns).set({ overallStatus: "failed", finishedAt: now }).where(eq(workflowRuns.id, stubRunId)).catch(() => {});
      await db.insert(workflowStageResults).values({
        runId: stubRunId, stageId: "orchestrator_error", label: "Orchestrator error",
        status: "failed", expectations: [], actuals: { error: errMsg.slice(0, 300) },
        errorText: errMsg.slice(0, 300), ord: 99, computedAt: now,
      }).catch(() => {});
    }
    await notifyOperatorTelegram(db, `⚠️ Orchestrator error on ${input.platform} message:\n\n${errMsg.slice(0, 300)}\n\nOriginal message: "${input.body.slice(0, 100)}"`)
      .catch(() => {});
  } finally {
    // Always reset to idle — even if spawn or anything above throws
    if (activeEaAgent) await eaSvc.setIdle(activeEaAgent.id, { clearSession: shouldClearSession }).catch(() => {});
  }

  if (isOperator) {
    try {
      const convSvc = eaConversationsService(db);
      const topicSvc = topicsService(db);
      const active = await convSvc.listAllActive();
      const touched = active.find((c) => c.lastMessageAt >= spawnStart);
      if (touched) {
        await convSvc.appendMessage(touched.id, "user", input.body);
        const assistantText = parseAssistantText(stdout);
        if (assistantText) await convSvc.appendMessage(touched.id, "assistant", assistantText);

        // Update inbound message with identified topic + workflow run link
        if (input.inboundMessageId) {
          const topic = await topicSvc.getById(touched.topicId).catch(() => null);
          const [wfRun] = activeEaAgent
            ? await db
                .select({ id: workflowRuns.id })
                .from(workflowRuns)
                .where(and(eq(workflowRuns.agentId, activeEaAgent.id), gte(workflowRuns.startedAt, spawnStart)))
                .orderBy(desc(workflowRuns.startedAt))
                .limit(1)
            : [];
          await db
            .update(operatorMessages)
            .set({
              rawPayload: {
                identifyStatus: "identified",
                topicId: touched.topicId,
                topicName: topic?.name ?? null,
                workflowRunId: wfRun?.id ?? null,
                eaAgentId: activeEaAgent?.id ?? null,
              },
            })
            .where(eq(operatorMessages.id, input.inboundMessageId))
            .catch(() => {});
        }
      } else {
        // Claude didn't call resolve_conversation — store exchange in inbox so next turn has context
        if (operatorInboxTopicId) {
          const inboxConv = await convSvc.resolveActive(operatorInboxTopicId);
          await convSvc.appendMessage(inboxConv.id, "user", input.body);
          const assistantText = parseAssistantText(stdout);
          if (assistantText) await convSvc.appendMessage(inboxConv.id, "assistant", assistantText);
        }
        if (input.inboundMessageId) {
          const [wfRun] = activeEaAgent
            ? await db
                .select({ id: workflowRuns.id })
                .from(workflowRuns)
                .where(and(eq(workflowRuns.agentId, activeEaAgent.id), gte(workflowRuns.startedAt, spawnStart)))
                .orderBy(desc(workflowRuns.startedAt))
                .limit(1)
            : [];
          await db
            .update(operatorMessages)
            .set({
              rawPayload: {
                identifyStatus: "inbox",
                workflowRunId: wfRun?.id ?? null,
                eaAgentId: activeEaAgent?.id ?? null,
              },
            })
            .where(eq(operatorMessages.id, input.inboundMessageId))
            .catch(() => {});
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "orchestrator: failed to append conversation message");
    }
  }
}
