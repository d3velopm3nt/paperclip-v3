# Paperclip MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Paperclip DB operations as MCP tools to claude CLI subprocesses so chat agents can read and write issues, projects, agents, and activity in real time.

**Architecture:** An HTTP JSON-RPC endpoint at `/api/mcp` is added to the existing Express server. `chatLeanReply` generates a short-lived JWT, writes an MCP config file pointing to this endpoint with the token as a Bearer header, and passes `--mcp-config` to the claude subprocess. The endpoint validates the token, resolves companyId, and executes the requested tool against the DB. The MCP config is also injected into agent runs (heartbeat) automatically via a built-in entry in the MCP resolver.

**Tech Stack:** Express 5, Drizzle ORM, `jsonwebtoken` (already used in codebase), JSON-RPC 2.0 (no extra SDK needed)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/src/routes/mcp-tool-server.ts` | **CREATE** | JSON-RPC 2.0 endpoint, all tool handlers, auth validation |
| `server/src/services/mcp-session-token.ts` | **CREATE** | Sign / verify short-lived JWT for MCP sessions |
| `server/src/app.ts` | **MODIFY** | Register `/api/mcp` route |
| `server/src/services/chat-direct.ts` | **MODIFY** | Generate MCP config, pass `--mcp-config` to claude subprocess |

---

## Task 1: MCP Session Token Service

**Files:**
- Create: `server/src/services/mcp-session-token.ts`

- [ ] **Step 1: Create token service**

```typescript
// server/src/services/mcp-session-token.ts
import { createHmac, timingSafeEqual } from "node:crypto";

interface McpTokenPayload {
  companyId: string;
  agentId: string | null;
  exp: number; // unix seconds
}

function secret(): string {
  return (
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    "paperclip-mcp-dev-secret"
  );
}

function base64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function signMcpToken(payload: Omit<McpTokenPayload, "exp">, ttlSeconds = 600): string {
  const full: McpTokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(full));
  const sig = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyMcpToken(token: string): McpTokenPayload | null {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const expected = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromBase64url(body)) as McpTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "mcp-session"
```

Expected: no output (no errors for the new file).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/mcp-session-token.ts
git commit -m "feat(mcp): add short-lived HMAC session token for MCP auth"
```

---

## Task 2: MCP Tool Server Endpoint

**Files:**
- Create: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Create the JSON-RPC endpoint with tool definitions**

```typescript
// server/src/routes/mcp-tool-server.ts
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, issues, projects, activityLog } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

    // MCP initialize handshake
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

    // List available tools
    if (method === "tools/list") {
      res.json(ok(id, { tools: TOOLS }));
      return;
    }

    // Execute a tool
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
```

- [ ] **Step 2: Check activityLog import — verify the table name**

```bash
grep -n "activityLog\|activity_log" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/packages/db/src/schema/index.ts | head -5
```

If the export is named differently (e.g. `activityLogs`), update the import in `mcp-tool-server.ts` to match.

- [ ] **Step 3: Typecheck server**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "mcp-tool"
```

Expected: no errors for the new file.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add JSON-RPC tool server endpoint with list/create/update tools"
```

---

## Task 3: Register Route in app.ts

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Import and register the route**

Find the imports block near the top of `server/src/app.ts` (around the other route imports) and add:

```typescript
import { mcpToolServerRoutes } from "./routes/mcp-tool-server.js"; // v3: built-in MCP tool server
```

Then in the `createApp` function, near the other `api.use(...)` calls (around line 193), add:

```typescript
api.use(mcpToolServerRoutes(db)); // v3: built-in MCP tool server for chat agents
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "error" | head -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(mcp): register MCP tool server route at /api/mcp"
```

---

## Task 4: Wire MCP Config into chatLeanReply

**Files:**
- Modify: `server/src/services/chat-direct.ts`

- [ ] **Step 1: Add imports at top of chat-direct.ts**

Add to the existing imports:

```typescript
import { signMcpToken } from "./mcp-session-token.js";
```

- [ ] **Step 2: Locate the args construction in chatLeanReply**

Find this section in `chatLeanReply` (around line 210):

```typescript
const args: string[] = ["--print", "-", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
if (model) args.push("--model", model);
for (const p of workspacePaths) args.push("--add-dir", p);
```

Replace with:

```typescript
const args: string[] = ["--print", "-", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
if (model) args.push("--model", model);
for (const p of workspacePaths) args.push("--add-dir", p);

// Inject built-in Paperclip MCP tool server so agent can query/update company data
const mcpToken = signMcpToken({ companyId, agentId: agent.id });
const apiBase = process.env.PAPERCLIP_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}`;
const mcpConfig = {
  mcpServers: {
    paperclip: {
      type: "http",
      url: `${apiBase}/api/mcp`,
      headers: { Authorization: `Bearer ${mcpToken}` },
    },
  },
};
const mcpConfigPath = `${os.tmpdir()}/paperclip-chat-mcp-${Date.now()}.json`;
await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig), "utf-8");
args.push("--mcp-config", mcpConfigPath);
```

- [ ] **Step 3: Clean up the MCP config file after subprocess exits**

Find the two existing cleanup lines for `tempPromptPath`:

```typescript
if (tempPromptPath) {
  fs.unlink(tempPromptPath).catch(() => {});
}
```

These appear twice (success path and error path). After each one, add:

```typescript
fs.unlink(mcpConfigPath).catch(() => {});
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "error" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/chat-direct.ts
git commit -m "feat(mcp): inject paperclip MCP config into chatLeanReply subprocess"
```

---

## Task 5: Smoke Test

- [ ] **Step 1: Start the server**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm dev:server
```

- [ ] **Step 2: Test the MCP endpoint directly**

Generate a test token and call the endpoint:

```bash
# From a separate terminal — get a token by adding a quick test in the server logs,
# OR use the chat UI to trigger a chatLeanReply and check server logs for the mcpConfigPath.
# Then curl the endpoint:

curl -s -X POST http://localhost:3100/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-from-logs>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

Expected response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "list_issues", ... },
      { "name": "create_issue", ... },
      ...
    ]
  }
}
```

- [ ] **Step 3: Test via chat UI**

1. Open the Chat page in the browser
2. Select an agent or Dispatcher
3. Send: `"What are the current open issues?"`
4. In server logs, look for `chat-lean ▶ spawning claude subprocess` — confirm `--mcp-config` is in the args
5. Claude should call `list_issues` tool and return actual issue data

- [ ] **Step 4: Test write operation**

Send: `"Create a new issue titled 'Test MCP create' with high priority"`

Expected: agent calls `create_issue`, a new issue appears in the Issues page of the UI.

- [ ] **Step 5: Commit test results note and push**

```bash
git add -p  # only if any debug code was added
git commit -m "feat(mcp): paperclip MCP server complete — agents can read/write company data via chat"
```

---

## Self-Review

**Spec coverage:**
- ✅ HTTP JSON-RPC MCP endpoint
- ✅ Auth via short-lived HMAC token
- ✅ `list_issues`, `create_issue`, `update_issue`, `list_agents`, `list_projects`, `get_activity`
- ✅ Wired into `chatLeanReply` via `--mcp-config`
- ✅ Activity logging for write operations
- ✅ companyId scoping on all queries

**Gaps addressed:**
- `activityLog` table name must be verified before use (Task 2, Step 2)
- `PAPERCLIP_API_URL` env var is already set at startup in `index.ts` — safe to use in chat-direct

**Type consistency:** `signMcpToken`/`verifyMcpToken` use the same `McpTokenPayload` type. `handleTool` returns `string` throughout. `ok`/`err` helpers used consistently.
