# Founder Profile View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-company founder dashboard at `/founder` with Overview (all companies' blocked issues + cards), Topics (persistent markdown memory workstreams), and Settings (founder name + personal company badge).

**Architecture:** Two new DB tables (`ecc_topics`, `ecc_topic_issues`) hold topic memory. An Express router at `/api/ecc/topics` handles CRUD with board auth. Four MCP tools expose topics to the ECC agent in Telegram. React pages at `/founder` follow the same `<Layout />` pattern as `/instance/settings` (no company prefix required). The `FounderView` shell holds three tabs via `<Outlet />`; `TopicDetail` renders directly in Layout without the tab bar.

**Tech Stack:** Drizzle ORM + PGlite, Express 5, Zod validation, `packages/shared` validators, React 19, TanStack Query (`useQuery` / `useQueries` / `useMutation`), React Router 7 (`NavLink`, `Outlet`), Tailwind 4, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-05-07-founder-profile-view-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/db/src/schema/ecc_topics.ts` | `eccTopics` + `eccTopicIssues` table definitions |
| Modify | `packages/db/src/schema/index.ts` | Export new tables |
| Modify | `packages/shared/src/validators/instance.ts` | Add `founderProfile` to general settings schema |
| Create | `server/src/services/ecc-topics.ts` | CRUD service for topics |
| Create | `server/src/routes/ecc-topics.ts` | Express router `/api/ecc/topics` |
| Modify | `server/src/app.ts` | Register `eccTopicRoutes` |
| Modify | `server/src/routes/mcp-tool-server.ts` | Add 4 MCP tools |
| Create | `ui/src/api/topics.ts` | Typed fetch wrappers for `/api/ecc/topics` |
| Create | `ui/src/pages/FounderView.tsx` | Tab shell: Overview / Topics / Settings |
| Create | `ui/src/pages/founder/FounderOverview.tsx` | Cross-company dashboard |
| Create | `ui/src/pages/founder/TopicsList.tsx` | Topic list with create/archive |
| Create | `ui/src/pages/founder/TopicDetail.tsx` | Full-page topic editor |
| Create | `ui/src/pages/founder/FounderSettings.tsx` | Founder profile config |
| Modify | `ui/src/App.tsx` | Add `/founder` routes |
| Modify | `ui/src/components/CompanyRail.tsx` | Add founder icon at top |

---

## Task 1: DB Schema — `ecc_topics` + `ecc_topic_issues`

**Files:**
- Create: `packages/db/src/schema/ecc_topics.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

```typescript
// packages/db/src/schema/ecc_topics.ts
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const eccTopics = pgTable(
  "ecc_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    currentState: text("current_state"),
    companyId: uuid("company_id").references(() => companies.id),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("ecc_topics_status_idx").on(table.status),
    companyIdx: index("ecc_topics_company_idx").on(table.companyId),
  }),
);

export const eccTopicIssues = pgTable(
  "ecc_topic_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id").notNull().references(() => eccTopics.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueLink: unique("ecc_topic_issues_unique").on(table.topicId, table.issueId),
  }),
);
```

- [ ] **Step 2: Export from schema index**

Open `packages/db/src/schema/index.ts` and add at the end:

```typescript
export { eccTopics, eccTopicIssues } from "./ecc_topics.js";
```

- [ ] **Step 3: Generate migration**

```bash
cd /path/to/repo && pnpm db:generate
```

Expected: new migration file created in `packages/db/src/migrations/` with `CREATE TABLE ecc_topics` and `CREATE TABLE ecc_topic_issues`.

- [ ] **Step 4: Apply migration**

```bash
pnpm db:migrate
```

Expected: `Migrations applied successfully` (or similar — no error).

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/ecc_topics.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add ecc_topics and ecc_topic_issues tables"
```

---

## Task 2: Instance Settings Schema — `founderProfile` field

The existing `instanceGeneralSettingsSchema` uses `.strict()` which rejects unknown fields. Add `founderProfile` so PATCH calls with founder data are accepted.

**Files:**
- Modify: `packages/shared/src/validators/instance.ts`

- [ ] **Step 1: Update the schema**

Replace the contents of `packages/shared/src/validators/instance.ts` with:

```typescript
import { z } from "zod";

export const founderProfileSchema = z.object({
  name: z.string().default(""),
  personalCompanyId: z.string().uuid().nullable().default(null),
});

export type FounderProfile = z.infer<typeof founderProfileSchema>;

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  founderProfile: founderProfileSchema.optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
```

- [ ] **Step 2: Export `founderProfileSchema` and `FounderProfile` from shared index**

Open `packages/shared/src/index.ts` and find where validators are exported. Add `founderProfileSchema` and `FounderProfile` to the export (they're exported from `./validators/instance.ts` which is re-exported by `./validators/index.ts`). Verify by running:

```bash
grep -n "founderProfileSchema\|FounderProfile" packages/shared/src/validators/index.ts
```

If `validators/index.ts` uses `export * from "./instance.ts"`, no change is needed. Otherwise add the explicit exports.

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/validators/instance.ts
git commit -m "feat(shared): add founderProfile to instance general settings schema"
```

---

## Task 3: ECC Topics Service

**Files:**
- Create: `server/src/services/ecc-topics.ts`

- [ ] **Step 1: Create the service**

