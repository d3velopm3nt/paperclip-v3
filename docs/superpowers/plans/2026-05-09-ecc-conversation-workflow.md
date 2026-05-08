# ECC Conversation-Workflow Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ECC agent persistent short-term memory and workflow tracing by introducing `ecc_conversations`, three new MCP tools, and orchestrator pre/post-spawn wiring.

**Architecture:** New `ecc_conversations` DB table groups messages per topic in a 14-day window. The orchestrator injects all active conversations (with recent message history) into each Claude spawn. Three new MCP tools let Claude formally resolve a conversation, complete a turn (recording workflow stages), and extend an expiring conversation. Stdout is captured so Claude's response can be appended to the conversation's message log.

**Tech Stack:** Drizzle ORM (PGlite), TypeScript strict, Express 5, Vitest mocks, Claude CLI `--output-format stream-json`

---

## File Map

| File | Action |
|---|---|
| `packages/db/src/schema/ecc_conversations.ts` | **Create** — Drizzle table definition |
| `packages/db/src/schema/index.ts` | **Modify** — export new table |
| `packages/db/src/migrations/NNNN_ecc_conversations.sql` | **Generated** via `pnpm db:generate` |
| `server/src/services/ecc-conversations.ts` | **Create** — service: resolveActive, appendMessage, extend, expire, list, listAllActive |
| `server/src/__tests__/ecc-conversations.test.ts` | **Create** — mock-DB unit tests |
| `server/src/routes/mcp-tool-server.ts` | **Modify** — add 3 tools + handlers; import eccConversationsService, workflowRuns, workflowStageResults |
| `server/src/services/orchestrator.ts` | **Modify** — pre-spawn context, stdout capture, post-spawn append, updated ECC_SYSTEM_PROMPT |

---

## Task 1: DB Schema — `ecc_conversations`

**Files:**
- Create: `packages/db/src/schema/ecc_conversations.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```typescript
// packages/db/src/schema/ecc_conversations.ts
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { eccTopics } from "./ecc_topics.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  ts: string; // ISO string
}

