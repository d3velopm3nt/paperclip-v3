# ECC Agents Founder Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the ECC orchestrator as two founder-level agents (Executive Control + Client Control), surface them in the Founder Overview, and make their system prompts editable from the agent detail page.

**Architecture:** Make `agents.companyId` nullable for founder-level agents; add `agentId` to `workflow_runs`; seed two ECC agents on startup; orchestrator reads prompts from DB and sets agent status around each spawn; `PromptsTab` renders an editable textarea for `adapterType === "ecc"`.

**Tech Stack:** Drizzle ORM, Express 5, React 19, TanStack Query, TypeScript (strict), PGlite (dev)

---

## File Map

| File | What changes |
|------|-------------|
| `packages/db/src/schema/agents.ts` | `companyId` → nullable |
| `packages/db/src/schema/workflow_runs.ts` | Add nullable `agentId` FK column |
| `packages/db/src/schema/index.ts` | Verify both schemas exported (likely no change) |
| `server/src/services/ecc-agents.ts` | **New** — seed, setProcessing, setIdle, listEccAgents, getEccAgent |
| `server/src/services/orchestrator.ts` | Read prompt from DB; set agent status; pass real agentId to MCP token |
| `server/src/routes/mcp-tool-server.ts` | Store `agentId` on workflow_run insert in `resolve_conversation` |
| `server/src/routes/ecc-topics.ts` | Add `GET /ecc/agents` route |
| `server/src/routes/agents.ts` | Null-guard in auth helpers for null-companyId agents |
| `server/src/index.ts` | Call ECC agent seeder on startup |
| `ui/src/pages/founder/FounderOverview.tsx` | New ECC Agents section + `EccAgentCard` component |
| `ui/src/pages/AgentDetail.tsx` | ECC textarea case in `PromptsTab` (lines ~1945) |

---

## Task 1: Schema — nullable companyId + agentId on workflow_runs

**Files:**
- Modify: `packages/db/src/schema/agents.ts`
- Modify: `packages/db/src/schema/workflow_runs.ts`

- [ ] **Step 1: Make `companyId` nullable in agents schema**

In `packages/db/src/schema/agents.ts`, change line 17:

```ts
// BEFORE:
companyId: uuid("company_id").notNull().references(() => companies.id),

// AFTER:
companyId: uuid("company_id").references(() => companies.id),
```

Also remove the `companyStatusIdx` index that references `companyId` (it would be sparse and useless with nulls) — replace with a partial-friendly index:

```ts
// BEFORE (in table options):
(table) => ({
  companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
  companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
}),

// AFTER (unchanged — Drizzle handles nulls in indexes fine, keep as-is):
(table) => ({
  companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
  companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
  adapterTypeIdx: index("agents_adapter_type_idx").on(table.adapterType),
}),
```

- [ ] **Step 2: Add nullable `agentId` to workflow_runs schema**

In `packages/db/src/schema/workflow_runs.ts`, add the import and column:

```ts
// BEFORE:
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowType: text("workflow_type").notNull(),

// AFTER:
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    workflowType: text("workflow_type").notNull(),
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

Expected: new migration file created in `packages/db/src/migrations/` with `ALTER TABLE agents ALTER COLUMN company_id DROP NOT NULL` and `ALTER TABLE workflow_runs ADD COLUMN agent_id uuid`.

- [ ] **Step 4: Run typecheck to verify schema compiles**

```bash
pnpm -r typecheck
```

Expected: passes (or only ECC-related errors from downstream usages we'll fix in later tasks).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/agents.ts packages/db/src/schema/workflow_runs.ts packages/db/src/migrations/
git commit -m "feat(db): nullable companyId on agents, add agentId to workflow_runs"
```

---

## Task 2: New `ecc-agents` service