```typescript
// server/src/services/ecc-topics.ts
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { eccTopicIssues, eccTopics, issues } from "@paperclipai/db";

export interface TopicRow {
  id: string;
  name: string;
  summary: string;
  currentState: string | null;
  companyId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  issueCount: number;
}

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  companyId: string;
}

export interface TopicWithIssues extends Omit<TopicRow, "issueCount"> {
  issues: LinkedIssue[];
}

export function eccTopicsService(db: Db) {
  async function list(statusFilter?: string): Promise<TopicRow[]> {
    const q = db
      .select({
        id: eccTopics.id,
        name: eccTopics.name,
        summary: eccTopics.summary,
        currentState: eccTopics.currentState,
        companyId: eccTopics.companyId,
        status: eccTopics.status,
        createdAt: eccTopics.createdAt,
        updatedAt: eccTopics.updatedAt,
        issueCount: sql<number>`count(${eccTopicIssues.id})::int`,
      })
      .from(eccTopics)
      .leftJoin(eccTopicIssues, eq(eccTopicIssues.topicId, eccTopics.id))
      .groupBy(eccTopics.id)
      .orderBy(desc(eccTopics.updatedAt));

    if (statusFilter) {
      return q.where(eq(eccTopics.status, statusFilter));
    }
    return q;
  }

  async function getById(id: string): Promise<TopicWithIssues | null> {
    const rows = await db
      .select()
      .from(eccTopics)
      .where(eq(eccTopics.id, id))
      .limit(1);
    const topic = rows[0];
    if (!topic) return null;

    const linkedIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        companyId: issues.companyId,
      })
      .from(eccTopicIssues)
      .innerJoin(issues, eq(issues.id, eccTopicIssues.issueId))
      .where(eq(eccTopicIssues.topicId, id))
      .orderBy(asc(eccTopicIssues.createdAt));

    return { ...topic, issues: linkedIssues };
  }

  async function create(data: { name: string; companyId?: string | null }): Promise<TopicRow> {
    const [row] = await db
      .insert(eccTopics)
      .values({ name: data.name, companyId: data.companyId ?? null })
      .returning();
    return { ...row!, issueCount: 0 };
  }

  async function update(
    id: string,
    data: {
      name?: string;
      summary?: string;
      currentState?: string | null;
      status?: string;
      companyId?: string | null;
    },
  ): Promise<TopicRow | null> {
    const [row] = await db
      .update(eccTopics)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(eccTopics.id, id))
      .returning();
    if (!row) return null;
    return { ...row, issueCount: 0 };
  }

  async function remove(id: string): Promise<boolean> {
    const result = await db
      .delete(eccTopics)
      .where(eq(eccTopics.id, id))
      .returning({ id: eccTopics.id });
    return result.length > 0;
  }

  async function linkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .insert(eccTopicIssues)
      .values({ topicId, issueId })
      .onConflictDoNothing();
  }

  async function unlinkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .delete(eccTopicIssues)
      .where(and(eq(eccTopicIssues.topicId, topicId), eq(eccTopicIssues.issueId, issueId)));
  }

  return { list, getById, create, update, remove, linkIssue, unlinkIssue };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/ecc-topics.ts
git commit -m "feat(server): add eccTopicsService for topic CRUD"
```

---

## Task 4: ECC Topics Route

**Files:**
- Create: `server/src/routes/ecc-topics.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Create the route file**

```typescript
// server/src/routes/ecc-topics.ts
import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { eccTopicsService } from "../services/ecc-topics.js";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";

const createTopicSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().uuid().nullable().optional(),
});

const updateTopicSchema = z.object({
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  currentState: z.string().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
  companyId: z.string().uuid().nullable().optional(),
});

const linkIssueSchema = z.object({
  issueId: z.string().uuid(),
});

function assertBoard(req: Request): void {
  if (req.actor?.type !== "board") throw forbidden("Board access required");
}