export const eccConversations = pgTable(
  "ecc_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => eccTopics.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // active | expired | extended
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    recentMessages: jsonb("recent_messages")
      .$type<ConversationMessage[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    topicStatusIdx: index("ecc_conversations_topic_status_idx").on(
      table.topicId,
      table.status,
    ),
    expiresIdx: index("ecc_conversations_expires_idx").on(table.expiresAt),
    topicLastMsgIdx: index("ecc_conversations_topic_last_msg_idx").on(
      table.topicId,
      table.lastMessageAt,
    ),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, append after the existing ecc exports:

```typescript
// v3: ECC conversation sessions
export { eccConversations, type ConversationMessage } from "./ecc_conversations.js";
```

- [ ] **Step 3: Generate migration**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm db:generate
```

Expected: a new file `packages/db/src/migrations/NNNN_ecc_conversations.sql` created.

- [ ] **Step 4: Run typecheck to confirm schema compiles**

```bash
pnpm -r typecheck 2>&1 | grep -E "ecc_conversations|error TS" | head -20
```

Expected: no errors referencing `ecc_conversations`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/ecc_conversations.ts \
        packages/db/src/schema/index.ts \
        packages/db/src/migrations/ \
        packages/db/src/migrations/meta/
git commit -m "feat(db): add ecc_conversations table for ECC session memory"
```

---

## Task 2: `eccConversationsService`

**Files:**
- Create: `server/src/services/ecc-conversations.ts`
- Create: `server/src/__tests__/ecc-conversations.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/__tests__/ecc-conversations.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ConversationMessage } from "@paperclipai/db";

// ── Minimal DB mock ──────────────────────────────────────────────────────────

function makeConversationRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  return {
    id: "conv-1",
    topicId: "topic-1",
    status: "active",
    startedAt: now,
    lastMessageAt: now,
    expiresAt,
    messageCount: 1,
    recentMessages: [] as ConversationMessage[],
    createdAt: now,
    ...overrides,
  };
}

function makeDb(opts: {
  findRows?: unknown[];
  insertRows?: unknown[];
  updateRows?: unknown[];
} = {}): Db {
  const { findRows = [], insertRows = [], updateRows = [] } = opts;

  const returning = vi.fn().mockResolvedValue(insertRows.length ? insertRows : updateRows);
  const limit = vi.fn().mockResolvedValue(findRows);
  const orderBy = vi.fn().mockResolvedValue(findRows);
  const where = vi.fn().mockReturnValue({ limit, returning, orderBy });
  const set = vi.fn().mockReturnValue({ where });
  const values = vi.fn().mockReturnValue({ returning });
  const from = vi.fn().mockReturnValue({ where, orderBy });
  const select = vi.fn().mockReturnValue({ from });
  const insert = vi.fn().mockReturnValue({ values });
  const update = vi.fn().mockReturnValue({ set });

  return { select, insert, update } as unknown as Db;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("eccConversationsService", () => {
  it("resolveActive creates new conversation when none found", async () => {
    const { eccConversationsService } = await import("../services/ecc-conversations.js");
    const row = makeConversationRow();
    const db = makeDb({ findRows: [], insertRows: [row] });
    const svc = eccConversationsService(db);

    const result = await svc.resolveActive("topic-1");

    expect(result.id).toBe("conv-1");
    expect(result.status).toBe("active");
    expect((db.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("resolveActive returns and touches existing conversation", async () => {
    const { eccConversationsService } = await import("../services/ecc-conversations.js");
    const row = makeConversationRow({ messageCount: 5 });
    const updated = makeConversationRow({ messageCount: 6 });
    const db = makeDb({ findRows: [row], updateRows: [updated] });
    const svc = eccConversationsService(db);

    const result = await svc.resolveActive("topic-1");

    expect(result.messageCount).toBe(6);
    expect((db.update as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((db.insert as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("appendMessage adds message and trims to 20", async () => {
    const { eccConversationsService } = await import("../services/ecc-conversations.js");
    const existing: ConversationMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
      ts: new Date().toISOString(),
    }));
    const row = makeConversationRow({ recentMessages: existing });
    const db = makeDb({ findRows: [row], updateRows: [row] });
    const svc = eccConversationsService(db);

    await svc.appendMessage("conv-1", "assistant", "new response");

    const updateCall = (db.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall).toBeDefined();
    // The set call will contain the trimmed array
    const setCall = (db.update as ReturnType<typeof vi.fn>)();
    expect(setCall).toBeDefined();
  });

  it("extend updates expiresAt and sets status=extended", async () => {
    const { eccConversationsService } = await import("../services/ecc-conversations.js");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days left
    const row = makeConversationRow({ expiresAt });
    const extended = makeConversationRow({ status: "extended" });
    const db = makeDb({ findRows: [row], updateRows: [extended] });
    const svc = eccConversationsService(db);

    const result = await svc.extend("conv-1");

    expect(result.status).toBe("extended");
    expect((db.update as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run server/src/__tests__/ecc-conversations.test.ts 2>&1 | tail -15
```

Expected: `FAIL` with "Cannot find module '../services/ecc-conversations.js'"

- [ ] **Step 3: Create the service**

```typescript
// server/src/services/ecc-conversations.ts
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { eccConversations } from "@paperclipai/db";
import type { ConversationMessage } from "@paperclipai/db";

export type { ConversationMessage };

export interface EccConversation {
  id: string;
  topicId: string;
  status: string;
  startedAt: Date;
  lastMessageAt: Date;
  expiresAt: Date;
  messageCount: number;
  recentMessages: ConversationMessage[];
  createdAt: Date;
}

const WINDOW_DAYS = 14;
const MAX_RECENT = 20;

export function eccConversationsService(db: Db) {
  async function resolveActive(topicId: string): Promise<EccConversation> {
    const now = new Date();
    const existing = await db
      .select()
      .from(eccConversations)
      .where(
        and(
          eq(eccConversations.topicId, topicId),
          eq(eccConversations.status, "active"),
          gt(eccConversations.expiresAt, now),
        ),
      )
      .orderBy(desc(eccConversations.lastMessageAt))
      .limit(1);

    if (existing[0]) {
      const newExpiry = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
      const [updated] = await db
        .update(eccConversations)
        .set({
          lastMessageAt: now,
          expiresAt: newExpiry,
          messageCount: sql`${eccConversations.messageCount} + 1`,
        })
        .where(eq(eccConversations.id, existing[0].id))
        .returning();
      return updated as EccConversation;
    }

    const expiresAt = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
    const [created] = await db
      .insert(eccConversations)
      .values({
        topicId,
        status: "active",
        startedAt: now,
        lastMessageAt: now,
        expiresAt,
        messageCount: 1,
        recentMessages: [],
      })
      .returning();
    return created as EccConversation;
  }

  async function appendMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    if (!content.trim()) return;
    const rows = await db
      .select({ recentMessages: eccConversations.recentMessages })
      .from(eccConversations)
      .where(eq(eccConversations.id, conversationId))
      .limit(1);
    if (!rows[0]) return;

    const existing = (rows[0].recentMessages as ConversationMessage[]) ?? [];
    const newMsg: ConversationMessage = {
      role,
      content: content.slice(0, 2000),
      ts: new Date().toISOString(),
    };
    const updated = [...existing, newMsg].slice(-MAX_RECENT);

    await db
      .update(eccConversations)
      .set({ recentMessages: updated })
      .where(eq(eccConversations.id, conversationId));
  }

  async function extend(conversationId: string, extraDays = WINDOW_DAYS): Promise<EccConversation> {
    const rows = await db
      .select({ expiresAt: eccConversations.expiresAt })
      .from(eccConversations)
      .where(eq(eccConversations.id, conversationId))
      .limit(1);
    if (!rows[0]) throw new Error(`Conversation ${conversationId} not found`);

    const base = rows[0].expiresAt > new Date() ? rows[0].expiresAt : new Date();
    const newExpiry = new Date(base.getTime() + extraDays * 86_400_000);
    const [updated] = await db
      .update(eccConversations)
      .set({ expiresAt: newExpiry, status: "extended" })
      .where(eq(eccConversations.id, conversationId))
      .returning();
    return updated as EccConversation;
  }

  async function expire(conversationId: string): Promise<void> {
    await db
      .update(eccConversations)
      .set({ status: "expired" })
      .where(eq(eccConversations.id, conversationId));
  }

  async function list(topicId: string): Promise<EccConversation[]> {
    return db
      .select()
      .from(eccConversations)
      .where(eq(eccConversations.topicId, topicId))
      .orderBy(desc(eccConversations.lastMessageAt)) as Promise<EccConversation[]>;
  }

  async function listAllActive(): Promise<EccConversation[]> {
    const now = new Date();
    return db
      .select()
      .from(eccConversations)
      .where(
        and(
          eq(eccConversations.status, "active"),
          gt(eccConversations.expiresAt, now),
        ),
      )
      .orderBy(desc(eccConversations.lastMessageAt)) as Promise<EccConversation[]>;
  }

  return { resolveActive, appendMessage, extend, expire, list, listAllActive };
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
pnpm vitest run server/src/__tests__/ecc-conversations.test.ts 2>&1 | tail -10
```

Expected: `4 passed`

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "ecc-conversations\|error TS" | head -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/ecc-conversations.ts \
        server/src/__tests__/ecc-conversations.test.ts
git commit -m "feat(server): add eccConversationsService with 14-day session window"
```

---

## Task 3: Three New MCP Tools

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

The three tools are: `resolve_conversation`, `extend_conversation`, `complete_conversation_turn`.

- [ ] **Step 1: Add imports at top of `mcp-tool-server.ts`**

Find line 7 (after existing imports). Add:

```typescript
import { workflowRuns, workflowStageResults } from "@paperclipai/db";
import { eccConversationsService } from "../services/ecc-conversations.js";
import { eccTopicsService } from "../services/ecc-topics.js";
```

Note: `eccTopicsService` is already imported — keep the existing import, don't duplicate it.
Add only `workflowRuns`, `workflowStageResults`, and `eccConversationsService`.

The existing line 4 imports `agents, issues, ...` — add `workflowRuns, workflowStageResults` to that same destructure:

```typescript
import {
  agents, issues, projects, activityLog, emailMessages, emailAttachments,
  emailAccounts, clients, contacts, issueComments, approvals, operatorMessages,
  instanceSettings, companies, workflowRuns, workflowStageResults,
} from "@paperclipai/db";
```

Also add `lt` to the drizzle-orm imports on line 5:

```typescript
import { and, desc, eq, gt, gte, ilike, lt, or } from "drizzle-orm";
```

- [ ] **Step 2: Add three tool definitions to the TOOLS array**

Find the closing `];` of the `TOOLS` array (after `link_issue_to_topic` definition around line 349). Add before that `];`:

```typescript
  {
    name: "resolve_conversation",
    description:
      "REQUIRED on every ECC message. After matching a topic, call this to resolve or create the active conversation for that topic. Returns conversationId, runId, topic memory, and expiry info. Pass the returned runId to complete_conversation_turn at the end.",
    inputSchema: {
      type: "object",
      required: ["topicId"],
      properties: {
        topicId: {
          type: "string",
          description: "UUID of the matched topic",
        },
      },
    },
  },
  {
    name: "extend_conversation",
    description:
      "Extend an active conversation by 14 more days. Use when warningDays < 3 and JayJay confirms he wants to continue.",
    inputSchema: {
      type: "object",
      required: ["conversationId"],
      properties: {
        conversationId: {
          type: "string",
          description: "UUID of the conversation to extend",
        },
      },
    },
  },
  {
    name: "complete_conversation_turn",
    description:
      "REQUIRED at the end of every ECC message. Records final workflow stages and marks the run as passed.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          description: "runId returned by resolve_conversation",
        },
        memoryUpdated: {
          type: "boolean",
          description: "true if update_topic_memory was called this turn",
        },
        issuesLinked: {
          type: "boolean",
          description: "true if link_issue_to_topic was called this turn",
        },
      },
    },
  },
