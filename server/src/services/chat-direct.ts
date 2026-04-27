import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, clients, issues, operatorMessages, projects, projectWorkspaces } from "@paperclipai/db";
import { chatService } from "./chat.js";
import { publishLiveEvent } from "./live-events.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";


async function readInstructions(adapterConfig: Record<string, unknown>): Promise<string | null> {
  const filePath = adapterConfig.instructionsFilePath;
  if (typeof filePath === "string" && filePath.trim()) {
    try {
      return await fs.readFile(filePath.trim(), "utf-8");
    } catch {
      // fall through
    }
  }
  return null;
}

interface ContextRef {
  type: "issue" | "project" | "client" | "agent";
  id: string;
  label: string;
  meta?: { cwd?: string; status?: string; role?: string };
}

async function buildSystemPrompt(
  db: Db,
  companyId: string,
  agent: { name: string; role: string; adapterConfig: Record<string, unknown> },
  contextRefs: ContextRef[],
): Promise<{ prompt: string; workspacePaths: string[]; enrichedRefs: ContextRef[] }> {
  const instructions = await readInstructions(agent.adapterConfig);
  const base = instructions
    ?? `You are ${agent.name}, an AI agent with role: ${agent.role}. Respond helpfully and concisely.`;

  const workspacePaths: string[] = [];
  const enrichedRefs: ContextRef[] = [...contextRefs];

  // Always inject company snapshot: agents + projects
  const [companyAgents, companyProjects] = await Promise.all([
    db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents).where(eq(agents.companyId, companyId)),
    db.select({ id: projects.id, name: projects.name, status: projects.status, description: projects.description })
      .from(projects).where(eq(projects.companyId, companyId)),
  ]);

  const snapshot: string[] = [
    `\n\n--- PAPERCLIP COMPANY CONTEXT ---`,
    `Agents: ${companyAgents.map((a) => `${a.name} (${a.role}, ${a.status})`).join(", ") || "none"}`,
    `Projects: ${companyProjects.map((p) => `${p.name} [${p.status}]${p.description ? ` — ${p.description}` : ""}`).join("; ") || "none"}`,
  ];

  // Fetch details for explicitly selected context refs
  if (contextRefs.length > 0) {
    snapshot.push(`\n--- SELECTED CONTEXT ---`);

    const issueIds = contextRefs.filter((r) => r.type === "issue").map((r) => r.id);
    const projectIds = contextRefs.filter((r) => r.type === "project").map((r) => r.id);
    const clientIds = contextRefs.filter((r) => r.type === "client").map((r) => r.id);
    const agentIds = contextRefs.filter((r) => r.type === "agent").map((r) => r.id);

    if (issueIds.length > 0) {
      const rows = await db.select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
        status: issues.status, priority: issues.priority, description: issues.description,
      }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
      for (const r of rows) {
        snapshot.push(`Issue ${r.identifier ?? r.id}: "${r.title}" [${r.status}/${r.priority}]${r.description ? `\n  ${r.description.slice(0, 400)}` : ""}`);
      }
    }

    if (projectIds.length > 0) {
      const rows = await db.select({
        id: projects.id, name: projects.name, status: projects.status, description: projects.description,
      }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));

      // Fetch workspace cwd — prefer primary, fall back to any workspace with a local path
      const wsRows = await db.select({
        projectId: projectWorkspaces.projectId,
        cwd: projectWorkspaces.cwd,
        isPrimary: projectWorkspaces.isPrimary,
      }).from(projectWorkspaces)
        .where(inArray(projectWorkspaces.projectId, projectIds));
      // Per project: pick primary first, then first available
      const cwdByProject = new Map<string, string | null>();
      for (const w of wsRows) {
        const existing = cwdByProject.get(w.projectId);
        if (!existing || w.isPrimary) cwdByProject.set(w.projectId, w.cwd);
      }

      for (const r of rows) {
        const cwd = cwdByProject.get(r.id);
        if (cwd) workspacePaths.push(cwd);
        snapshot.push(
          `Project "${r.name}" [${r.status}]${r.description ? `\n  ${r.description.slice(0, 400)}` : ""}${cwd ? `\n  Local path: ${cwd}` : ""}`,
        );
        // Enrich the contextRef for this project with cwd
        const refIdx = enrichedRefs.findIndex((ref) => ref.type === "project" && ref.id === r.id);
        if (refIdx >= 0) {
          enrichedRefs[refIdx] = { ...enrichedRefs[refIdx]!, meta: { cwd: cwd ?? undefined, status: r.status ?? undefined } };
        }
      }
    }

    if (clientIds.length > 0) {
      const rows = await db.select({ id: clients.id, name: clients.name })
        .from(clients).where(and(eq(clients.companyId, companyId), inArray(clients.id, clientIds)));
      for (const r of rows) {
        snapshot.push(`Client: "${r.name}"`);
      }
    }

    if (agentIds.length > 0) {
      const rows = await db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
        .from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      for (const r of rows) {
        snapshot.push(`Agent "${r.name}" — role: ${r.role}, status: ${r.status}`);
      }
    }
  }

  snapshot.push(`--- END CONTEXT ---`);
  return { prompt: base + snapshot.join("\n"), workspacePaths, enrichedRefs };
}