**Files:**
- Create: `server/src/services/ecc-agents.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/ecc-agents.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers/db.js";
import { eccAgentsService } from "../services/ecc-agents.js";

describe("eccAgentsService", () => {
  let db: ReturnType<typeof createTestDb>;
  let svc: ReturnType<typeof eccAgentsService>;

  beforeEach(async () => {
    db = await createTestDb();
    svc = eccAgentsService(db);
  });

  it("seeds two ECC agents if none exist", async () => {
    await svc.seedEccAgents();
    const agents = await svc.listEccAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name)).toEqual(
      expect.arrayContaining(["Executive Control Agent", "Client Control Agent"]),
    );
  });

  it("seed is idempotent", async () => {
    await svc.seedEccAgents();
    await svc.seedEccAgents();
    const agents = await svc.listEccAgents();
    expect(agents).toHaveLength(2);
  });

  it("getEccAgent returns correct agent by role", async () => {
    await svc.seedEccAgents();
    const exec = await svc.getEccAgent("operator");
    const client = await svc.getEccAgent("client");
    expect(exec?.name).toBe("Executive Control Agent");
    expect(client?.name).toBe("Client Control Agent");
  });

  it("setProcessing updates status and metadata", async () => {
    await svc.seedEccAgents();
    const exec = await svc.getEccAgent("operator");
    await svc.setProcessing(exec!.id, "topic-id-123", "Rockdog Pipeline", "Can we push...");
    const updated = await svc.getEccAgent("operator");
    expect(updated?.status).toBe("processing");
    expect((updated?.metadata as Record<string, unknown>)?.currentTopicName).toBe("Rockdog Pipeline");
  });

  it("setIdle clears metadata and updates lastHeartbeatAt", async () => {
    await svc.seedEccAgents();
    const exec = await svc.getEccAgent("operator");
    await svc.setProcessing(exec!.id, "topic-id-123", "Rockdog", "msg");
    await svc.setIdle(exec!.id);
    const updated = await svc.getEccAgent("operator");
    expect(updated?.status).toBe("idle");
    expect(updated?.metadata).toEqual({});
    expect(updated?.lastHeartbeatAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run server/src/__tests__/ecc-agents.test.ts
```

Expected: FAIL — `ecc-agents.ts` does not exist.

- [ ] **Step 3: Create the service**

Create `server/src/services/ecc-agents.ts`:

```ts
import { eq, and, isNull } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

const ECC_SYSTEM_PROMPT_OPERATOR = `You are the Paperclip Executive Command Center (ECC) — JayJay Barnard's operational intelligence layer.

JayJay is the founder of multiple companies. You have cross-company access to all of them via the list_companies tool.

## Your role
- Act as an executive assistant and operational intelligence layer
- Understand context, retrieve relevant information, suggest intelligent actions
- Maintain awareness across all companies and workstreams
- Require JayJay's approval before high-risk actions (sending emails, committing funds, deploying code, making business commitments)
- Keep JayJay informed: what happened, what is blocked, what needs attention

## Conversation protocol — MANDATORY on every message
Every message you process belongs to a topic and conversation. You MUST:
1. **Identify topic first** — see Topic matching rules below. Do NOT call resolve_conversation until you have confirmed the correct topic.
2. **Start**: Call resolve_conversation(topicId, messagePreview) with the confirmed topicId. Pass the first 200 chars of the message as messagePreview.
3. **Work**: Process the message using the full conversation context returned by resolve_conversation.
4. **End**: Call complete_conversation_turn(runId, actionSummary, issuesLinked) — always. Pass a one-line actionSummary of what you did. This closes the workflow run.

Never skip these bookend calls. They are the source of truth for conversation continuity.

## Topic matching — STRICT rules
The Active Conversations context above shows what is currently open. Use it for memory/context — NOT as a default assignment.

**You MUST match semantically:**
- Read the message content carefully. What subject, company, person, or project does it concern?
- Check Active Conversations: does the topic name/memory CLEARLY relate to this message? Only use an active conversation's topicId if the match is obvious and unambiguous.
- If the active conversation topic does NOT match, call list_topics to find a better fit.
- If list_topics returns no clear match: call notify_operator asking JayJay which topic this belongs to, or whether to create a new one. Then call complete_conversation_turn with the run from the closest topic, or skip resolve_conversation entirely and just notify.