export function eccTopicRoutes(db: Db) {
  const router = Router();
  const svc = eccTopicsService(db);

  router.get("/ecc/topics", async (req, res) => {
    assertBoard(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const topics = await svc.list(status);
    res.json(topics);
  });

  router.post("/ecc/topics", validate(createTopicSchema), async (req, res) => {
    assertBoard(req);
    const topic = await svc.create(req.body);
    res.status(201).json(topic);
  });

  router.get("/ecc/topics/:id", async (req, res) => {
    assertBoard(req);
    const topic = await svc.getById(req.params.id);
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.json(topic);
  });

  router.patch("/ecc/topics/:id", validate(updateTopicSchema), async (req, res) => {
    assertBoard(req);
    const topic = await svc.update(req.params.id, req.body);
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.json(topic);
  });

  router.delete("/ecc/topics/:id", async (req, res) => {
    assertBoard(req);
    const ok = await svc.remove(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/ecc/topics/:id/issues", validate(linkIssueSchema), async (req, res) => {
    assertBoard(req);
    await svc.linkIssue(req.params.id, req.body.issueId);
    res.status(201).json({ ok: true });
  });

  router.delete("/ecc/topics/:id/issues/:issueId", async (req, res) => {
    assertBoard(req);
    await svc.unlinkIssue(req.params.id, req.params.issueId);
    res.status(204).send();
  });

  return router;
}
```

- [ ] **Step 2: Register route in `server/src/app.ts`**

Open `server/src/app.ts`. Find the import block for routes (lines ~38–54). Add after the last v3 route import:

```typescript
import { eccTopicRoutes } from "./routes/ecc-topics.js"; // v3: founder topics
```

Then find where routes are registered on the `api` Router (search for `api.use(instanceSettingsRoutes`). Add:

```typescript
api.use(eccTopicRoutes(db));
```

Place it near the other v3 route registrations (e.g., after `api.use(planRoutes(db))`).

- [ ] **Step 3: Verify with curl (start server first)**

```bash
# In one terminal: pnpm dev:server
# In another:
curl -s http://localhost:3100/api/ecc/topics \
  -H "Authorization: Bearer <board-token>" | jq .
```

Expected: `[]` (empty array, no error).

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ecc-topics.ts server/src/app.ts
git commit -m "feat(server): add /api/ecc/topics route (board auth)"
```

---

## Task 5: UI API Client — `topics.ts`

**Files:**
- Create: `ui/src/api/topics.ts`

- [ ] **Step 1: Create the API client**

```typescript
// ui/src/api/topics.ts
import { api } from "./client";

export interface Topic {
  id: string;
  name: string;
  summary: string;
  currentState: string | null;
  companyId: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  issueCount: number;
}

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  companyId: string;
}

export interface TopicWithIssues extends Omit<Topic, "issueCount"> {
  issues: LinkedIssue[];
}

export const topicsApi = {
  list: (status?: string) =>
    api.get<Topic[]>(`/ecc/topics${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  create: (data: { name: string; companyId?: string | null }) =>
    api.post<Topic>("/ecc/topics", data),

  getById: (id: string) =>
    api.get<TopicWithIssues>(`/ecc/topics/${id}`),

  update: (
    id: string,
    data: Partial<Pick<Topic, "name" | "summary" | "currentState" | "status" | "companyId">>,
  ) => api.patch<Topic>(`/ecc/topics/${id}`, data),

  remove: (id: string) =>
    api.delete<void>(`/ecc/topics/${id}`),

  linkIssue: (topicId: string, issueId: string) =>
    api.post<{ ok: boolean }>(`/ecc/topics/${topicId}/issues`, { issueId }),

  unlinkIssue: (topicId: string, issueId: string) =>
    api.delete<void>(`/ecc/topics/${topicId}/issues/${issueId}`),
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/topics.ts
git commit -m "feat(ui): add topics API client"
```

---

## Task 6: MCP Tools — 4 new topic tools

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

The `handleTool` function returns `Promise<string>`. New tools must return `JSON.stringify(...)` or a plain string. Add to the `TOOLS` array AND to the `handleTool` function.

- [ ] **Step 1: Add `eccTopicsService` import**

At the top of `server/src/routes/mcp-tool-server.ts`, after the existing imports, add:

```typescript
import { eccTopicsService } from "../services/ecc-topics.js";
```

- [ ] **Step 2: Add tool definitions to `TOOLS` array**

Find the closing `]` of the `TOOLS` array (just before `async function handleTool`). Add these 4 entries before the closing bracket:

```typescript
  {
    name: "list_topics",
    description: "List all ECC topics (memory boxes). Use to see active workstreams across companies.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: active|archived. Default: active" },
      },
    },
  },
  {
    name: "create_topic",
    description: "Create a new ECC topic (memory box) for tracking a workstream or life domain.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Topic name (e.g. 'SafeX Proposal', 'Finance')" },
        companyId: { type: "string", description: "UUID of the company this topic belongs to. Omit for cross-company topics." },
      },
    },
  },
  {
    name: "update_topic_memory",
    description: "Update a topic's markdown memory content and/or current state summary.",
    inputSchema: {
      type: "object",
      required: ["topicId"],
      properties: {
        topicId: { type: "string", description: "UUID of the topic" },
        summary: { type: "string", description: "Full markdown memory content for the topic" },
        currentState: { type: "string", description: "Short single-line status (e.g. 'Awaiting contract sign-off')" },
      },
    },
  },
  {
    name: "link_issue_to_topic",
    description: "Link an existing issue to an ECC topic so it appears in the topic's context panel.",
    inputSchema: {
      type: "object",
      required: ["topicId", "issueId"],
      properties: {
        topicId: { type: "string", description: "UUID of the topic" },
        issueId: { type: "string", description: "UUID of the issue to link" },
      },
    },
  },
```

- [ ] **Step 3: Add tool handlers to `handleTool`**

Find the line `return \`Error: unknown tool "${name}"\`;` near the end of `handleTool` (just before the closing `}`). Insert these cases immediately before it:

```typescript
  if (name === "list_topics") {
    const svc = eccTopicsService(db);
    const status = typeof args.status === "string" ? args.status : "active";
    const topics = await svc.list(status);
    if (!topics.length) return `No ${status} topics found.`;
    return JSON.stringify(topics, null, 2);
  }

  if (name === "create_topic") {
    const svc = eccTopicsService(db);
    const topic = await svc.create({
      name: String(args.name),
      companyId: typeof args.companyId === "string" ? args.companyId : null,
    });
    return `Topic created: ${JSON.stringify(topic, null, 2)}`;
  }

  if (name === "update_topic_memory") {
    const svc = eccTopicsService(db);
    const updates: { summary?: string; currentState?: string | null } = {};
    if (typeof args.summary === "string") updates.summary = args.summary;
    if (typeof args.currentState === "string") updates.currentState = args.currentState;
    const topic = await svc.update(String(args.topicId), updates);
    if (!topic) return `Error: topic ${args.topicId} not found`;
    return `Topic updated: ${topic.name} — state: ${topic.currentState ?? "none"}`;
  }

  if (name === "link_issue_to_topic") {
    const svc = eccTopicsService(db);
    await svc.linkIssue(String(args.topicId), String(args.issueId));
    return `Issue ${args.issueId} linked to topic ${args.topicId}`;
  }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add list_topics, create_topic, update_topic_memory, link_issue_to_topic tools"
```