```

- [ ] **Step 3: Add three handlers in `handleTool` before the final `return` line**

Find the line `return \`Error: unknown tool "${name}"\`;` near the bottom of `handleTool`. Add before it:

```typescript
  if (name === "resolve_conversation") {
    const topicId = String(args.topicId);
    const topicSvc = eccTopicsService(db);
    const topic = await topicSvc.getById(topicId);
    if (!topic) return `Error: topic ${topicId} not found`;

    const convSvc = eccConversationsService(db);
    const conversation = await convSvc.resolveActive(topicId);

    // Use topic's companyId for the workflow_run; fall back to token's companyId
    const runCompanyId = topic.companyId ?? effectiveCompanyId;

    const now = new Date();
    const [run] = await db
      .insert(workflowRuns)
      .values({
        companyId: runCompanyId,
        workflowType: "ecc_conversation",
        sourceTable: "ecc_conversations",
        sourceId: conversation.id,
        overallStatus: "running",
        startedAt: now,
      })
      .returning();

    await db.insert(workflowStageResults).values([
      {
        runId: run!.id,
        stageId: "message_received",
        label: "Message received",
        status: "passed",
        expectations: ["Inbound message arrived"],
        actuals: {},
        errorText: null,
        ord: 0,
        computedAt: now,
      },
      {
        runId: run!.id,
        stageId: "topic_matched",
        label: "Topic matched",
        status: "passed",
        expectations: ["ECC identified topic from message context"],
        actuals: { topicId, topicName: topic.name },
        errorText: null,
        ord: 1,
        computedAt: now,
      },
      {
        runId: run!.id,
        stageId: "conversation_resolved",
        label: "Conversation resolved",
        status: "passed",
        expectations: ["Active conversation found or created"],
        actuals: {
          conversationId: conversation.id,
          messageCount: conversation.messageCount,
          isNew: conversation.messageCount === 1,
        },
        errorText: null,
        ord: 2,
        computedAt: now,
      },
    ]);

    const msUntilExpiry = conversation.expiresAt.getTime() - Date.now();
    const warningDays = Math.ceil(msUntilExpiry / 86_400_000);

    return JSON.stringify({
      conversationId: conversation.id,
      runId: run!.id,
      topicName: topic.name,
      summary: topic.summary,
      currentState: topic.currentState,
      expiresAt: conversation.expiresAt.toISOString(),
      messageCount: conversation.messageCount,
      warningDays,
    });
  }

  if (name === "extend_conversation") {
    const convSvc = eccConversationsService(db);
    const result = await convSvc.extend(String(args.conversationId));
    return `Conversation extended until ${result.expiresAt.toISOString()}.`;
  }

  if (name === "complete_conversation_turn") {
    const runId = String(args.runId);
    const memoryUpdated = Boolean(args.memoryUpdated);
    const issuesLinked = Boolean(args.issuesLinked);

    // Find the highest ord in this run
    const existing = await db
      .select({ ord: workflowStageResults.ord })
      .from(workflowStageResults)
      .where(eq(workflowStageResults.runId, runId))
      .orderBy(desc(workflowStageResults.ord))
      .limit(1);
    const nextOrd = (existing[0]?.ord ?? 2) + 1;

    const now = new Date();
    await db.insert(workflowStageResults).values([
      {
        runId,
        stageId: "memory_updated",
        label: "Memory updated",
        status: memoryUpdated ? "passed" : "skipped",
        expectations: ["Topic memory updated with new context"],
        actuals: {},
        errorText: null,
        ord: nextOrd,
        computedAt: now,
      },
      {
        runId,
        stageId: "action_taken",
        label: "Action taken",
        status: "passed",
        expectations: ["ECC completed turn with response"],
        actuals: { issuesLinked: Boolean(issuesLinked) },
        errorText: null,
        ord: nextOrd + 1,
        computedAt: now,
      },
    ]);

    await db
      .update(workflowRuns)
      .set({ overallStatus: "passed", finishedAt: now })
      .where(eq(workflowRuns.id, runId));

    return "Turn complete.";
  }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "mcp-tool-server\|error TS" | head -15
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add resolve_conversation, extend_conversation, complete_conversation_turn tools"
```