**When no topic matches:**
1. Use the ECC Inbox topic-id (provided in context under "Inbox fallback") for resolve_conversation.
2. Call notify_operator: "Message received about [X]. Logged to Inbox. Should I create a new topic '[suggested name]' under [company]? Or assign to an existing topic?"
3. Call complete_conversation_turn as normal.

## Memory maintenance
After processing a message, call update_topic_memory to update topic.summary and currentState if anything significant changed.

## Response style
Keep your text responses very short — the tools do the work.`;

const ECC_SYSTEM_PROMPT_CLIENT = `You are the Paperclip Orchestrator — the unified intelligence for all inbound communication.

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

## Response style
Keep your text responses very short — the tools do the work. Use them.`;

export interface EccAgentMetadata {
  currentTopicId?: string;
  currentTopicName?: string;
  lastMessagePreview?: string;
}

export function eccAgentsService(db: Db) {
  async function listEccAgents() {
    return db
      .select()
      .from(agents)
      .where(and(isNull(agents.companyId), eq(agents.adapterType, "ecc")));
  }

  async function getEccAgent(role: "operator" | "client") {
    const name =
      role === "operator" ? "Executive Control Agent" : "Client Control Agent";
    const rows = await db
      .select()
      .from(agents)
      .where(
        and(isNull(agents.companyId), eq(agents.adapterType, "ecc"), eq(agents.name, name)),
      );
    return rows[0] ?? null;
  }

  async function seedEccAgents() {
    const existing = await listEccAgents();
    const existingNames = new Set(existing.map((a) => a.name));

    const toSeed = [
      {
        name: "Executive Control Agent",
        adapterConfig: { systemPrompt: ECC_SYSTEM_PROMPT_OPERATOR, promptVersion: 1 },
      },
      {
        name: "Client Control Agent",
        adapterConfig: { systemPrompt: ECC_SYSTEM_PROMPT_CLIENT, promptVersion: 1 },
      },
    ].filter((a) => !existingNames.has(a.name));

    if (toSeed.length === 0) return;

    await db.insert(agents).values(
      toSeed.map((a) => ({
        name: a.name,
        role: "orchestrator",
        adapterType: "ecc",
        companyId: null,
        adapterConfig: a.adapterConfig,
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        status: "idle",
      })),
    );
  }

  async function setProcessing(
    id: string,
    topicId: string,
    topicName: string,
    messagePreview: string,
  ) {
    await db
      .update(agents)
      .set({
        status: "processing",
        metadata: { currentTopicId: topicId, currentTopicName: topicName, lastMessagePreview: messagePreview.slice(0, 120) },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));
  }

  async function setIdle(id: string) {
    await db
      .update(agents)
      .set({
        status: "idle",
        metadata: {},
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));
  }

  return { listEccAgents, getEccAgent, seedEccAgents, setProcessing, setIdle };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run server/src/__tests__/ecc-agents.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/ecc-agents.ts server/src/__tests__/ecc-agents.test.ts
git commit -m "feat(ecc): add eccAgentsService — seed, status, prompt storage"
```

---

## Task 3: Add `GET /ecc/agents` route + seed on startup

**Files:**
- Modify: `server/src/routes/ecc-topics.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add route to ecc-topics.ts**

At the bottom of `eccTopicRoutes` in `server/src/routes/ecc-topics.ts`, before the final `return router`, add:

```ts
import { eccAgentsService } from "../services/ecc-agents.js";

// ... inside eccTopicRoutes function, before `return router`:

  router.get("/ecc/agents", async (req, res) => {
    assertBoard(req);
    const agentSvc = eccAgentsService(db);
    const eccAgents = await agentSvc.listEccAgents();
    res.json(eccAgents);
  });
