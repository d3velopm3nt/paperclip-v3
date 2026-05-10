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
import { eccConversationsService } from "./ecc-conversations.js";
import { eccTopicsService } from "./ecc-topics.js";
import { eccAgentsService } from "./ecc-agents.js";
import { notifyOperatorTelegram } from "./telegram-polling.js";
import type { ConversationMessage } from "./ecc-conversations.js";
import type { EccAgentMetadata } from "./ecc-agents.js";

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
  const topicSvc = eccTopicsService(db);

  // Ensure ECC Inbox topic exists for unmatched messages
  const allTopics = await topicSvc.list("active");
  let inboxTopic = allTopics.find((t) => t.name === "ECC Inbox");
  if (!inboxTopic) {
    inboxTopic = await topicSvc.create({ name: "ECC Inbox", companyId: null });
  }

  // Build companyId → name map for human-readable topic context
  const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const companyNames = new Map(companyRows.map((c) => [c.id, c.name]));

  const lines: string[] = [];

  // All available topics (for matching)
  const topicsExceptInbox = allTopics.filter((t) => t.name !== "ECC Inbox");
  if (topicsExceptInbox.length > 0) {
    lines.push("\n## Available Topics");
    for (const t of topicsExceptInbox) {
      const companyLabel = t.companyId ? ` | company: ${companyNames.get(t.companyId) ?? t.companyId}` : "";
      lines.push(`- "${t.name}" | topic-id: ${t.id}${t.currentState ? ` | state: ${t.currentState}` : ""}${companyLabel}`);
    }
  }

  // Active conversations with memory
  try {
    const convSvc = eccConversationsService(db);
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

  lines.push(`\n## Inbox fallback\nIf no topic matches, use topic-id: ${inboxTopic.id} (ECC Inbox) for resolve_conversation, then notify_operator asking JayJay which topic to assign.`);

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

  const eccSvc = eccAgentsService(db);
  const execAgent = await eccSvc.getEccAgent("operator");
  const clientAgent = await eccSvc.getEccAgent("client");
  const activeEccAgent = isOperator ? execAgent : clientAgent;

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

    // Inject topics + active conversations + inbox fallback
    const { context: convContext } = await buildActiveConversationsContext(db);
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
  if (activeEccAgent) {
    try {
      const sourceId = input.inboundMessageId ?? randomUUID();
      const [stubRun] = await db.insert(workflowRuns).values({
        companyId,
        agentId: activeEccAgent.id,
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
    agentId: activeEccAgent?.id ?? "orchestrator",
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

  const dbPrompt = (activeEccAgent?.adapterConfig as Record<string, unknown> | null)?.systemPrompt;
  if (typeof dbPrompt !== "string" || dbPrompt.length === 0) {
    logger.warn({ companyId, platform: input.platform }, "orchestrator: ECC agent has no system prompt in DB — run will use Claude defaults");
  }
  const systemPrompt = typeof dbPrompt === "string" && dbPrompt.length > 0 ? dbPrompt : "";
  await fs.writeFile(promptPath, systemPrompt, "utf-8");

  const agentMeta = (activeEccAgent?.metadata ?? {}) as EccAgentMetadata;
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
    logger.info({ companyId, agentId: activeEccAgent?.id, sessionId: existingSessionId }, "orchestrator: resuming claude session");
  }

  const stdin = `Human: ${userMessage}`;

  logger.info(
    { companyId, platform: input.platform, fromType: input.fromType, fromAddr: input.fromAddr, isOperator },
    "orchestrator: starting",
  );

  const messagePreview = input.body.slice(0, 120);
  if (activeEccAgent) await eccSvc.setProcessing(activeEccAgent.id, "", "", messagePreview).catch(() => {});

  const spawnStart = new Date();
  let stderr = "";
  let stdout = "";
  let shouldClearSession = false;

  try {
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
    proc.stdin.write(stdin);
    proc.stdin.end();

    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    let exitCode = 0;
    await new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        exitCode = code ?? 0;
        if (code !== 0) {
          logger.warn({ code, stderr: stderr.slice(0, 500), companyId }, "orchestrator: claude exited non-zero");
        } else {
          logger.info({ companyId, platform: input.platform }, "orchestrator: complete");
        }
        resolve();
      });
    });

    // Log stderr even on exit 0 so we can diagnose silent failures
    if (stderr.trim()) {
      logger.info({ companyId, exitCode, stderr: stderr.slice(0, 500) }, "orchestrator: claude stderr");
    }

    // Detect stale/invalid session from stderr so we clear it before next run
    if (existingSessionId && /session.*not found|invalid.*session|could not resume|no such session|session.*expired|failed to resume|unknown session/i.test(stderr)) {
      shouldClearSession = true;
      logger.warn({ agentId: activeEccAgent?.id, sessionId: existingSessionId }, "orchestrator: stale session detected in stderr — will clear");
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
    if (activeEccAgent && !shouldClearSession) {
      const newSessionId = parseSessionId(stdout);
      if (newSessionId) {
        await eccSvc.saveSessionId(activeEccAgent.id, newSessionId).catch(() => {});
        logger.info({ agentId: activeEccAgent.id, sessionId: newSessionId }, "orchestrator: saved claude session id");
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
    if (activeEccAgent) await eccSvc.setIdle(activeEccAgent.id, { clearSession: shouldClearSession }).catch(() => {});
  }

  if (isOperator) {
    try {
      const convSvc = eccConversationsService(db);
      const topicSvc = eccTopicsService(db);
      const active = await convSvc.listAllActive();
      const touched = active.find((c) => c.lastMessageAt >= spawnStart);
      if (touched) {
        await convSvc.appendMessage(touched.id, "user", input.body);
        const assistantText = parseAssistantText(stdout);
        if (assistantText) await convSvc.appendMessage(touched.id, "assistant", assistantText);

        // Update inbound message with identified topic + workflow run link
        if (input.inboundMessageId) {
          const topic = await topicSvc.getById(touched.topicId).catch(() => null);
          const [wfRun] = activeEccAgent
            ? await db
                .select({ id: workflowRuns.id })
                .from(workflowRuns)
                .where(and(eq(workflowRuns.agentId, activeEccAgent.id), gte(workflowRuns.startedAt, spawnStart)))
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
                eccAgentId: activeEccAgent?.id ?? null,
              },
            })
            .where(eq(operatorMessages.id, input.inboundMessageId))
            .catch(() => {});
        }
      } else if (input.inboundMessageId) {
        // No topic matched — landed in inbox
        const [wfRun] = activeEccAgent
          ? await db
              .select({ id: workflowRuns.id })
              .from(workflowRuns)
              .where(and(eq(workflowRuns.agentId, activeEccAgent.id), gte(workflowRuns.startedAt, spawnStart)))
              .orderBy(desc(workflowRuns.startedAt))
              .limit(1)
          : [];
        await db
          .update(operatorMessages)
          .set({
            rawPayload: {
              identifyStatus: "inbox",
              workflowRunId: wfRun?.id ?? null,
              eccAgentId: activeEccAgent?.id ?? null,
            },
          })
          .where(eq(operatorMessages.id, input.inboundMessageId))
          .catch(() => {});
      }
    } catch (e) {
      logger.warn({ err: e }, "orchestrator: failed to append conversation message");
    }
  }
}