---

## Task 4: Orchestrator — Context Injection + Stdout Capture + Post-spawn Append

**Files:**
- Modify: `server/src/services/orchestrator.ts`

- [ ] **Step 1: Add imports**

At the top of `orchestrator.ts`, add after the existing imports:

```typescript
import { eccConversationsService } from "./ecc-conversations.js";
import { eccTopicsService } from "./ecc-topics.js";
import type { ConversationMessage } from "@paperclipai/db";
```

- [ ] **Step 2: Add `buildActiveConversationsContext` helper**

Add this function before `runOrchestrator`:

```typescript
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

      const daysLeft = Math.ceil(
        (conv.expiresAt.getTime() - Date.now()) / 86_400_000,
      );
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
```

- [ ] **Step 3: Add `parseAssistantText` helper**

Add after `buildActiveConversationsContext`:

```typescript
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
```

- [ ] **Step 4: Update `runOrchestrator` — pre-spawn context injection**

In `runOrchestrator`, find this existing block (around line 107–117):

```typescript
    } catch {
      // non-fatal — Claude can call list_companies tool instead
    }
  } else {
```

Insert the two new lines **between** the `} catch { ... }` close and the `} else {`:

```typescript
    } catch {
      // non-fatal — Claude can call list_companies tool instead
    }

    // NEW: inject active conversations (short-term memory)
    const convContext = await buildActiveConversationsContext(db);
    if (convContext) contextLines.push(convContext);
  } else {
```