```

- [ ] **Step 2: Call seeder on startup in server/src/index.ts**

Add import near the top (line ~38, with other service imports):

```ts
import { eccAgentsService } from "./services/ecc-agents.js";
```

Find the `ensureLocalTrustedBoardPrincipal` call (line ~464):

```ts
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
```

Add the seed call immediately after that block:

```ts
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  await eccAgentsService(db as any).seedEccAgents();
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 4: Start dev server and verify endpoint**

```bash
pnpm dev:server &
curl -s http://localhost:3100/api/ecc/agents -H "Authorization: Bearer $(cat ~/.paperclip/instances/default/board-token 2>/dev/null || echo 'local')"
```

Expected: JSON array with 2 ECC agents.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ecc-topics.ts server/src/index.ts
git commit -m "feat(ecc): GET /ecc/agents route + seed ECC agents on startup"
```

---

## Task 4: Auth guard for null-companyId agents

**Files:**
- Modify: `server/src/routes/agents.ts`

- [ ] **Step 1: Fix auth helpers**

In `server/src/routes/agents.ts`, the `assertCanReadAgent`, `assertCanUpdateAgent`, `assertCanReadConfigurations`, and `assertCanManageInstructionsPath` functions all call `assertCompanyAccess(req, targetAgent.companyId)`. When `companyId` is null this TypeScript errors and would throw at runtime.

Find each helper and add a null-guard. Example for `assertCanReadAgent` (around line 244):

```ts
// BEFORE:
async function assertCanReadAgent(req: Request, targetAgent: { companyId: string }) {
  assertCompanyAccess(req, targetAgent.companyId);
}

// AFTER:
async function assertCanReadAgent(req: Request, targetAgent: { companyId: string | null }) {
  if (!targetAgent.companyId) {
    assertBoard(req);
    return;
  }
  assertCompanyAccess(req, targetAgent.companyId);
}
```

Apply the same pattern to `assertCanUpdateAgent` (line ~222), `assertCanReadConfigurations` (line ~205), and `assertCanManageInstructionsPath` (line ~486). Each gets:
- Parameter type widened to `{ companyId: string | null }` (or `{ id: string; companyId: string | null }`)
- Null-guard at top: `if (!targetAgent.companyId) { assertBoard(req); return; }`

- [ ] **Step 2: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/agents.ts
git commit -m "fix(agents): null-guard auth helpers for founder-level (null companyId) agents"
```

---

## Task 5: Orchestrator — DB prompt + agent status lifecycle

**Files:**
- Modify: `server/src/services/orchestrator.ts`

The goal: orchestrator looks up both ECC agents at spawn time, reads their `adapterConfig.systemPrompt` from DB (fallback to hardcoded), passes the real agent UUID in the MCP token (so `callerAgentId` in the tool handler becomes the real agent UUID), and calls `setProcessing`/`setIdle` around the spawn.

- [ ] **Step 1: Add imports and modify `runOrchestrator`**

At the top of `server/src/services/orchestrator.ts`, add:

```ts
import { eccAgentsService } from "./ecc-agents.js";
```

Inside `runOrchestrator`, find the line `const isOperator = input.fromType === "operator";` and after it, add:

```ts
const eccSvc = eccAgentsService(db);
const execAgent = await eccSvc.getEccAgent("operator");
const clientAgent = await eccSvc.getEccAgent("client");
const activeEccAgent = isOperator ? execAgent : clientAgent;
```

- [ ] **Step 2: Replace hardcoded system prompt with DB lookup**

Find:

```ts
const systemPrompt = isOperator ? ECC_SYSTEM_PROMPT : CLIENT_SYSTEM_PROMPT;
await fs.writeFile(promptPath, systemPrompt, "utf-8");
```

Replace with:

```ts
const dbPrompt = (activeEccAgent?.adapterConfig as Record<string, unknown> | null)?.systemPrompt;
const systemPrompt =
  typeof dbPrompt === "string" && dbPrompt.length > 0
    ? dbPrompt
    : isOperator
    ? ECC_SYSTEM_PROMPT
    : CLIENT_SYSTEM_PROMPT;
await fs.writeFile(promptPath, systemPrompt, "utf-8");
```