---

## Task 7: Router Setup + FounderView Shell

**Files:**
- Modify: `ui/src/App.tsx`
- Create: `ui/src/pages/FounderView.tsx`
- Create: `ui/src/pages/founder/FounderOverview.tsx` (stub)
- Create: `ui/src/pages/founder/TopicsList.tsx` (stub)
- Create: `ui/src/pages/founder/TopicDetail.tsx` (stub)
- Create: `ui/src/pages/founder/FounderSettings.tsx` (stub)

- [ ] **Step 1: Create stub sub-pages** (so imports compile while we build them)

```typescript
// ui/src/pages/founder/FounderOverview.tsx
export function FounderOverview() {
  return <div className="text-muted-foreground text-sm">Overview loading…</div>;
}
```

```typescript
// ui/src/pages/founder/TopicsList.tsx
export function TopicsList() {
  return <div className="text-muted-foreground text-sm">Topics loading…</div>;
}
```

```typescript
// ui/src/pages/founder/TopicDetail.tsx
export function TopicDetail() {
  return <div className="text-muted-foreground text-sm">Topic detail loading…</div>;
}
```

```typescript
// ui/src/pages/founder/FounderSettings.tsx
export function FounderSettings() {
  return <div className="text-muted-foreground text-sm">Settings loading…</div>;
}
```

- [ ] **Step 2: Create `FounderView.tsx` shell**

```typescript
// ui/src/pages/FounderView.tsx
import { useEffect } from "react";
import { NavLink, Outlet } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";

const TAB_CLASS = (isActive: boolean) =>
  cn(
    "px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
    isActive
      ? "border-primary text-foreground font-medium"
      : "border-transparent text-muted-foreground hover:text-foreground",
  );

export function FounderView() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Founder" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 pt-4 pb-0 shrink-0">
        <h1 className="text-xl font-semibold mb-3">Founder Overview</h1>
        <nav className="flex gap-1">
          <NavLink to="/founder" end className={({ isActive }) => TAB_CLASS(isActive)}>
            Overview
          </NavLink>
          <NavLink to="/founder/topics" className={({ isActive }) => TAB_CLASS(isActive)}>
            Topics
          </NavLink>
          <NavLink to="/founder/settings" className={({ isActive }) => TAB_CLASS(isActive)}>
            Settings
          </NavLink>
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <Outlet />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add routes to `ui/src/App.tsx`**

Add imports at the top of App.tsx (after the existing imports, before the `function BootstrapPendingPage` line):

```typescript
import { FounderView } from "./pages/FounderView";
import { FounderOverview } from "./pages/founder/FounderOverview";
import { TopicsList } from "./pages/founder/TopicsList";
import { TopicDetail } from "./pages/founder/TopicDetail";
import { FounderSettings } from "./pages/founder/FounderSettings";
```

Find the line `<Route path="instance/settings" element={<Layout />}>` in the `App()` function (around line 350). Add the founder routes **after** the closing tag of the `instance/settings` block and **before** the `<Route path="companies"` line:

```tsx
          <Route path="founder" element={<Layout />}>
            <Route element={<FounderView />}>
              <Route index element={<FounderOverview />} />
              <Route path="topics" element={<TopicsList />} />
              <Route path="settings" element={<FounderSettings />} />
            </Route>
            <Route path="topics/:topicId" element={<TopicDetail />} />
          </Route>
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors. If you see errors about `useBreadcrumbs`, check the import path — some pages import from `"../context/BreadcrumbContext"` while others may differ; match the pattern in `Channels.tsx`.

- [ ] **Step 5: Quick smoke test**

Start dev server (`pnpm dev`) and open `http://localhost:3100/founder`. You should see the tab bar with "Overview | Topics | Settings" and the stub "loading…" text.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/FounderView.tsx ui/src/pages/founder/ ui/src/App.tsx
git commit -m "feat(ui): add /founder routes and FounderView shell with tab navigation"
```

---

## Task 8: CompanyRail — Founder Icon

**Files:**
- Modify: `ui/src/components/CompanyRail.tsx`

- [ ] **Step 1: Add `LayoutDashboard` to lucide-react import**

Find line 2: `import { Paperclip, Plus } from "lucide-react";`

Change to:

```typescript
import { LayoutDashboard, Paperclip, Plus } from "lucide-react";
```

- [ ] **Step 2: Add `isFounderRoute` detection**

Find line 161: `const isInstanceRoute = location.pathname.startsWith("/instance/");`

Add immediately after it:

```typescript
  const isFounderRoute = location.pathname.startsWith("/founder");
```

- [ ] **Step 3: Update `highlightedCompanyId` to clear when on founder route**

Find the line: `const highlightedCompanyId = isInstanceRoute ? null : selectedCompanyId;`

Change to:

```typescript
  const highlightedCompanyId = (isInstanceRoute || isFounderRoute) ? null : selectedCompanyId;
