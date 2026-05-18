# Entity Search & Operator Working Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fuzzy entity search (pg_trgm) and persistent per-topic working context for the EA operator agent, enabling casual entity references ("Rockdog") and issue/project tracking across Telegram turns without repeated clarification.

**Architecture:** New `entity-search.ts` service implements pg_trgm similarity search across 6 entity types with FK chain resolution. Working context stored in `topics.working_context` JSONB. Three new MCP tools (`search_entities`, `set_working_context`, `switch_context`) added to the existing `handleTool` dispatcher in `mcp-tool-server.ts`. Orchestrator injects stored context at top of every operator prompt. All three tools are operator-only (guarded by `isOperator`).

**Tech Stack:** Drizzle ORM with `sql` template fragments for pg_trgm `%` operator, PostgreSQL pg_trgm extension, Express JSON-RPC, TypeScript strict

---

## File Map

| Action | File |
|--------|------|
| Modify | `packages/db/src/schema/topics.ts` |
| Modify | `packages/db/src/migrations/<next>.sql` (generated then hand-edited) |
| Create | `server/src/services/entity-search.ts` |
| Create | `server/src/__tests__/entity-search.test.ts` |
| Modify | `server/src/services/topics.ts` |
| Modify | `server/src/routes/mcp-tool-server.ts` |
| Modify | `server/src/services/orchestrator.ts` |
| Modify | `server/src/onboarding-assets/ea-operator/AGENTS.md` |

---

### Task 1: DB — topics.working_context column + pg_trgm migration

**Files:**
- Modify: `packages/db/src/schema/topics.ts`
- Modify (generated): `packages/db/src/migrations/<next>.sql`

- [ ] **Step 1: Add workingContext jsonb column to topics schema**

Open `packages/db/src/schema/topics.ts`. Change the import line from:
```typescript
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
```
to:
```typescript
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
```

Add `workingContext` as the last column inside the topics table definition, after `updatedAt`:
```typescript
export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    currentState: text("current_state"),
    companyId: uuid("company_id").references(() => companies.id),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    workingContext: jsonb("working_context"),
  },
  (table) => ({
    statusIdx: index("topics_status_idx").on(table.status),
    companyIdx: index("topics_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 2: Generate migration**

```bash
pnpm db:generate
```

Expected output includes: creates `packages/db/src/migrations/0080_*.sql` (number may vary) containing `ALTER TABLE "topics" ADD COLUMN "working_context" jsonb;`

Note the exact filename generated.

- [ ] **Step 3: Prepend pg_trgm extension + GIN indexes to migration**

Open the newly generated migration file. **Prepend** the following before the existing ALTER TABLE line:

```sql
-- Enable pg_trgm for typo-tolerant fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes for fast trigram similarity on searchable fields
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON "companies" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm ON "clients" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm ON "projects" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON "issues" USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_topics_name_trgm ON "topics" USING GIN (name gin_trgm_ops);

```

The final migration file should look like:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON "companies" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm ON "clients" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm ON "projects" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON "issues" USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_topics_name_trgm ON "topics" USING GIN (name gin_trgm_ops);

ALTER TABLE "topics" ADD COLUMN "working_context" jsonb;
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no new type errors (pre-existing UI errors in Analytics.tsx are unrelated)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/topics.ts packages/db/src/migrations/
git commit -m "feat(db): add topics.working_context jsonb + pg_trgm GIN indexes"
```

---

### Task 2: Entity search service

**Files:**
- Create: `server/src/services/entity-search.ts`
- Create: `server/src/__tests__/entity-search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/entity-search.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { searchEntities, type EntityType } from "../services/entity-search.js";

// Minimal stub — full integration requires seeded DB.
// These tests verify the shape and empty-result contract.
describe("searchEntities", () => {
  it("returns empty array for blank query", async () => {
    // We test with a mock-shaped db that throws on execute
    const fakeDb = {
      select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }) }),
    } as never;
    const results = await searchEntities(fakeDb, "");
    expect(results).toEqual([]);
  });

  it("filters by types parameter", async () => {
    // Ensures type filtering is passed through without throwing
    const fakeDb = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
        }),
      }),
    } as never;
    const results = await searchEntities(fakeDb, "test", ["company"]);
    expect(Array.isArray(results)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm vitest run server/src/__tests__/entity-search.test.ts
```

Expected: FAIL — `entity-search.ts` not found

- [ ] **Step 3: Implement entity-search service**

Create `server/src/services/entity-search.ts`:

```typescript
import { sql, eq, ilike, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, clients, projects, issues, topics, contacts } from "@paperclipai/db";

export type EntityType = "company" | "client" | "project" | "issue" | "topic" | "contact";

export interface EntityResult {
  type: EntityType;
  id: string;
  name: string;
  score: number;
  status?: string;
  company?: { id: string; name: string } | null;
  client?: { id: string; name: string } | null;
  project?: { id: string; name: string } | null;
}

export interface WorkingContextShape {
  companyId?: string | null;
  companyName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  topicId?: string | null;
  topicName?: string | null;
  notes?: string | null;
  updatedAt?: string;
}

const MAX_PER_TYPE = 5;
const SCORE_THRESHOLD = 0.15;

// Attempt pg_trgm query; fall back to ILIKE if extension unavailable (e.g. PGlite dev).
async function withTrgmFallback<T>(
  trgm: () => Promise<T[]>,
  fallback: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await trgm();
  } catch {
    return await fallback();
  }
}

export async function searchEntities(
  db: Db,
  query: string,
  types: EntityType[] = ["company", "client", "project", "issue", "topic", "contact"],
): Promise<EntityResult[]> {
  const q = query.trim();
  if (!q) return [];
  const likeQ = `%${q}%`;
  const results: EntityResult[] = [];

  // ── companies ──────────────────────────────────────────────────────────────
  if (types.includes("company")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: companies.id,
            name: companies.name,
            score: sql<number>`similarity(${companies.name}, ${q})`,
          })
          .from(companies)
          .where(sql`${companies.name} % ${q}`)
          .orderBy(sql`similarity(${companies.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({ id: companies.id, name: companies.name, score: sql<number>`0.5` })
          .from(companies)
          .where(ilike(companies.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({ type: "company", id: r.id, name: r.name, score: r.score });
      }
    }
  }

  // ── clients ────────────────────────────────────────────────────────────────
  if (types.includes("client")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: clients.id,
            name: clients.name,
            companyId: clients.companyId,
            companyName: companies.name,
            score: sql<number>`similarity(${clients.name}, ${q})`,
          })
          .from(clients)
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(sql`${clients.name} % ${q}`)
          .orderBy(sql`similarity(${clients.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: clients.id,
            name: clients.name,
            companyId: clients.companyId,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(clients)
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(ilike(clients.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({
          type: "client",
          id: r.id,
          name: r.name,
          score: r.score,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  // ── projects ───────────────────────────────────────────────────────────────
  if (types.includes("project")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: projects.id,
            name: projects.name,
            clientId: projects.clientId,
            clientName: clients.name,
            companyId: companies.id,
            companyName: companies.name,
            score: sql<number>`similarity(${projects.name}, ${q})`,
          })
          .from(projects)
          .leftJoin(clients, eq(clients.id, projects.clientId))
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(sql`${projects.name} % ${q}`)
          .orderBy(sql`similarity(${projects.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: projects.id,
            name: projects.name,
            clientId: projects.clientId,
            clientName: clients.name,
            companyId: companies.id,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(projects)
          .leftJoin(clients, eq(clients.id, projects.clientId))
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(ilike(projects.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({
          type: "project",
          id: r.id,
          name: r.name,
          score: r.score,
          client: r.clientId ? { id: r.clientId, name: r.clientName ?? "" } : null,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  // ── issues ─────────────────────────────────────────────────────────────────
  if (types.includes("issue")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: issues.id,
            title: issues.title,
            identifier: issues.identifier,
            status: issues.status,
            projectId: issues.projectId,
            projectName: projects.name,
            companyId: issues.companyId,
            companyName: companies.name,
            score: sql<number>`similarity(${issues.title}, ${q})`,
          })
          .from(issues)
          .leftJoin(projects, eq(projects.id, issues.projectId))
          .leftJoin(companies, eq(companies.id, issues.companyId))
          .where(or(sql`${issues.title} % ${q}`, ilike(issues.identifier, `${q}%`)))
          .orderBy(sql`similarity(${issues.title}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: issues.id,
            title: issues.title,
            identifier: issues.identifier,
            status: issues.status,
            projectId: issues.projectId,
            projectName: projects.name,
            companyId: issues.companyId,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(issues)
          .leftJoin(projects, eq(projects.id, issues.projectId))
          .leftJoin(companies, eq(companies.id, issues.companyId))
          .where(or(ilike(issues.title, likeQ), ilike(issues.identifier, `${q}%`)))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD || r.identifier?.toLowerCase().startsWith(q.toLowerCase())) {
        const displayName = r.identifier ? `${r.identifier} — ${r.title}` : r.title;
        results.push({
          type: "issue",
          id: r.id,
          name: displayName,
          score: r.score,
          status: r.status,
          project: r.projectId ? { id: r.projectId, name: r.projectName ?? "" } : null,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  // ── topics ─────────────────────────────────────────────────────────────────
  if (types.includes("topic")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: topics.id,
            name: topics.name,
            status: topics.status,
            score: sql<number>`similarity(${topics.name}, ${q})`,
          })
          .from(topics)
          .where(sql`${topics.name} % ${q}`)
          .orderBy(sql`similarity(${topics.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({ id: topics.id, name: topics.name, status: topics.status, score: sql<number>`0.5` })
          .from(topics)
          .where(ilike(topics.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({ type: "topic", id: r.id, name: r.name, score: r.score, status: r.status });
      }
    }
  }

  // ── contacts ───────────────────────────────────────────────────────────────
  if (types.includes("contact")) {
    const fullName = sql`COALESCE(${contacts.firstName} || ' ' || ${contacts.lastName}, ${contacts.email})`;
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: contacts.id,
            name: fullName,
            companyId: contacts.companyId,
            companyName: companies.name,
            score: sql<number>`similarity(COALESCE(${contacts.firstName} || ' ' || ${contacts.lastName}, ''), ${q})`,
          })
          .from(contacts)
          .leftJoin(companies, eq(companies.id, contacts.companyId))
          .where(or(sql`(${contacts.firstName} || ' ' || ${contacts.lastName}) % ${q}`, ilike(contacts.email, likeQ)))
          .orderBy(sql`similarity(COALESCE(${contacts.firstName} || ' ' || ${contacts.lastName}, ''), ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: contacts.id,
            name: fullName,
            companyId: contacts.companyId,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(contacts)
          .leftJoin(companies, eq(companies.id, contacts.companyId))
          .where(or(ilike(contacts.firstName, likeQ), ilike(contacts.lastName, likeQ), ilike(contacts.email, likeQ)))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({
          type: "contact",
          id: r.id,
          name: String(r.name),
          score: r.score,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function switchContext(
  db: Db,
  query: string,
  topicId: string,
): Promise<{ switched: boolean; context: WorkingContextShape | null; message: string }> {
  const results = await searchEntities(db, query);
  if (results.length === 0) {
    return {
      switched: false,
      context: null,
      message: `No match found for '${query}'. Try search_entities to inspect available entities.`,
    };
  }

  // Pick highest-score result per type
  const byType = new Map<EntityType, EntityResult>();
  for (const r of results) {
    if (!byType.has(r.type)) byType.set(r.type, r);
  }

  const directCompany = byType.get("company");
  const companyFromClient = byType.get("client")?.company;
  const companyFromProject = byType.get("project")?.company;
  const company = directCompany
    ? { id: directCompany.id, name: directCompany.name }
    : companyFromClient ?? companyFromProject ?? null;
  const client = byType.get("client");
  const project = byType.get("project");
  const issue = byType.get("issue");
  const topic = byType.get("topic");

  // Resolve issue title/identifier from display name "DEV-12 — title"
  const issueParts = issue ? issue.name.split(" — ") : [];
  const issueIdentifier = issueParts.length > 1 ? issueParts[0] ?? null : null;
  const issueTitle = issueParts.length > 1 ? issueParts.slice(1).join(" — ") : (issue?.name ?? null);

  const ctx: WorkingContextShape = {
    companyId: company?.id ?? null,
    companyName: company?.name ?? null,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    issueId: issue?.id ?? null,
    issueIdentifier,
    issueTitle,
    topicId: topic?.id ?? null,
    topicName: topic?.name ?? null,
    updatedAt: new Date().toISOString(),
  };

  await db
    .update(topics)
    .set({ workingContext: ctx as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(topics.id, topicId));

  const parts = [
    ctx.companyName,
    ctx.clientName,
    ctx.projectName,
    ctx.issueIdentifier ?? null,
    ctx.topicName ? `topic:${ctx.topicName}` : null,
  ].filter(Boolean);

  return {
    switched: true,
    context: ctx,
    message: `Switched → ${parts.join(" | ")}`,
  };
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run server/src/__tests__/entity-search.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add server/src/services/entity-search.ts server/src/__tests__/entity-search.test.ts
git commit -m "feat(ea): entity search service with pg_trgm + ILIKE fallback and switchContext"
```

---

### Task 3: setWorkingContext on topics service

**Files:**
- Modify: `server/src/services/topics.ts`

- [ ] **Step 1: Add WorkingContextShape import and setWorkingContext method**

Open `server/src/services/topics.ts`. Add import at the top (after existing imports):

```typescript
import type { WorkingContextShape } from "./entity-search.js";
```

Add to `TopicRow` interface — insert `workingContext` field:

```typescript
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
  workingContext: unknown | null;
}
```

Add `workingContext: topics.workingContext,` to the `select` object inside `list()` — add it after `updatedAt`:

```typescript
const q = db
  .select({
    id: topics.id,
    name: topics.name,
    summary: topics.summary,
    currentState: topics.currentState,
    companyId: topics.companyId,
    status: topics.status,
    createdAt: topics.createdAt,
    updatedAt: topics.updatedAt,
    workingContext: topics.workingContext,
    issueCount: sql<number>`count(${topicIssues.id})::int`,
  })
```

Add `setWorkingContext` method inside the factory function, before the `return` statement:

```typescript
  async function setWorkingContext(topicId: string, context: WorkingContextShape): Promise<void> {
    await db
      .update(topics)
      .set({ workingContext: context as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(topics.id, topicId));
  }
```

Add `setWorkingContext` to the return object:

```typescript
  return { list, getById, create, update, remove, linkIssue, unlinkIssue, setWorkingContext };
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add server/src/services/topics.ts
git commit -m "feat(ea): add setWorkingContext to topics service"
```

---

### Task 4: Three new MCP tools — definitions + handlers

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Add entity-search import**

Open `server/src/routes/mcp-tool-server.ts`. After the existing import on line 29 (`import { routineService } ...`), add:

```typescript
import { searchEntities, switchContext as switchContextSvc } from "../services/entity-search.js";
import type { EntityType } from "../services/entity-search.js";
```

- [ ] **Step 2: Add tool definitions**

Find the closing `];` of the `TOOLS` array (currently around line 686). Insert the three new definitions **before** that `];`:

```typescript
  {
    name: "search_entities",
    description: "Fuzzy search across companies, clients, projects, issues, topics, and contacts. Use to resolve partial or casual names to exact IDs before acting. Returns ranked matches with full FK chain (project → client → company). Operator only.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Name to search (partial match, typo-tolerant)" },
        types: {
          type: "array",
          items: { type: "string", enum: ["company", "client", "project", "issue", "topic", "contact"] },
          description: "Entity types to include. Default: all types.",
        },
      },
    },
  },
  {
    name: "set_working_context",
    description: "Persist the current working context (company/client/project/issue/topic) on a topic. Context is automatically injected into your prompt on the next operator message — act directly without re-searching. Pass null to clear a field.",
    inputSchema: {
      type: "object",
      required: ["topicId"],
      properties: {
        topicId: { type: "string", description: "UUID of the EA topic to store context on" },
        companyId: { type: "string" },
        companyName: { type: "string" },
        clientId: { type: "string" },
        clientName: { type: "string" },
        projectId: { type: "string" },
        projectName: { type: "string" },
        issueId: { type: "string" },
        issueIdentifier: { type: "string", description: "e.g. DEV-12" },
        issueTitle: { type: "string" },
        topicName: { type: "string" },
        notes: { type: "string", description: "Free-form notes about current focus" },
      },
    },
  },
  {
    name: "switch_context",
    description: "Atomic: search by query → auto-pick best match per type → persist working context → return confirmation. Use for 'switch to X' or 'now working on Y' commands. Operator only.",
    inputSchema: {
      type: "object",
      required: ["query", "topicId"],
      properties: {
        query: { type: "string", description: "Entity name to switch to (e.g. 'Rockdog', 'Innotrack')" },
        topicId: { type: "string", description: "UUID of the current EA topic to store context on" },
      },
    },
  },
```

- [ ] **Step 3: Add handlers**

Find line 2089 in `mcp-tool-server.ts`:
```typescript
  return `Error: unknown tool "${name}"`;
```

Insert the three handlers **immediately before** that line:

```typescript
  if (name === "search_entities") {
    if (!isOperator) return JSON.stringify({ error: "search_entities is only available to the operator agent" });
    const q = String(args.query ?? "").trim();
    if (!q) return JSON.stringify({ error: "query is required" });
    const types = Array.isArray(args.types) ? (args.types as EntityType[]) : undefined;
    const results = await searchEntities(db, q, types);
    return JSON.stringify(results, null, 2);
  }

  if (name === "set_working_context") {
    if (!isOperator) return JSON.stringify({ error: "set_working_context is only available to the operator agent" });
    const topicId = String(args.topicId ?? "").trim();
    if (!topicId) return JSON.stringify({ error: "topicId is required" });
    const topicSvc = topicsService(db);
    await topicSvc.setWorkingContext(topicId, {
      companyId: args.companyId != null ? String(args.companyId) : null,
      companyName: args.companyName != null ? String(args.companyName) : null,
      clientId: args.clientId != null ? String(args.clientId) : null,
      clientName: args.clientName != null ? String(args.clientName) : null,
      projectId: args.projectId != null ? String(args.projectId) : null,
      projectName: args.projectName != null ? String(args.projectName) : null,
      issueId: args.issueId != null ? String(args.issueId) : null,
      issueIdentifier: args.issueIdentifier != null ? String(args.issueIdentifier) : null,
      issueTitle: args.issueTitle != null ? String(args.issueTitle) : null,
      topicId,
      topicName: args.topicName != null ? String(args.topicName) : null,
      notes: args.notes != null ? String(args.notes) : null,
      updatedAt: new Date().toISOString(),
    });
    return JSON.stringify({ ok: true, topicId });
  }

  if (name === "switch_context") {
    if (!isOperator) return JSON.stringify({ error: "switch_context is only available to the operator agent" });
    const q = String(args.query ?? "").trim();
    const topicId = String(args.topicId ?? "").trim();
    if (!q) return JSON.stringify({ error: "query is required" });
    if (!topicId) return JSON.stringify({ error: "topicId is required" });
    const result = await switchContextSvc(db, q, topicId);
    return JSON.stringify(result, null, 2);
  }

```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no new errors

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add search_entities, set_working_context, switch_context tools"
```

---

### Task 5: Orchestrator — inject working context into operator prompt

**Files:**
- Modify: `server/src/services/orchestrator.ts`

- [ ] **Step 1: Check existing imports**

```bash
grep "isNotNull\|from \"drizzle-orm\"" server/src/services/orchestrator.ts
grep "topics" server/src/services/orchestrator.ts | head -3
```

Note what is already imported. The existing drizzle-orm import is:
```typescript
import { and, desc, eq, gte, notInArray } from "drizzle-orm";
```
And `@paperclipai/db` import currently has: `approvals, companies, issues, operatorMessages, workflowRuns, workflowStageResults`.

- [ ] **Step 2: Add missing imports**

In `server/src/services/orchestrator.ts`:

Change the drizzle-orm import to add `isNotNull`:
```typescript
import { and, desc, eq, gte, isNotNull, notInArray } from "drizzle-orm";
```

Change the `@paperclipai/db` import to add `topics`:
```typescript
import { approvals, companies, issues, operatorMessages, topics, workflowRuns, workflowStageResults } from "@paperclipai/db";
```

- [ ] **Step 3: Add working context injection at start of buildActiveConversationsContext**

Open `server/src/services/orchestrator.ts`. Find `buildActiveConversationsContext` (line 36). After the opening line `const topicSvc = topicsService(db);` (line 37), add:

```typescript
  // Inject working context from the most recently updated active topic that has one set.
  // Agent set this via set_working_context or switch_context on a prior turn.
  let workingContextBlock = "";
  try {
    const [ctxRow] = await db
      .select({ id: topics.id, workingContext: topics.workingContext })
      .from(topics)
      .where(and(eq(topics.status, "active"), isNotNull(topics.workingContext)))
      .orderBy(desc(topics.updatedAt))
      .limit(1);

    if (ctxRow?.workingContext) {
      const ctx = ctxRow.workingContext as import("./entity-search.js").WorkingContextShape;
      const ctxLines: string[] = ["\n## Working Context"];
      if (ctx.companyName) ctxLines.push(`Company:  ${ctx.companyName}${ctx.companyId ? ` (${ctx.companyId})` : ""}`);
      if (ctx.clientName)  ctxLines.push(`Client:   ${ctx.clientName}${ctx.clientId ? ` (${ctx.clientId})` : ""}`);
      if (ctx.projectName) ctxLines.push(`Project:  ${ctx.projectName}${ctx.projectId ? ` (${ctx.projectId})` : ""}`);
      if (ctx.issueTitle)  ctxLines.push(`Issue:    ${ctx.issueIdentifier ? `${ctx.issueIdentifier} — ` : ""}${ctx.issueTitle}${ctx.issueId ? ` (${ctx.issueId})` : ""}`);
      if (ctx.topicName)   ctxLines.push(`Topic:    ${ctx.topicName}${ctx.topicId ? ` (${ctx.topicId})` : ""}`);
      if (ctx.notes)       ctxLines.push(`Notes:    ${ctx.notes}`);
      ctxLines.push(`\nUse these IDs directly. Call search_entities or switch_context only when the operator references something outside this context.`);
      workingContextBlock = ctxLines.join("\n");
    }
  } catch {
    // non-fatal — missing extension or no topics yet
  }
```

Then find `const lines: string[] = [];` (around line 50). On the line immediately after it, add:

```typescript
  if (workingContextBlock) lines.push(workingContextBlock);
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no new errors

- [ ] **Step 5: Commit**

```bash
git add server/src/services/orchestrator.ts
git commit -m "feat(orchestrator): inject working context block at top of operator prompt"
```

---

### Task 6: EA operator instructions — Entity Resolution section

**Files:**
- Modify: `server/src/onboarding-assets/ea-operator/AGENTS.md`

- [ ] **Step 1: Append Entity Resolution section**

Open `server/src/onboarding-assets/ea-operator/AGENTS.md`. At the very end of the file, append:

```markdown

## Entity Resolution

Before creating or modifying any entity, resolve partial names to IDs using these tools:

- `search_entities(query, types?)` — inspect all matches. Use when you need to see options before acting.
- `switch_context(query, topicId)` — atomic: search + auto-pick best match + persist. Use for "switch to X" commands.
- `set_working_context(topicId, {...})` — store resolved IDs after you've confirmed the right entity.

**Pattern for casual entity references:**
1. Operator: "add issue for Rockdog"
2. You: call `search_entities("Rockdog")` → results show client Rockdog (Develtech) + project Rockdog Website
3. You: call `set_working_context(topicId, { companyId, companyName, clientId, clientName, projectId, projectName })`
4. You: create the issue using stored IDs — no re-lookup needed
5. Next operator message: Working Context is pre-injected at top of your prompt — act directly

**Switching focus:**
- Operator: "switch to Innotrack" or "now working on Life" → call `switch_context("Innotrack", topicId)`
- Returns: "Switched → Innotrack | ..." — confirm this to the operator via notify_operator

**Never guess IDs.** If an ID is not in Working Context, call `search_entities` first.
```

- [ ] **Step 2: Commit**

```bash
git add server/src/onboarding-assets/ea-operator/AGENTS.md
git commit -m "docs(ea): add Entity Resolution section to operator agent instructions"
```

---

### Task 7: Apply migration + smoke test

- [ ] **Step 1: Apply migration**

```bash
pnpm db:migrate
```

Expected: migration runs cleanly. If pg_trgm is unavailable in PGlite, `CREATE EXTENSION IF NOT EXISTS pg_trgm` will silently no-op — that is acceptable. GIN indexes may also be skipped silently by PGlite.

- [ ] **Step 2: Run full test suite**

```bash
pnpm test:run
```

Expected: all existing tests pass. The new entity-search tests pass.

- [ ] **Step 3: Typecheck all workspaces**

```bash
pnpm -r typecheck
```

Expected: no new errors (pre-existing UI errors in Analytics.tsx are unrelated to this change)

- [ ] **Step 4: Restart dev server and verify tools appear**

Kill and restart the server:
```bash
pkill -f "tsx.*dev-watch" 2>/dev/null; pnpm dev:server
```

In a separate terminal, verify the three new tools appear in the MCP tools list by checking the server log or using a quick curl with a valid MCP token. If you have a token in `.env` or can grab one from the server startup log:

```bash
# The tools/list method returns all registered tools — grep for the new ones
# (Use an actual operator MCP token — see server logs for how to obtain one)
curl -s -X POST http://localhost:3100/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <operator-mcp-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -o '"search_entities\|set_working_context\|switch_context"'
```

Expected: all three tool names appear.

- [ ] **Step 5: Manual Telegram test**

Send a Telegram message to the EA agent: "search for Develtech"

Expected in response: agent calls `search_entities("Develtech")` and returns a result. The working context block should appear in the next orchestrator prompt log.

- [ ] **Step 6: Final commit tag**

```bash
git tag -a v-entity-search -m "Entity search + working context complete (Phase A)"
```