- [ ] **Step 3: Pass real agent UUID in MCP token**

Find:

```ts
const mcpToken = signMcpToken({
  companyId,
  agentId: "orchestrator",
  isOperator,
});
```

Replace with:

```ts
const mcpToken = signMcpToken({
  companyId,
  agentId: activeEccAgent?.id ?? "orchestrator",
  isOperator,
});
```

- [ ] **Step 4: Set processing status before spawn, idle after**

Find the line `const spawnStart = new Date();` (just before `const proc = spawn(...)`). Before it, add:

```ts
const messagePreview = input.body.slice(0, 120);
if (execAgent) {
  await eccSvc.setProcessing(execAgent.id, "", "", messagePreview).catch(() => {});
}
if (clientAgent) {
  await eccSvc.setProcessing(clientAgent.id, "", "", messagePreview).catch(() => {});
}
```

Then find the `await Promise.allSettled([fs.unlink(mcpConfigPath), fs.unlink(promptPath)])` line and after it add:

```ts
if (execAgent) await eccSvc.setIdle(execAgent.id).catch(() => {});
if (clientAgent) await eccSvc.setIdle(clientAgent.id).catch(() => {});
```

Note: the `.catch(() => {})` makes status updates non-fatal — orchestrator continues even if DB update fails.

- [ ] **Step 5: Update topic metadata once topic is known (optional enhancement)**

The `resolve_conversation` MCP tool is called by the Claude subprocess and has access to the topicId. Since the agent UUID is now in `callerAgentId` inside the tool handler, we can update the metadata there. This is done in Task 6.

- [ ] **Step 6: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/orchestrator.ts
git commit -m "feat(orchestrator): read ECC prompts from DB, set agent status around spawn"
```

---

## Task 6: Store agentId on workflow_run in resolve_conversation

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

The `callerAgentId` variable in `handleTool` is now the real ECC agent UUID (from the MCP token set in Task 5). Store it on the workflow run insert.

- [ ] **Step 1: Add agentId to workflow_runs insert**

In `server/src/routes/mcp-tool-server.ts`, find the `resolve_conversation` handler (around line 986). The `db.insert(workflowRuns).values({...})` call currently has:

```ts
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
```

Change to:

```ts
const [run] = await db
  .insert(workflowRuns)
  .values({
    companyId: runCompanyId,
    agentId: callerAgentId ?? undefined,
    workflowType: "ecc_conversation",
    sourceTable: "ecc_conversations",
    sourceId: conversation.id,
    overallStatus: "running",
    startedAt: now,
  })
  .returning();
```

- [ ] **Step 2: Update topic metadata with real topic name**

In the same `resolve_conversation` handler, after the workflow run insert, add a best-effort metadata update. `callerAgentId` is the ECC agent UUID:

```ts
// After run insert, update agent metadata with real topic name
if (callerAgentId) {
  const eccSvc = eccAgentsService(db);
  eccSvc.setProcessing(callerAgentId, topic.id, topic.name, messagePreview ?? "").catch(() => {});
}
```

This requires importing `eccAgentsService` at the top of `mcp-tool-server.ts`:

```ts
import { eccAgentsService } from "../services/ecc-agents.js";
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): store agentId on workflow_run, update ECC agent metadata at resolve_conversation"
```

---

## Task 7: FounderOverview — ECC Agents section

**Files:**
- Modify: `ui/src/pages/founder/FounderOverview.tsx`

- [ ] **Step 1: Add ECC agent types and query**

At the top of `FounderOverview.tsx` (after existing interfaces), add:

```ts
interface EccAgent {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: string | null;
  metadata: {
    currentTopicId?: string;
    currentTopicName?: string;
    lastMessagePreview?: string;
  } | null;
}
```

Inside `FounderOverview`, after the existing `convsQuery`, add:

```ts
const eccAgentsQuery = useQuery({
  queryKey: ["ecc-agents"],
  queryFn: () => api.get<EccAgent[]>("/ecc/agents"),
  refetchInterval: (query) =>
    query.state.data?.some((a) => a.status === "processing") ? 5_000 : 15_000,
});