Do NOT replace the surrounding code — only insert the two new lines shown.
```

- [ ] **Step 5: Capture stdout + record spawnStart**

Find the `spawn` call in `runOrchestrator`. Before it, add `spawnStart`. After it, add stdout capture:

```typescript
  const spawnStart = new Date();
  const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
  proc.stdin.write(stdin);
  proc.stdin.end();

  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
```

Replace the existing `proc.stderr.on` line (don't add a second one — replace the block):

The existing code has:
```typescript
  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
```

Replace it with the full version above (adding `stdout` capture).

- [ ] **Step 6: Add post-spawn append after `proc.on("close")`**

Find the `await Promise.allSettled([fs.unlink...])` line at the end of `runOrchestrator`. After it, add:

```typescript
  // Post-spawn: append this exchange to the active conversation's message log
  if (isOperator) {
    try {
      const convSvc = eccConversationsService(db);
      const updated = await convSvc.listAllActive();
      const touched = updated.find((c) => c.lastMessageAt >= spawnStart);
      if (touched) {
        await convSvc.appendMessage(touched.id, "user", input.body);
        const assistantText = parseAssistantText(stdout);
        if (assistantText) {
          await convSvc.appendMessage(touched.id, "assistant", assistantText);
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "orchestrator: failed to append conversation message");
    }
  }
```

- [ ] **Step 7: Typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "orchestrator\|error TS" | head -15
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/orchestrator.ts
git commit -m "feat(server): wire ECC conversation context into orchestrator pre/post spawn"
```

---

## Task 5: Update ECC System Prompt

**Files:**
- Modify: `server/src/services/orchestrator.ts` (ECC_SYSTEM_PROMPT constant)

- [ ] **Step 1: Replace `ECC_SYSTEM_PROMPT`**

Find the `const ECC_SYSTEM_PROMPT = \`...\`` block. Replace the entire constant with:

```typescript
const ECC_SYSTEM_PROMPT = `You are the Paperclip Executive Command Center (ECC) — JayJay Barnard's operational intelligence layer.

JayJay is the founder of multiple companies. You have cross-company access to all of them via the list_companies tool.

## Your role
- Act as an executive assistant and operational intelligence layer
- Understand context, retrieve relevant information, suggest intelligent actions
- Maintain awareness across all companies and workstreams
- Require JayJay's approval before high-risk actions (sending emails, committing funds, deploying code, making business commitments)
- Keep JayJay informed: what happened, what is blocked, what needs attention

## Conversation protocol — REQUIRED on every message

You are stateless. Each message is a fresh subprocess with zero memory of previous turns.
The "Active Conversations" section in the message context gives you short-term memory — read it first.

**On every message, in this order:**
1. Read the "Active Conversations" section — identify which conversation this message continues
2. Match message to the most relevant active conversation topic
3. If a match exists: call resolve_conversation(topicId) immediately
4. If no active conversation but a topic exists: call resolve_conversation(topicId) to start a new conversation
5. If no matching topic at all: ask JayJay which topic this belongs to, or propose a name for a new topic and wait for confirmation before calling create_topic
6. Do your work (list_issues, update_topic_memory, notify_operator, etc.)
7. Call complete_conversation_turn(runId, {memoryUpdated, issuesLinked}) as the final action before finishing

## Expiry management

After resolve_conversation returns, check warningDays:
- warningDays < 3: include in your response "⚠️ Conversation '[topic name]' expires in X days. Reply 'extend' to continue."
- JayJay replies with "extend" or similar: call extend_conversation(conversationId)
- expiresAt already past: tell JayJay the conversation expired, ask to start fresh or extend

## Operating model
1. Understand the message — who, what, which company, urgency, risk
2. Read active conversations context — identify topic and continue conversation
3. Retrieve live context — call list_issues, get_issue_comments, get_issue_plans as needed
4. Reason and suggest — propose next actions clearly
5. Act or ask — execute low-risk actions directly, request approval for high-risk ones
6. Report — notify_operator with a concise update of what was done or what needs attention

## Tool usage rules
- **resolve_conversation**: Call first (after reading active conversations context). Required.
- **complete_conversation_turn**: Call last. Always. Pass runId from resolve_conversation.
- **list_companies**: Call when unsure which company is relevant. Returns all company IDs.
- **list_topics**: Use to find topics when active conversations context is insufficient.
- **list_issues**: Pass the relevant companyId. Can filter by status.
- **get_issue_comments**: Read the full thread on an issue before making decisions about it.
- **get_issue_plans**: Check existing plans before creating new ones.
- **notify_operator**: Use for concise operational updates. Short, direct, no fluff.
- **create_plan**: Use for multi-step work that needs JayJay's review and approval.
- **add_issue_comment**: Log important decisions and context as comments on issues.
- **update_topic_memory**: Update the topic's persistent markdown memory after significant new information.

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
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "orchestrator\|error TS" | head -10
```

Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
pnpm test:run 2>&1 | tail -8
```

Expected: same pass/fail counts as before (no regressions from our changes).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/orchestrator.ts
git commit -m "feat(server): update ECC system prompt with conversation protocol and expiry management"
```

---

## Task 6: Manual End-to-End Test

No code changes — this is verification via Telegram.

- [ ] **Step 1: Start dev server**

```bash
pnpm dev
```

Wait for: `API ready on :3100`

- [ ] **Step 2: Ensure at least one active ECC topic exists**

Open `http://localhost:3100`, navigate to Founder → Topics. Create a topic if none exists (e.g. "Develtech Website" for a specific company).

- [ ] **Step 3: Send test message via Telegram**

Send: *"Update on the [topic name] project"*

Wait 10–30 seconds for Claude to process.

Expected: ECC responds with relevant context. No error in server logs.

- [ ] **Step 4: Verify conversation was created**

```bash
# Check DB via API (or direct query)
curl -s http://localhost:3100/api/workflow-runs/by-source/ecc_conversation/CONVERSATION_ID
```

Or check server logs for: `orchestrator: complete` without errors.

The conversationId appears in the ECC's response (from resolve_conversation call).

- [ ] **Step 5: Send follow-up message**

Send (within a few minutes): *"What's the main blocker?"*

Expected: ECC responds with context from the previous message (via recentMessages injection). Should not ask which topic — it recognises from Active Conversations context.

- [ ] **Step 6: Verify workflow runs exist**

Check server logs for `"orchestrator: complete"` after each Telegram message — no errors.

Then open the Paperclip board UI → navigate to any company's Workflow Runs page (if visible) or confirm via server log output that `workflowType: "ecc_conversation"` runs were inserted by checking the server logs with:

```bash
pnpm dev 2>&1 | grep -E "orchestrator:|ecc_conversation"
```

Expected per message: one `orchestrator: starting` → one `orchestrator: complete`, no stack traces.

- [ ] **Step 7: Final commit**

```bash
git add -A
git status  # confirm nothing untracked that shouldn't be committed
git commit -m "test: verify ECC conversation-workflow e2e (manual)"
```

---

## Verification Summary

All three must pass before handing off:

```bash
pnpm -r typecheck && pnpm test:run && pnpm build
```

Known pre-existing build failures: `AgentPerformanceTab.tsx` type errors — unrelated to this feature.