export async function pickAgentForDispatcher(
  db: Db,
  companyId: string,
  body: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const lower = body.toLowerCase();
  const byRole = (role: string) => rows.find((a) => a.role === role);

  if (/\b(code|bug|feature|deploy|infra|technical|dev|implement)\b/.test(lower)) {
    return byRole("cto")?.id ?? byRole("ceo")?.id ?? rows[0]?.id ?? null;
  }
  if (/\b(design|ui|ux|layout|visual)\b/.test(lower)) {
    return byRole("designer")?.id ?? byRole("ceo")?.id ?? rows[0]?.id ?? null;
  }
  return byRole("ceo")?.id ?? rows[0]?.id ?? null;
}

function buildConversationStdin(messages: Array<{ role: "user" | "assistant"; content: string }>): string {
  return messages
    .map((m) => (m.role === "user" ? `Human: ${m.content}` : `Assistant: ${m.content}`))
    .join("\n\n");
}

/**
 * Lean subprocess fallback: runs `claude --print` with subscription auth.
 * No skills, no workspace, single turn. Returns true if handled.
 */
async function chatLeanReply(
  db: Db,
  companyId: string,
  agent: { id: string; name: string; role: string; adapterConfig: Record<string, unknown> },
  threadId: string,
  userMessage: string,
  raw: unknown,
  contextRefs: ContextRef[] = [],
): Promise<boolean> {
  const command = typeof agent.adapterConfig.command === "string" && agent.adapterConfig.command.trim()
    ? agent.adapterConfig.command.trim()
    : "claude";

  const model = typeof agent.adapterConfig.model === "string" && agent.adapterConfig.model.trim()
    ? agent.adapterConfig.model.trim()
    : undefined;

  const { prompt: systemPrompt, workspacePaths, enrichedRefs } = await buildSystemPrompt(db, companyId, agent, contextRefs);

  // Build args
  const args: string[] = ["--print", "-", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);
  for (const p of workspacePaths) args.push("--add-dir", p);

  // Resolve system prompt file — verify it's accessible on this OS before using it
  let tempPromptPath: string | null = null;
  const rawInstructionsPath = agent.adapterConfig.instructionsFilePath;
  const instructionsFilePath =
    typeof rawInstructionsPath === "string" && rawInstructionsPath.trim()
      ? rawInstructionsPath.trim()
      : null;

  let useInstructionsFile = false;
  if (instructionsFilePath) {
    try {
      await fs.access(instructionsFilePath);
      useInstructionsFile = true;
    } catch {
      logger.warn({ instructionsFilePath, agentId: agent.id }, "chat-lean: instructions file not accessible, using default prompt");
    }
  }

  if (useInstructionsFile) {
    args.push("--append-system-prompt-file", instructionsFilePath!);
  } else {
    tempPromptPath = `${os.tmpdir()}/paperclip-chat-${Date.now()}.txt`;
    await fs.writeFile(tempPromptPath, systemPrompt, "utf-8");
    args.push("--append-system-prompt-file", tempPromptPath);
  }

  // Build conversation history as stdin (history fetched before storing inbound)
  const history = await chatService(db).listMessages(companyId, threadId, 40);
  const messages = [...history]
    .reverse()
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }))
    .reduce<Array<{ role: "user" | "assistant"; content: string }>>((acc, msg) => {
      if (acc.length > 0 && acc[acc.length - 1]!.role === msg.role) {
        acc[acc.length - 1]!.content += "\n" + msg.content;
      } else {
        acc.push(msg);
      }
      return acc;
    }, []);

  // Always ensure current userMessage is the final user turn
  if (messages.length > 0 && messages[messages.length - 1]!.role === "user") {
    messages[messages.length - 1]!.content += "\n" + userMessage;
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  const stdin = buildConversationStdin(messages);

  logger.info(
    { agentId: agent.id, agentName: agent.name, command, args, threadId },
    "chat-lean ▶ spawning claude subprocess",
  );
  logger.info({ threadId, stdin }, "chat-lean ▶ stdin →");

  void logActivity(db, {
    companyId, actorType: "system", actorId: agent.id,
    action: "chat.request", entityType: "chat_thread", entityId: threadId,
    agentId: agent.id,
    details: {
      message: userMessage,
      historyTurns: messages.length,
      contextRefs: contextRefs.length > 0 ? contextRefs.map((r) => `${r.type}:${r.label}`) : undefined,
      systemPrompt: systemPrompt.slice(0, 800),
      command,
      args,
    },
  });

  // Store inbound message
  const [inRow] = await db
    .insert(operatorMessages)
    .values({
      companyId,
      issueId: null,
      roomId: null,
      direction: "inbound",
      platform: "chat",
      source: "chat",
      chatThreadId: threadId,
      body: userMessage,
      rawPayload: { contextRefs: enrichedRefs.length > 0 ? enrichedRefs : undefined },
      fromAgentId: null,
    })
    .returning({ id: operatorMessages.id, createdAt: operatorMessages.createdAt });

  publishLiveEvent({
    companyId,
    type: "chat.message.new",
    payload: {
      id: inRow!.id,
      body: userMessage,
      direction: "inbound",
      fromAgentId: null,
      agentName: null,
      chatThreadId: threadId,
      createdAt: inRow!.createdAt?.toISOString() ?? new Date().toISOString(),
      contextRefs: enrichedRefs.length > 0 ? enrichedRefs : undefined,
    },
  });

  publishLiveEvent({
    companyId,
    type: "chat.agent.typing",
    payload: { agentId: agent.id, agentName: agent.name, chatThreadId: threadId },
  });

  // Merge env: process env + agent config env (strings only)
  const agentEnv = typeof agent.adapterConfig.env === "object" && agent.adapterConfig.env !== null
    ? Object.fromEntries(
        Object.entries(agent.adapterConfig.env as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      )
    : {};

  const spawnedAt = Date.now();
  let firstStdoutAt: number | null = null;

  // Emit a tool-call status message into the chat thread (not stored, just live)
  function emitStatus(body: string) {
    publishLiveEvent({
      companyId,
      type: "chat.message.new",
      payload: {
        id: `status-${Date.now()}`,
        body,
        direction: "outbound",
        fromAgentId: agent.id,
        agentName: agent.name,
        chatThreadId: threadId,
        createdAt: new Date().toISOString(),
        isStatus: true,
      },
    });
  }

  try {
    const replyText = await new Promise<string>((resolve, reject) => {
      const proc = spawn(command, args, {
        env: { ...process.env, ...agentEnv },
        stdio: ["pipe", "pipe", "pipe"],
        cwd: os.tmpdir(),
      });

      let lineBuf = "";
      let finalResult = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (firstStdoutAt === null) {
          firstStdoutAt = Date.now();
          logger.info({ threadId, ttfbMs: firstStdoutAt - spawnedAt }, "chat-lean ◀ first stdout (TTFB)");
          void logActivity(db, {
            companyId, actorType: "system", actorId: agent.id,
            action: "chat.thinking", entityType: "chat_thread", entityId: threadId,
            agentId: agent.id, details: { ttfbMs: firstStdoutAt - spawnedAt },
          });
        }
        process.stdout.write(`[chat-lean stdout] ${text}`);
        lineBuf += text;

        // Parse complete JSON lines
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            const type = event.type as string | undefined;

            if (type === "result" && event.subtype === "success") {
              finalResult = (event.result as string | undefined)?.trim() ?? "";
            }

            // Surface tool calls into the chat
            if (type === "tool_use") {
              const name = (event.name as string | undefined) ?? "tool";
              const input = event.input;
              let preview = "";
              if (input && typeof input === "object") {
                const inp = input as Record<string, unknown>;
                preview = inp.command
                  ? String(inp.command).slice(0, 80)
                  : inp.query
                    ? String(inp.query).slice(0, 80)
                    : JSON.stringify(input).slice(0, 80);
              }
              emitStatus(`🔧 ${agent.name} → ${name}${preview ? `: \`${preview}\`` : ""}`);
              void logActivity(db, {
                companyId, actorType: "agent", actorId: agent.id,
                action: "chat.tool_use", entityType: "chat_thread", entityId: threadId,
                agentId: agent.id, details: { tool: name, preview },
              });
            }

            // Surface sub-agent spawning
            if (type === "assistant" && event.message) {
              const msg = event.message as { content?: Array<{ type?: string; text?: string }> };
              const textContent = msg.content?.find((c) => c.type === "text")?.text ?? "";
              if (textContent && !finalResult) {
                finalResult = textContent.trim();
              }
            }
          } catch {
            // non-JSON line, ignore
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stderr.write(`[chat-lean stderr] ${text}`);
        stderr += text;
      });

      const timeout = setTimeout(() => {
        const elapsedMs = Date.now() - spawnedAt;
        logger.warn({ threadId, elapsedMs, stderr: stderr.slice(0, 500) }, "chat-lean ✗ timeout");
        void logActivity(db, {
          companyId, actorType: "system", actorId: agent.id,
          action: "chat.timeout", entityType: "chat_thread", entityId: threadId,
          agentId: agent.id, details: { elapsedMs, stderr: stderr.slice(0, 300) },
        });
        proc.kill("SIGTERM");
        reject(new Error(`lean reply timeout after ${elapsedMs}ms`));
      }, 120_000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        const totalMs = Date.now() - spawnedAt;
        logger.info({ threadId, exitCode: code, finalResultLen: finalResult.length, totalMs }, "chat-lean ◀ process closed");
        // Log raw LLM I/O for the LLM tab in LogsPanel
        void logActivity(db, {
          companyId, actorType: "system", actorId: agent.id,
          action: "llm.io", entityType: "chat_thread", entityId: threadId,
          agentId: agent.id,
          details: {
            stdin: stdin.slice(0, 2000),
            stdout: finalResult.slice(0, 2000),
            stderr: stderr.slice(0, 500),
            exitCode: code,
            totalMs,
          },
        });
        if (code !== 0 && !finalResult) {
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
        } else {
          resolve(finalResult);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.stdin.write(stdin);
      proc.stdin.end();
    });

    if (tempPromptPath) {
      fs.unlink(tempPromptPath).catch(() => {});
    }

    if (!replyText) {
      publishLiveEvent({ companyId, type: "chat.agent.done", payload: { agentId: agent.id, agentName: agent.name, chatThreadId: threadId } });
      return true;
    }

    const [outRow] = await db
      .insert(operatorMessages)
      .values({
        companyId,
        issueId: null,
        roomId: null,
        direction: "outbound",
        platform: "chat",
        source: "chat",
        chatThreadId: threadId,
        body: replyText,
        rawPayload: null,
        fromAgentId: agent.id,
      })
      .returning({ id: operatorMessages.id });

    publishLiveEvent({
      companyId,
      type: "chat.message.new",
      payload: {
        id: outRow!.id,
        body: replyText,
        direction: "outbound",
        fromAgentId: agent.id,
        agentName: agent.name,
        chatThreadId: threadId,
        createdAt: new Date().toISOString(),
      },
    });
    publishLiveEvent({ companyId, type: "chat.agent.done", payload: { agentId: agent.id, agentName: agent.name, chatThreadId: threadId } });
    logger.info({ companyId, agentId: agent.id, threadId, replyText }, "chat-lean ◀ reply →");
    void logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agent.id,
      action: "chat.response",
      entityType: "chat_thread",
      entityId: threadId,
      agentId: agent.id,
      details: { reply: replyText.slice(0, 300), replyLength: replyText.length },
    });
  } catch (err) {
    if (tempPromptPath) { fs.unlink(tempPromptPath).catch(() => {}); }
    logger.warn({ err, agentId: agent.id }, "chat-lean: subprocess failed");
    void logActivity(db, {
      companyId,
      actorType: "system",
      actorId: agent.id,
      action: "chat.error",
      entityType: "chat_thread",
      entityId: threadId,
      agentId: agent.id,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    publishLiveEvent({ companyId, type: "chat.agent.done", payload: { agentId: agent.id, agentName: agent.name, chatThreadId: threadId } });
  }

  return true;
}

/**
 * Chat reply via claude CLI subprocess (subscription auth, no API key needed).
 * Returns true if handled, false if agent not found.
 */
export async function chatDirectReply(
  db: Db,
  companyId: string,
  agentId: string,
  threadId: string,
  userMessage: string,
  raw: unknown,
): Promise<boolean> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return false;

  const contextRefs = (
    raw &&
    typeof raw === "object" &&
    "contextRefs" in raw &&
    Array.isArray((raw as { contextRefs?: unknown }).contextRefs)
      ? (raw as { contextRefs: ContextRef[] }).contextRefs
      : []
  );

  return chatLeanReply(db, companyId, agent, threadId, userMessage, raw, contextRefs);
}