const eccAgents = eccAgentsQuery.data ?? [];
```

- [ ] **Step 2: Add EccAgentCard component**

Add this component near the other card components at the top of the file (e.g. after `ConvCard`):

```tsx
function EccAgentCard({ agent, onClick }: { agent: EccAgent; onClick: () => void }) {
  const isProcessing = agent.status === "processing";
  const isPaused = agent.status === "paused" || agent.status === "error";
  const topicName = agent.metadata?.currentTopicName;
  const messagePreview = agent.metadata?.lastMessagePreview;

  const borderColor = isProcessing
    ? "border-blue-500/40"
    : isPaused
    ? "border-red-500/40"
    : "border-border";
  const bgColor = isProcessing ? "bg-blue-500/5" : isPaused ? "bg-red-500/5" : "bg-card";
  const dotColor = isProcessing ? "bg-blue-400" : isPaused ? "bg-red-400" : "bg-muted-foreground/30";

  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border ${borderColor} ${bgColor} p-3 hover:border-foreground/20 transition-colors w-full`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor} ${isProcessing ? "animate-pulse" : ""}`}
        />
        <span className="text-xs font-medium truncate">{agent.name}</span>
      </div>
      <div className="mb-1">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            isProcessing
              ? "bg-blue-500/10 text-blue-400"
              : isPaused
              ? "bg-red-500/10 text-red-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {agent.status}
        </span>
      </div>
      {isProcessing && topicName ? (
        <div className="space-y-0.5">
          <p className="text-[11px] text-violet-400 font-medium truncate">{topicName}</p>
          {messagePreview && (
            <p className="text-[11px] text-muted-foreground line-clamp-1">{messagePreview}</p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {agent.lastHeartbeatAt ? `last active ${relativeTime(agent.lastHeartbeatAt)}` : "never active"}
        </p>
      )}
    </button>
  );
}
```

- [ ] **Step 3: Render ECC Agents section above Companies**

In the JSX of `FounderOverview`, find the `<section>` containing the Companies grid. Add the ECC Agents section directly before it:

```tsx
{/* ECC Agents */}
{eccAgents.length > 0 && (
  <section>
    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
      ECC Agents
    </h2>
    <div className="grid grid-cols-2 gap-3">
      {eccAgents.map((agent) => (
        <EccAgentCard
          key={agent.id}
          agent={agent}
          onClick={() => navigate(`/agents/${agent.id}/instructions`)}
        />
      ))}
    </div>
  </section>
)}

{/* Companies (existing section follows) */}
<section>
  <h2 ...>Companies</h2>
```

- [ ] **Step 4: Start dev server and verify visually**

```bash
pnpm dev
```

Open http://localhost:3100, navigate to `/founder`. Verify:
- "ECC Agents" section appears above Companies
- Two cards: "Executive Control Agent" and "Client Control Agent"
- Both show `idle` with last active time
- Cards are clickable

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/founder/FounderOverview.tsx
git commit -m "feat(ui): ECC Agents section in FounderOverview — live status cards"
```

---

## Task 8: AgentDetail — ECC prompt textarea in PromptsTab

**Files:**
- Modify: `ui/src/pages/AgentDetail.tsx`

- [ ] **Step 1: Add ECC detection and state in PromptsTab**

In `PromptsTab` (function starts around line 1638), after the `isLocal` declaration (line ~1692), add:

```ts
const isEcc = agent.adapterType === "ecc";
const [eccDraft, setEccDraft] = useState<string | null>(null);
const eccPersistedPrompt = typeof (agent.adapterConfig as Record<string, unknown>)?.systemPrompt === "string"
  ? (agent.adapterConfig as Record<string, unknown>).systemPrompt as string
  : "";
const eccCurrentPrompt = eccDraft ?? eccPersistedPrompt;
const eccDirty = eccDraft !== null && eccDraft !== eccPersistedPrompt;
```