```

- [ ] **Step 4: Add founder icon above the company list**

Find the `<div className="flex-1 flex flex-col items-center gap-2 py-3 ...">` div (the company list container, around line 277). Add the founder icon and a divider as the FIRST children inside that div, before the `<DndContext>`:

```tsx
        {/* Founder overview icon */}
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              onClick={() => navigate("/founder")}
              className={cn(
                "relative flex items-center justify-center w-11 h-11 transition-[border-radius,background-color,color] duration-150",
                isFounderRoute
                  ? "rounded-[14px] bg-foreground text-background"
                  : "rounded-[22px] hover:rounded-[14px] text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              aria-label="Founder Overview"
            >
              <LayoutDashboard className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>Founder Overview</p>
          </TooltipContent>
        </Tooltip>

        {/* Divider between founder icon and company list */}
        <div className="w-8 h-px bg-border shrink-0" />
```

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Visual check**

Open the app. You should see a `LayoutDashboard` icon at the top of the company rail, above all company icons, separated by a thin divider. Click it — should navigate to `/founder`. The icon should be highlighted (inverted colors) when on `/founder` routes.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/CompanyRail.tsx
git commit -m "feat(ui): add founder icon to CompanyRail (navigates to /founder)"
```

---

## Task 9: FounderOverview Component

**Files:**
- Modify: `ui/src/pages/founder/FounderOverview.tsx` (replace stub)

- [ ] **Step 1: Write the component**

```typescript
// ui/src/pages/founder/FounderOverview.tsx
import { useNavigate } from "@/lib/router";
import { useQueries } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useCompany } from "../../context/CompanyContext";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import type { Issue } from "@paperclipai/shared";

function CompanyCard({
  company,
  issues,
  isLoading,
  isPersonal,
}: {
  company: { id: string; name: string; issuePrefix: string; brandColor?: string | null };
  issues: Issue[] | undefined;
  isLoading: boolean;
  isPersonal: boolean;
}) {
  const navigate = useNavigate();
  const openIssues = issues?.filter((i) => ["backlog", "todo", "in_progress"].includes(i.status)) ?? [];
  const blockedIssues = issues?.filter((i) => i.status === "blocked") ?? [];

  return (
    <button
      onClick={() => navigate(`/${company.issuePrefix}/dashboard`)}
      className="text-left rounded-lg border border-border bg-card p-4 hover:border-foreground/20 transition-colors w-full"
    >
      <div className="flex items-center gap-2 mb-3">
        {company.brandColor && (
          <span
            className="inline-block w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: company.brandColor }}
          />
        )}
        <span className="font-medium text-sm">{company.name}</span>
        {isPersonal && (
          <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">Personal</span>
        )}
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{openIssues.length} open</span>
          {blockedIssues.length > 0 && (
            <span className="text-red-500 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {blockedIssues.length} blocked
            </span>
          )}
        </div>
      )}
    </button>
  );
}

export function FounderOverview() {
  const navigate = useNavigate();
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");

  // Read personalCompanyId from localStorage (set by FounderSettings)
  const personalCompanyId = localStorage.getItem("founder.personalCompanyId");

  const issueQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.issues(company.id),
      queryFn: () => issuesApi.list(company.id),
      staleTime: 30_000,
    })),
  });

  const allIssues = activeCompanies.flatMap((_, i) => issueQueries[i]?.data ?? []);
  const blockedIssues = allIssues.filter((i) => i.status === "blocked");
  const needsAttention = blockedIssues
    .slice(0, 20)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const companyById = new Map(activeCompanies.map((c) => [c.id, c]));

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Company Cards */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Companies
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {activeCompanies.map((company, i) => (
            <CompanyCard
              key={company.id}
              company={company}
              issues={issueQueries[i]?.data}
              isLoading={issueQueries[i]?.isLoading ?? false}
              isPersonal={company.id === personalCompanyId}
            />
          ))}
        </div>
      </section>

      {/* Needs Attention */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Needs Attention
        </h2>
        {needsAttention.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing blocked across your companies.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="text-left px-4 py-2">Company</th>
                  <th className="text-left px-4 py-2">Issue</th>
                  <th className="text-left px-4 py-2">Title</th>
                  <th className="text-left px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {needsAttention.map((issue) => {
                  const company = companyById.get(issue.companyId);
                  return (
                    <tr
                      key={issue.id}
                      className="border-t border-border hover:bg-muted/30 cursor-pointer"
                      onClick={() => navigate(`/${company?.issuePrefix ?? ""}/issues/${issue.id}`)}
                    >
                      <td className="px-4 py-2 text-muted-foreground">{company?.name ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{issue.identifier}</td>
                      <td className="px-4 py-2">{issue.title}</td>
                      <td className="px-4 py-2">
                        <span className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-1.5 py-0.5 rounded">
                          {issue.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

**Note:** `queryKeys.issues(companyId)` — check `ui/src/lib/queryKeys.ts` to confirm the exact key. If it doesn't exist, use `["issues", companyId]` directly. Also check that `Issue` from `@paperclipai/shared` has `updatedAt`, `identifier`, `companyId`, `status` fields — it should, but verify if typecheck fails.

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors. Fix any `queryKeys.issues` shape mismatch by reading `ui/src/lib/queryKeys.ts`.

- [ ] **Step 3: Visual check**

Navigate to `/founder`. The Overview tab should show company cards with issue counts and the needs attention table.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/founder/FounderOverview.tsx
git commit -m "feat(ui): implement FounderOverview with company cards and needs-attention table"
```

---

## Task 10: TopicsList Component

**Files:**
- Modify: `ui/src/pages/founder/TopicsList.tsx` (replace stub)

- [ ] **Step 1: Write the component**

```typescript
// ui/src/pages/founder/TopicsList.tsx
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Archive, RotateCcw } from "lucide-react";
import { topicsApi, type Topic } from "../../api/topics";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../../lib/utils";

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "text-xs px-1.5 py-0.5 rounded",
        status === "active"
          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

export function TopicsList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companies } = useCompany();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCompanyId, setNewCompanyId] = useState<string>("");

  const topicsQuery = useQuery({
    queryKey: ["ecc-topics", showArchived ? "archived" : "active"],
    queryFn: () => topicsApi.list(showArchived ? "archived" : "active"),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      topicsApi.create({ name: newName.trim(), companyId: newCompanyId || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ecc-topics"] });
      setCreating(false);
      setNewName("");
      setNewCompanyId("");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "archived" }) =>
      topicsApi.update(id, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ecc-topics"] });
    },
  });

  const companyById = new Map(companies.map((c) => [c.id, c]));
  const topics = topicsQuery.data ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {showArchived ? "Show active" : "Show archived"}
        </button>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="h-4 w-4 mr-1" />
          New Topic
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border p-4 space-y-3 bg-card">
          <h3 className="text-sm font-medium">New Topic</h3>
          <Input
            placeholder="Topic name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) createMutation.mutate();
              if (e.key === "Escape") { setCreating(false); setNewName(""); }
            }}
            autoFocus
          />
          <select
            value={newCompanyId}
            onChange={(e) => setNewCompanyId(e.target.value)}
            className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
          >
            <option value="">Cross-company</option>
            {companies
              .filter((c) => c.status !== "archived")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => { setCreating(false); setNewName(""); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Create
            </Button>
          </div>
        </div>
      )}

      {topicsQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading topics…</p>
      )}

      {topics.length === 0 && !topicsQuery.isLoading && (
        <p className="text-sm text-muted-foreground">
          {showArchived ? "No archived topics." : "No active topics. Create one to get started."}
        </p>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        {topics.map((topic, i) => {
          const company = topic.companyId ? companyById.get(topic.companyId) : null;
          return (
            <div
              key={topic.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3 hover:bg-muted/30 cursor-pointer",
                i > 0 && "border-t border-border",
              )}
              onClick={() => navigate(`/founder/topics/${topic.id}`)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{topic.name}</span>
                  <StatusBadge status={topic.status} />
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                  <span>{company ? company.name : "Cross-company"}</span>
                  {topic.currentState && <span className="truncate max-w-[200px]">{topic.currentState}</span>}
                  <span>{topic.issueCount} issue{topic.issueCount !== 1 ? "s" : ""}</span>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  archiveMutation.mutate({
                    id: topic.id,
                    status: topic.status === "active" ? "archived" : "active",
                  });
                }}
                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                title={topic.status === "active" ? "Archive" : "Restore"}
              >
                {topic.status === "active" ? (
                  <Archive className="h-4 w-4" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Visual check**

Navigate to `/founder/topics`. The list should render (empty if no topics). Click "New Topic" to create one. Verify the topic appears in the list.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/founder/TopicsList.tsx
git commit -m "feat(ui): implement TopicsList with create and archive actions"
```

---

## Task 11: TopicDetail Component

**Files:**
- Modify: `ui/src/pages/founder/TopicDetail.tsx` (replace stub)

TopicDetail is a full-page layout (not inside FounderView's tab shell — it renders directly in `<Layout />`). Two-column layout: left = markdown memory editor, right = linked issues.

- [ ] **Step 1: Write the component**

```typescript
// ui/src/pages/founder/TopicDetail.tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X, Trash2, Archive } from "lucide-react";
import { topicsApi, type LinkedIssue } from "../../api/topics";
import { issuesApi } from "../../api/issues";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../../lib/utils";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function TopicDetail() {
  const { topicId } = useParams<{ topicId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companies } = useCompany();

  const topicQuery = useQuery({
    queryKey: ["ecc-topic", topicId],
    queryFn: () => topicsApi.getById(topicId!),
    enabled: !!topicId,
  });

  const topic = topicQuery.data;

  // Local editable state
  const [name, setName] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [summary, setSummary] = useState("");
  const [companyId, setCompanyId] = useState<string>("");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState(false);

  // Sync from query data once loaded
  useEffect(() => {
    if (topic) {
      setName(topic.name);
      setCurrentState(topic.currentState ?? "");
      setSummary(topic.summary);
      setCompanyId(topic.companyId ?? "");
    }
  }, [topic]);

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof topicsApi.update>[1]) =>
      topicsApi.update(topicId!, data),
    onSuccess: () => {
      setLastSaved(new Date());
      setSaveError(false);
      queryClient.invalidateQueries({ queryKey: ["ecc-topics"] });
    },
    onError: () => setSaveError(true),
  });

  // Debounced auto-save for summary
  const debouncedSummary = useDebounce(summary, 1000);
  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current) { initialLoad.current = false; return; }
    if (!topicId || debouncedSummary === (topic?.summary ?? "")) return;
    updateMutation.mutate({ summary: debouncedSummary });
  }, [debouncedSummary]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveField = useCallback(
    (data: Parameters<typeof topicsApi.update>[1]) => {
      if (!topicId) return;
      updateMutation.mutate(data);
    },
    [topicId, updateMutation],
  );

  const linkIssueMutation = useMutation({
    mutationFn: (issueId: string) => topicsApi.linkIssue(topicId!, issueId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ecc-topic", topicId] }),
  });

  const unlinkIssueMutation = useMutation({
    mutationFn: (issueId: string) => topicsApi.unlinkIssue(topicId!, issueId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ecc-topic", topicId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => topicsApi.remove(topicId!),
    onSuccess: () => navigate("/founder/topics"),
  });

  // Issue search state
  const [issueSearch, setIssueSearch] = useState("");
  const [searchCompanyId, setSearchCompanyId] = useState(companies[0]?.id ?? "");
  const issueSearchQuery = useQuery({
    queryKey: ["issue-search", searchCompanyId, issueSearch],
    queryFn: () => issuesApi.list(searchCompanyId, { q: issueSearch }),
    enabled: issueSearch.length > 0 && !!searchCompanyId,
    staleTime: 10_000,
  });

  const activeCompanies = companies.filter((c) => c.status !== "archived");
  const companyById = new Map(activeCompanies.map((c) => [c.id, c]));
  const linkedIssueIds = new Set(topic?.issues.map((i) => i.id) ?? []);

  if (topicQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!topic) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Topic not found.</p>
        <Button variant="link" onClick={() => navigate("/founder/topics")}>
          Back to Topics
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <button
          onClick={() => navigate("/founder/topics")}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== topic.name && saveField({ name: name.trim() || topic.name })}
          className="flex-1 text-lg font-semibold bg-transparent border-none outline-none"
        />
        <span className="text-xs text-muted-foreground">
          {saveError ? "Save failed" : lastSaved ? `Saved ${Math.round((Date.now() - lastSaved.getTime()) / 60000)}m ago` : ""}
        </span>
      </div>

      {/* Body — two columns */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left: Memory */}
        <div className="flex-[3] flex flex-col border-r border-border overflow-auto p-6 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current State</label>
            <Input
              value={currentState}
              onChange={(e) => setCurrentState(e.target.value)}
              onBlur={() => saveField({ currentState: currentState || null })}
              placeholder="Single-line status (e.g. Awaiting contract sign-off)"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</label>
            <select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                saveField({ companyId: e.target.value || null });
              }}
              className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
            >
              <option value="">Cross-company</option>
              {activeCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Memory</label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Markdown notes, context, decisions…"
              className="min-h-[300px] resize-none font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">Auto-saves 1s after you stop typing.</p>
          </div>
        </div>

        {/* Right: Context */}
        <div className="flex-[2] flex flex-col overflow-auto p-6 gap-4">
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Linked Issues</h3>
            {topic.issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">No issues linked yet.</p>
            ) : (
              <div className="space-y-1">
                {topic.issues.map((issue: LinkedIssue) => (
                  <div
                    key={issue.id}
                    className="flex items-center gap-2 text-sm rounded-md border border-border px-3 py-2"
                  >
                    <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
                    <span className="flex-1 truncate">{issue.title}</span>
                    <span className="text-xs text-muted-foreground">{companyById.get(issue.companyId)?.name}</span>
                    <button
                      onClick={() => unlinkIssueMutation.mutate(issue.id)}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Link issue search */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Link Issue</label>
            <select
              value={searchCompanyId}
              onChange={(e) => setSearchCompanyId(e.target.value)}
              className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
            >
              {activeCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <Input
              value={issueSearch}
              onChange={(e) => setIssueSearch(e.target.value)}
              placeholder="Search by title…"
            />
            {issueSearchQuery.data && issueSearch && (
              <div className="rounded-md border border-border max-h-48 overflow-auto">
                {issueSearchQuery.data
                  .filter((i) => !linkedIssueIds.has(i.id))
                  .slice(0, 10)
                  .map((issue) => (
                    <button
                      key={issue.id}
                      onClick={() => {
                        linkIssueMutation.mutate(issue.id);
                        setIssueSearch("");
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center gap-2 border-b border-border last:border-0"
                    >
                      <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
                      <span className="truncate">{issue.title}</span>
                    </button>
                  ))}
                {issueSearchQuery.data.filter((i) => !linkedIssueIds.has(i.id)).length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No results.</p>
                )}
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="mt-auto pt-4 border-t border-border space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => saveField({ status: topic.status === "active" ? "archived" : "active" })}
            >
              <Archive className="h-4 w-4 mr-2" />
              {topic.status === "active" ? "Archive topic" : "Restore topic"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm(`Delete topic "${topic.name}"? This cannot be undone.`)) {
                  deleteMutation.mutate();
                }
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete topic
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Note:** The `issuesApi.list` accepts a `q` filter for search. Verify this param is supported by reading `ui/src/api/issues.ts` line ~28 — the `q` param maps to `?q=`. If the server does not support `q` search on the issues endpoint, use the `title` filter instead or search client-side on already-fetched data.

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors. Common issue: `Textarea` import — check the component exists at `@/components/ui/textarea`. If not, use a plain `<textarea>` with Tailwind classes instead.

- [ ] **Step 3: Visual check**

Navigate to a topic row in `/founder/topics` and click it. The full-page editor should open. Test editing the Current State field (should save on blur), editing the Memory textarea (should auto-save after 1 second), and linking an issue via the search panel.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/founder/TopicDetail.tsx
git commit -m "feat(ui): implement TopicDetail with auto-save memory editor and issue linking"
```

---

## Task 12: FounderSettings Component

**Files:**
- Modify: `ui/src/pages/founder/FounderSettings.tsx` (replace stub)

FounderSettings reads/writes `instanceSettings.general.founderProfile` via the existing `/api/instance/settings/general` endpoints. It also writes `personalCompanyId` to `localStorage` so `FounderOverview` can read it immediately without refetching.

- [ ] **Step 1: Write the component**

```typescript
// ui/src/pages/founder/FounderSettings.tsx
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FounderProfile } from "@paperclipai/shared";

interface GeneralSettings {
  founderProfile?: FounderProfile;
  [key: string]: unknown;
}

export function FounderSettings() {
  const queryClient = useQueryClient();
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");

  const settingsQuery = useQuery({
    queryKey: ["instance-settings-general"],
    queryFn: () => api.get<GeneralSettings>("/instance/settings/general"),
    staleTime: 60_000,
  });

  const [name, setName] = useState("");
  const [personalCompanyId, setPersonalCompanyId] = useState<string>("");
  const [saved, setSaved] = useState(false);

  // Sync from loaded settings
  useEffect(() => {
    const profile = settingsQuery.data?.founderProfile;
    if (profile) {
      setName(profile.name ?? "");
      setPersonalCompanyId(profile.personalCompanyId ?? "");
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch<GeneralSettings>("/instance/settings/general", {
        founderProfile: {
          name: name.trim(),
          personalCompanyId: personalCompanyId || null,
        },
      }),
    onSuccess: () => {
      // Cache locally so Overview can read immediately
      localStorage.setItem("founder.personalCompanyId", personalCompanyId || "");
      queryClient.invalidateQueries({ queryKey: ["instance-settings-general"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  if (settingsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading settings…</div>;
  }

  return (
    <div className="max-w-md space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Founder Profile</h2>
        <p className="text-sm text-muted-foreground">
          Configure your identity. The founder name is injected into the ECC agent's system prompt
          so it knows who it's talking to.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Founder name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
          <p className="text-xs text-muted-foreground">
            Used as the header label in Founder Overview and in the ECC agent's context.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Personal company</label>
          <select
            value={personalCompanyId}
            onChange={(e) => setPersonalCompanyId(e.target.value)}
            className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
          >
            <option value="">None selected</option>
            {activeCompanies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            This company gets a "Personal" badge in the Overview. Use it for Finance, Family, Home
            Maintenance, and other personal life topics.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save settings"}
          </Button>
          {saved && (
            <span className="text-sm text-muted-foreground">Saved!</span>
          )}
          {saveMutation.isError && (
            <span className="text-sm text-destructive">Save failed</span>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Note:** `FounderProfile` is imported from `@paperclipai/shared` — this works because we exported it in Task 2. If the typecheck fails with "FounderProfile not exported", check `packages/shared/src/validators/index.ts` exports `* from "./instance.ts"`.

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 3: End-to-end test**

1. Navigate to `/founder/settings`
2. Enter your name and select the personal company
3. Click "Save settings"
4. Navigate to `/founder` (Overview tab)
5. The personal company card should show the "Personal" badge

- [ ] **Step 4: Full verification**

```bash
pnpm -r typecheck && pnpm test:run && pnpm build
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/founder/FounderSettings.tsx
git commit -m "feat(ui): implement FounderSettings for founder name and personal company config"
```

---

## Self-Review Checklist (run after all tasks complete)

Run these in order:

- [ ] `pnpm -r typecheck` — 0 errors
- [ ] `pnpm test:run` — all tests pass
- [ ] `pnpm build` — build succeeds
- [ ] Navigate to `/founder` — Overview tab shows company cards
- [ ] Navigate to `/founder/topics` — Topics tab loads
- [ ] Create a topic, click it, verify TopicDetail opens
- [ ] Edit topic memory, verify auto-save indicator
- [ ] Link an issue to a topic, verify it appears in the list
- [ ] Navigate to `/founder/settings`, save name + personal company
- [ ] Return to `/founder`, verify personal company shows "Personal" badge
- [ ] Click founder icon in CompanyRail — navigates to `/founder`
- [ ] Founder icon is highlighted when on `/founder` routes
- [ ] Switch to a company — founder icon highlight clears
- [ ] Via Telegram: send "list topics" — ECC should respond with topic list
- [ ] Via Telegram: send "update [topic name] topic: [state]" — ECC should call `update_topic_memory`

---

## Spec Coverage Verification

| Spec requirement | Implemented in |
|---|---|
| Founder icon above company list in CompanyRail | Task 8 |
| Routes: `/founder`, `/founder/topics`, `/founder/topics/:id`, `/founder/settings` | Task 7 |
| FounderView tab shell (Overview / Topics / Settings) | Task 7 |
| Company cards row with name, Personal badge, issue counts, blocked count | Task 9 |
| Needs Attention: blocked issues across all companies, max 20 | Task 9 |
| TopicsList: create, list, archive/restore | Task 10 |
| TopicDetail: editable name, current state, company, summary (markdown), auto-save | Task 11 |
| TopicDetail: linked issues, link/unlink via search | Task 11 |
| TopicDetail: archive + delete | Task 11 |
| FounderSettings: founder name + personal company, stored in instanceSettings.general | Task 12 |
| Personal company badge in Overview | Task 9 |
| MCP tools: list_topics, create_topic, update_topic_memory, link_issue_to_topic | Task 6 |
| DB: ecc_topics + ecc_topic_issues with cascade delete | Task 1 |
| API: /api/ecc/topics CRUD + issue link/unlink | Task 4 |