- [ ] **Step 2: Wire dirty/save/cancel into parent callbacks for ECC**

In the same `PromptsTab`, find where the mutation for `isLocal` path is set up (the `onDirtyChange`/`onSaveActionChange` calls). Add a parallel `useEffect` for ECC:

```ts
useEffect(() => {
  if (!isEcc) return;
  onDirtyChange(eccDirty);
  if (eccDirty) {
    onSaveActionChange(() => () => {
      saveEccPrompt(eccCurrentPrompt);
    });
    onCancelActionChange(() => () => {
      setEccDraft(null);
    });
  } else {
    onSaveActionChange(null);
    onCancelActionChange(null);
  }
}, [isEcc, eccDirty, eccCurrentPrompt]);
```

- [ ] **Step 3: Add save mutation for ECC**

In `PromptsTab`, add the mutation (near the other mutation definitions):

```ts
const saveEccMutation = useMutation({
  mutationFn: (prompt: string) =>
    agentsApi.update(agent.id, {
      adapterConfig: {
        ...(agent.adapterConfig as Record<string, unknown>),
        systemPrompt: prompt,
        promptVersion: (((agent.adapterConfig as Record<string, unknown>)?.promptVersion as number) ?? 0) + 1,
      },
    }, companyId ?? undefined),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    setEccDraft(null);
    onSavingChange(false);
  },
  onError: () => {
    onSavingChange(false);
  },
});

function saveEccPrompt(prompt: string) {
  onSavingChange(true);
  saveEccMutation.mutate(prompt);
}
```

- [ ] **Step 4: Render the ECC textarea UI**

Find the `if (!isLocal)` check (around line 1945):

```ts
if (!isLocal) {
  return (
    <div className="max-w-3xl">
      <p className="text-sm text-muted-foreground">
        Instructions bundles are only available for local adapters.
      </p>
    </div>
  );
}
```

Replace with:

```tsx
if (!isLocal) {
  if (isEcc) {
    return (
      <div className="max-w-3xl space-y-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-semibold">
            System Prompt
          </p>
          <p className="text-xs text-muted-foreground mb-3">
            Saved to agent config. Orchestrator reads this on the next spawn.
          </p>
          <textarea
            className="w-full min-h-[520px] rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
            value={eccCurrentPrompt}
            onChange={(e) => setEccDraft(e.target.value)}
            spellCheck={false}
          />
        </div>
        {eccDirty && (
          <p className="text-xs text-amber-500">
            Unsaved changes — use the Save button above to apply.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-3xl">
      <p className="text-sm text-muted-foreground">
        Instructions bundles are only available for local adapters.
      </p>
    </div>
  );
}
```

- [ ] **Step 5: Verify in browser**

Open http://localhost:3100, navigate to `/founder`, click an ECC agent card. Verify:
- Navigates to `/agents/:id/instructions`
- Instructions tab is active
- Shows editable textarea with the system prompt
- Editing marks the page as dirty (Save button appears)
- Saving updates the agent config

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/AgentDetail.tsx
git commit -m "feat(ui): editable ECC system prompt in AgentDetail PromptsTab"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full typecheck + tests + build**

```bash
pnpm -r typecheck && pnpm test:run && pnpm build
```

Expected: all pass.

- [ ] **Step 2: E2E smoke test**

1. Open http://localhost:3100 → `/founder`
2. Verify "ECC Agents" section above Companies with 2 cards
3. Send a Telegram message to JayJay's bot (or simulate via `POST /api/telegram/webhook`)
4. Watch ECC agent cards briefly show `processing` then return to `idle` with updated last-active time
5. Click "Executive Control Agent" → agent detail page, Instructions tab, editable prompt
6. Edit one word in the prompt, Save → prompt persists on refresh
7. Runs tab on agent → shows `ecc_conversation` runs

- [ ] **Step 3: Commit**

```bash
git add -p  # stage any missed files
git commit -m "chore: final cleanup for ECC agents founder visibility"
```
