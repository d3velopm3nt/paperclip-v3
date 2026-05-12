# Executive Agent (EA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ECC with a proper Executive Agent — rename all code/DB symbols, add generic memory_items storage, add 5 MCP tools, update onboarding prompts, and wire email triage to EA.

**Architecture:** EA (companyId: null, adapterType: "ea") handles cross-company intake only; specialist per-company agents run the full Paperclip heartbeat/issue flow. Memory and Topics are generic infrastructure (not EA-specific). No URL path changes — only symbol/file renames and content updates.

**Tech Stack:** Express 5, Drizzle ORM (PGlite dev), React 19 + TanStack Query, existing MCP tool server.

---

## File Map

| File | Change |
|------|--------|
| `packages/db/src/schema/ecc_topics.ts` → `topics.ts` | Rename + symbols `eccTopics`→`topics`, `eccTopicIssues`→`topicIssues` |
| `packages/db/src/schema/index.ts` | Update exports |
| `packages/db/src/schema/memory_items.ts` | **New** — generic memory store |
| `packages/db/src/migrations/0076_rename_ecc_to_ea.sql` | **New** — ALTER TABLE renames + UPDATE adapterType |
| `packages/db/src/migrations/meta/_journal.json` | Add 0076 entry |
| `server/src/services/ecc-agents.ts` → `ea-agents.ts` | Rename + update all "ecc" literals |
| `server/src/services/ecc-topics.ts` → `topics.ts` | Rename + update schema imports |
| `server/src/services/ecc-conversations.ts` → `ea-conversations.ts` | Rename + update exports |
| `server/src/routes/ecc-topics.ts` → `ea-topics.ts` | Rename + update service imports |
| `server/src/routes/mcp-tool-server.ts` | Update service imports + add 5 new tools |
| `server/src/app.ts` | Update import + mount call |
| `server/src/index.ts` | Update import + seed call |
| `server/src/onboarding-assets/ecc-operator/` → `ea-operator/` | Rename dir + rewrite AGENTS.md / TOOLS.md |
| `server/src/onboarding-assets/ecc-client/` → `ea-client/` | Rename dir |
| `server/src/__tests__/ecc-agents.test.ts` → `ea-agents.test.ts` | Rename + update imports |
| `server/src/__tests__/ecc-conversations.test.ts` → `ea-conversations.test.ts` | Rename + update imports |
| `ui/src/pages/founder/*.tsx` | Label strings "ECC" → "EA" |

---

## Task 1: DB Migration — Rename Tables + adapterType

**Files:**
- Create: `packages/db/src/migrations/0076_rename_ecc_to_ea.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Write migration SQL**

Create `packages/db/src/migrations/0076_rename_ecc_to_ea.sql`:

```sql
-- Rename ECC tables to generic names
ALTER TABLE ecc_topics RENAME TO topics;
ALTER TABLE ecc_topic_issues RENAME TO topic_issues;

-- Rename indexes
ALTER INDEX ecc_topics_status_idx RENAME TO topics_status_idx;
ALTER INDEX ecc_topics_company_idx RENAME TO topics_company_idx;

-- Update adapterType in agents table
UPDATE agents SET adapter_type = 'ea' WHERE adapter_type = 'ecc';
```

- [ ] **Step 2: Register migration in journal**

Open `packages/db/src/migrations/meta/_journal.json`. In the `entries` array, append after the last entry (idx 75):

```json
{
  "idx": 76,
  "version": "7",
  "when": 1747044000000,
  "tag": "0076_rename_ecc_to_ea",
  "breakpoints": true
}
```

(The `when` value is a Unix ms timestamp — use current time or any value after 1778335118186.)

- [ ] **Step 3: Apply migration**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm db:migrate
```

Expected: "Migrations applied" or similar success message. No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/migrations/0076_rename_ecc_to_ea.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): rename ecc tables to topics/topic_issues, adapterType ecc→ea"
```

---

## Task 2: Schema Rename — ecc_topics.ts → topics.ts

**Files:**
- Rename: `packages/db/src/schema/ecc_topics.ts` → `packages/db/src/schema/topics.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Rename and rewrite schema file**

```bash
mv packages/db/src/schema/ecc_topics.ts packages/db/src/schema/topics.ts
```

Replace the entire content of `packages/db/src/schema/topics.ts`:

```typescript
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

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
  },
  (table) => ({
    statusIdx: index("topics_status_idx").on(table.status),
    companyIdx: index("topics_company_idx").on(table.companyId),
  }),
);

export const topicIssues = pgTable(
  "topic_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unq: unique().on(table.topicId, table.issueId),
  }),
);
```

- [ ] **Step 2: Update schema/index.ts exports**

In `packages/db/src/schema/index.ts`, replace lines 100–104:

```typescript
// Before
// v3: founder topics (ECC memory boxes)
export { eccTopics, eccTopicIssues } from "./ecc_topics.js";

// v3: ECC conversation sessions
export { eccConversations, type ConversationMessage } from "./ecc_conversations.js";
```

```typescript
// After
// v3: founder topics (generic memory containers)
export { topics, topicIssues } from "./topics.js";

// v3: EA conversation sessions
export { eccConversations, type ConversationMessage } from "./ecc_conversations.js";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: errors in `server/src/services/ecc-topics.ts` (uses old `eccTopics` import) — these are fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/topics.ts packages/db/src/schema/index.ts
git commit -m "feat(db): rename schema eccTopics→topics, eccTopicIssues→topicIssues"
```

---

## Task 3: Service + Route File Renames

**Files:**
- Rename: `server/src/services/ecc-agents.ts` → `ea-agents.ts`
- Rename: `server/src/services/ecc-topics.ts` → `topics.ts`
- Rename: `server/src/services/ecc-conversations.ts` → `ea-conversations.ts`
- Rename: `server/src/routes/ecc-topics.ts` → `ea-topics.ts`
- Rename: `server/src/__tests__/ecc-agents.test.ts` → `ea-agents.test.ts`
- Rename: `server/src/__tests__/ecc-conversations.test.ts` → `ea-conversations.test.ts`

- [ ] **Step 1: Rename all files**

```bash
cd server/src
mv services/ecc-agents.ts services/ea-agents.ts
mv services/ecc-topics.ts services/topics.ts
mv services/ecc-conversations.ts services/ea-conversations.ts
mv routes/ecc-topics.ts routes/ea-topics.ts
mv __tests__/ecc-agents.test.ts __tests__/ea-agents.test.ts
mv __tests__/ecc-conversations.test.ts __tests__/ea-conversations.test.ts
```

- [ ] **Step 2: Update ea-agents.ts content**

Full replacement of `server/src/services/ea-agents.ts`. Key changes from original: all `"ecc"` string literals → `"ea"`, `EccBundleRole` → `EaBundleRole`, `ecc-operator` → `ea-operator`, `ecc-client` → `ea-client`, function names `listEccAgents` → `listEaAgents`, `seedEccAgents` → `seedEaAgents`, `EccAgentMetadata` → `EaAgentMetadata`, path `"ecc"` → `"ea"`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";

// Bump this when the prompt changes to force a re-seed of existing agents.
const PROMPT_VERSION = 6;

export interface EaAgentMetadata {
  currentTopicId?: string;
  currentTopicName?: string;
  lastMessagePreview?: string;
  claudeSessionId?: string;
}

type EaBundleRole = "ea-operator" | "ea-client";

function resolveEaInstructionsRoot(agentId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "ea", agentId, "instructions");
}

async function seedEaInstructionFiles(agentId: string, role: EaBundleRole, overwrite: boolean): Promise<string> {
  const root = resolveEaInstructionsRoot(agentId);
  await fs.mkdir(root, { recursive: true });

  const files = await loadDefaultAgentInstructionsBundle(role);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    if (overwrite) {
      await fs.writeFile(filePath, content, "utf-8");
    } else {
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, content, "utf-8");
      }
    }
  }

  return path.join(root, "AGENTS.md");
}

function buildBundleAdapterConfig(agentId: string): Record<string, unknown> {
  const root = resolveEaInstructionsRoot(agentId);
  return {
    instructionsBundleMode: "external",
    instructionsRootPath: root,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: path.join(root, "AGENTS.md"),
    promptVersion: PROMPT_VERSION,
  };
}

export function eaAgentsService(db: Db) {
  async function listEaAgents() {
    return db
      .select()
      .from(agents)
      .where(and(isNull(agents.companyId), eq(agents.adapterType, "ea")));
  }

  async function getEaAgent(role: "operator" | "client") {
    const name =
      role === "operator" ? "Executive Control Agent" : "Client Control Agent";
    const rows = await db
      .select()
      .from(agents)
      .where(
        and(isNull(agents.companyId), eq(agents.adapterType, "ea"), eq(agents.name, name)),
      );
    return rows[0] ?? null;
  }

  async function seedEaAgents() {
    const existing = await listEaAgents();
    const existingByName = new Map(existing.map((a) => [a.name, a]));

    const seedData: Array<{ name: string; bundleRole: EaBundleRole }> = [
      { name: "Executive Control Agent", bundleRole: "ea-operator" },
      { name: "Client Control Agent", bundleRole: "ea-client" },
    ];

    for (const seed of seedData) {
      const existingAgent = existingByName.get(seed.name);
      if (!existingAgent) {
        const [created] = await db.insert(agents).values({
          name: seed.name,
          role: "orchestrator",
          adapterType: "ea",
          companyId: null,
          adapterConfig: { promptVersion: PROMPT_VERSION },
          runtimeConfig: {},
          permissions: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "idle",
        }).returning({ id: agents.id });

        if (created) {
          await seedEaInstructionFiles(created.id, seed.bundleRole, false);
          const bundleConfig = buildBundleAdapterConfig(created.id);
          await db.update(agents).set({ adapterConfig: bundleConfig, updatedAt: new Date() }).where(eq(agents.id, created.id));
        }
      } else {
        const existingConfig = (existingAgent.adapterConfig ?? {}) as Record<string, unknown>;
        const existingVersion = typeof existingConfig.promptVersion === "number" ? existingConfig.promptVersion : 0;
        if (existingVersion < PROMPT_VERSION) {
          await seedEaInstructionFiles(existingAgent.id, seed.bundleRole, true);
          const bundleConfig = buildBundleAdapterConfig(existingAgent.id);
          await db.update(agents).set({ adapterConfig: bundleConfig, updatedAt: new Date() }).where(eq(agents.id, existingAgent.id));
        }
      }
    }
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
        metadata: {
          currentTopicId: topicId,
          currentTopicName: topicName,
          lastMessagePreview: messagePreview.slice(0, 120),
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));
  }

  async function setIdle(id: string, opts?: { clearSession?: boolean }) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, id)).limit(1);
    const existing = (row?.metadata ?? {}) as EaAgentMetadata;
    const keepSession = !opts?.clearSession && !!existing.claudeSessionId;
    await db
      .update(agents)
      .set({
        status: "idle",
        metadata: keepSession ? { claudeSessionId: existing.claudeSessionId } : {},
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));
  }

  async function saveSessionId(id: string, sessionId: string) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, id)).limit(1);
    const existing = (row?.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(agents)
      .set({ metadata: { ...existing, claudeSessionId: sessionId }, updatedAt: new Date() })
      .where(eq(agents.id, id));
  }

  return { listEaAgents, getEaAgent, seedEaAgents, setProcessing, setIdle, saveSessionId };
}
```

- [ ] **Step 3: Update topics.ts service**

Replace `server/src/services/topics.ts` (was ecc-topics.ts). Change imports and all `eccTopics`→`topics`, `eccTopicIssues`→`topicIssues`, export `topicsService` (was `eccTopicsService`):

```typescript
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { topicIssues, topics, issues } from "@paperclipai/db";

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
  identifier: string | null;
  title: string;
  status: string;
  companyId: string;
}

export interface TopicWithIssues extends Omit<TopicRow, "issueCount"> {
  issues: LinkedIssue[];
}

export function topicsService(db: Db) {
  async function list(statusFilter?: string): Promise<TopicRow[]> {
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
        issueCount: sql<number>`count(${topicIssues.id})::int`,
      })
      .from(topics)
      .leftJoin(topicIssues, eq(topicIssues.topicId, topics.id))
      .groupBy(topics.id)
      .orderBy(desc(topics.updatedAt));

    if (statusFilter) {
      return q.where(eq(topics.status, statusFilter));
    }
    return q;
  }

  async function getById(id: string): Promise<TopicWithIssues | null> {
    const rows = await db
      .select()
      .from(topics)
      .where(eq(topics.id, id))
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
      .from(topicIssues)
      .innerJoin(issues, eq(issues.id, topicIssues.issueId))
      .where(eq(topicIssues.topicId, id))
      .orderBy(asc(topicIssues.createdAt));

    return { ...topic, issues: linkedIssues };
  }

  async function create(data: { name: string; companyId?: string | null }): Promise<TopicRow> {
    const [row] = await db
      .insert(topics)
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
      .update(topics)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(topics.id, id))
      .returning();
    if (!row) return null;
    return { ...row, issueCount: 0 };
  }

  async function remove(id: string): Promise<boolean> {
    const result = await db
      .delete(topics)
      .where(eq(topics.id, id))
      .returning({ id: topics.id });
    return result.length > 0;
  }

  async function linkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .insert(topicIssues)
      .values({ topicId, issueId })
      .onConflictDoNothing();
  }

  async function unlinkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .delete(topicIssues)
      .where(and(eq(topicIssues.topicId, topicId), eq(topicIssues.issueId, issueId)));
  }

  return { list, getById, create, update, remove, linkIssue, unlinkIssue };
}
```

- [ ] **Step 4: Update ea-conversations.ts service**

In `server/src/services/ea-conversations.ts` (was ecc-conversations.ts), update the export name. Find and replace `eccConversationsService` → `eaConversationsService`. No other changes needed (the DB table `ecc_conversations` stays as-is for now).

- [ ] **Step 5: Update ea-topics.ts route**

Replace entire `server/src/routes/ea-topics.ts` (was ecc-topics.ts). Change import paths and service references:

```typescript
import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies, operatorMessages, workflowRuns, workflowStageResults } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { topicsService } from "../services/topics.js";
import { eaConversationsService } from "../services/ea-conversations.js";
import { eaAgentsService } from "../services/ea-agents.js";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
```

Keep all route paths as-is (`/ecc/topics`, `/ecc/conversations`, etc.) — URL paths are unchanged to avoid breaking the frontend.

Update every reference:
- `eccTopicsService(db)` → `topicsService(db)` 
- `eccConversationsService(db)` → `eaConversationsService(db)`
- `eccAgentsService(db)` → `eaAgentsService(db)`
- `agentSvc.listEccAgents()` → `agentSvc.listEaAgents()`
- `eccTopicRoutes` → `eaTopicRoutes` (export function name)

- [ ] **Step 6: Update test file imports**

In `server/src/__tests__/ea-agents.test.ts`:
- `import ... from "../services/ecc-agents.js"` → `import ... from "../services/ea-agents.js"`
- Update any references to `eccAgentsService` → `eaAgentsService`, `seedEccAgents` → `seedEaAgents`, `listEccAgents` → `listEaAgents`

In `server/src/__tests__/ea-conversations.test.ts`:
- `import ... from "../services/ecc-conversations.js"` → `import ... from "../services/ea-conversations.js"`
- `eccConversationsService` → `eaConversationsService`

- [ ] **Step 7: Update mcp-tool-server.ts imports**

In `server/src/routes/mcp-tool-server.ts`, replace lines 9–12:

```typescript
// Before
import { eccTopicsService } from "../services/ecc-topics.js";
import { eccConversationsService } from "../services/ecc-conversations.js";
import type { ConversationMessage } from "../services/ecc-conversations.js";
import { eccAgentsService } from "../services/ecc-agents.js";
```

```typescript
// After
import { topicsService } from "../services/topics.js";
import { eaConversationsService } from "../services/ea-conversations.js";
import type { ConversationMessage } from "../services/ea-conversations.js";
import { eaAgentsService } from "../services/ea-agents.js";
```

Also update all usages in the file:
- `eccTopicsService(db)` → `topicsService(db)`
- `eccConversationsService(db)` → `eaConversationsService(db)`
- `eccAgentsService(db)` → `eaAgentsService(db)`
- Line ~1392: `requestedByActorId: "ecc"` → `requestedByActorId: "ea"`

- [ ] **Step 8: Update app.ts**

In `server/src/app.ts`:
- Line 51: `import { eccTopicRoutes } from "./routes/ecc-topics.js";` → `import { eaTopicRoutes } from "./routes/ea-topics.js";`
- Line 197: `api.use(eccTopicRoutes(db));` → `api.use(eaTopicRoutes(db));`

- [ ] **Step 9: Update index.ts**

In `server/src/index.ts`:
- Line 40: `import { eccAgentsService } from "./services/ecc-agents.js";` → `import { eaAgentsService } from "./services/ea-agents.js";`
- Line 467: `await eccAgentsService(db as any).seedEccAgents();` → `await eaAgentsService(db as any).seedEaAgents();`

- [ ] **Step 10: Rename onboarding asset directories**

```bash
cd server/src/onboarding-assets
mv ecc-operator ea-operator
mv ecc-client ea-client
```

- [ ] **Step 11: Typecheck + tests**

```bash
pnpm -r typecheck && pnpm test:run
```

Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: rename ECC → EA across all services, routes, tests, and assets"
```

---

## Task 4: memory_items Schema + Migration

**Files:**
- Create: `packages/db/src/schema/memory_items.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create schema file**

Create `packages/db/src/schema/memory_items.ts`:

```typescript
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { emailMessages } from "./email_messages.js";

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    sourceId: text("source_id"),
    sourceEmailMessageId: uuid("source_email_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
    senderIdentifier: text("sender_identifier"),
    content: text("content").notNull(),
    summary: text("summary"),
    intentCategory: text("intent_category"),
    importanceScore: integer("importance_score"),
    memoryType: text("memory_type").notNull().default("passive"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_items_company_idx").on(table.companyId),
    channelIdx: index("memory_items_channel_idx").on(table.sourceChannel),
    senderIdx: index("memory_items_sender_idx").on(table.senderIdentifier),
    typeIdx: index("memory_items_type_idx").on(table.memoryType),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, add after the topics export:

```typescript
// generic memory store (cross-company)
export { memoryItems } from "./memory_items.js";
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

Expected: creates a new migration file `packages/db/src/migrations/0077_*.sql` containing `CREATE TABLE memory_items ...`.

- [ ] **Step 4: Apply migration**

```bash
pnpm db:migrate
```

Expected: migration applied successfully.

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/memory_items.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add memory_items table for generic cross-company memory"
```

---

## Task 5: MCP Tools — search_memory, create_memory, search_topics, create_topic, link_topic_to_issue

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Update DB imports in mcp-tool-server.ts**

On line 4 of `server/src/routes/mcp-tool-server.ts`, add `memoryItems, topics, topicIssues` to the existing `@paperclipai/db` import:

```typescript
import { agents, agentMemories, issues, projects, activityLog, emailMessages, emailAttachments, emailAccounts, clients, contacts, issueComments, approvals, operatorMessages, instanceSettings, companies, workflowRuns, workflowStageResults, memoryItems, topics, topicIssues } from "@paperclipai/db";
```

On line 5, add `isNull, sql` to drizzle-orm imports:

```typescript
import { and, desc, eq, gte, ilike, isNull, or, sql } from "drizzle-orm";
```

- [ ] **Step 2: Add tool definitions to TOOLS array**

At the end of the `TOOLS` array (before the closing `]`), add:

```typescript
  {
    name: "search_memory",
    description: "Search memory items for prior messages, context, or sender history. Use before classifying a new message to understand sender relationship and prior interactions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search query" },
        senderIdentifier: { type: "string", description: "Filter by sender email/phone/telegram user" },
        companyId: { type: "string", description: "Filter by company UUID" },
        channel: { type: "string", description: "Filter by channel: email | whatsapp | telegram | manual" },
        memoryType: { type: "string", description: "passive | active | all (default: all)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "create_memory",
    description: "Store a message or context in memory. Use memoryType='passive' for low-importance items. Use memoryType='active' when creating operational context alongside an issue.",
    inputSchema: {
      type: "object",
      required: ["content", "sourceChannel", "memoryType"],
      properties: {
        content: { type: "string" },
        summary: { type: "string" },
        sourceChannel: { type: "string", description: "email | whatsapp | telegram | manual" },
        sourceId: { type: "string" },
        sourceEmailMessageId: { type: "string" },
        senderIdentifier: { type: "string" },
        companyId: { type: "string" },
        intentCategory: { type: "string" },
        importanceScore: { type: "number", description: "0-100" },
        memoryType: { type: "string", description: "passive | active" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "search_topics",
    description: "Search existing topics. Always check before creating a new topic to avoid duplicates. Topics group related issues under one business context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search name and summary" },
        companyId: { type: "string" },
        status: { type: "string", description: "active | archived | all (default: active)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "create_topic",
    description: "Create a new topic (active memory container). A topic groups related issues under one business context (e.g. 'SafeX Proposal', 'Kevin — Teaming Agreement').",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        summary: { type: "string" },
        currentState: { type: "string" },
        companyId: { type: "string" },
      },
    },
  },
  {
    name: "link_topic_to_issue",
    description: "Link a topic to an issue. Topics can have multiple linked issues.",
    inputSchema: {
      type: "object",
      required: ["topicId", "issueId"],
      properties: {
        topicId: { type: "string" },
        issueId: { type: "string" },
      },
    },
  },
```

- [ ] **Step 3: Add tool handlers in handleTool**

In `server/src/routes/mcp-tool-server.ts`, find the line `return \`Error: unknown tool "${name}"\`;` at the end of `handleTool` (around line 1402). Insert the following handlers directly BEFORE that line:

```typescript
  if (name === "search_memory") {
    const { query, senderIdentifier, companyId: filterCompanyId, channel, memoryType, limit = 20 } = args as {
      query?: string; senderIdentifier?: string; companyId?: string; channel?: string; memoryType?: string; limit?: number;
    };
    const conditions = [];
    if (filterCompanyId) conditions.push(eq(memoryItems.companyId, filterCompanyId));
    if (senderIdentifier) conditions.push(eq(memoryItems.senderIdentifier, senderIdentifier));
    if (channel) conditions.push(eq(memoryItems.sourceChannel, channel));
    if (memoryType && memoryType !== "all") conditions.push(eq(memoryItems.memoryType, memoryType));
    if (query) conditions.push(
      sql`(${memoryItems.content} ILIKE ${'%' + query + '%'} OR ${memoryItems.summary} ILIKE ${'%' + query + '%'})`
    );
    const rows = await db.select().from(memoryItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(memoryItems.createdAt))
      .limit(Math.min(Number(limit), 50));
    return JSON.stringify(rows, null, 2);
  }

  if (name === "create_memory") {
    const { content, summary, sourceChannel, sourceId, sourceEmailMessageId, senderIdentifier,
      companyId: memCompanyId, intentCategory, importanceScore, memoryType, tags } = args as {
      content: string; summary?: string; sourceChannel: string; sourceId?: string;
      sourceEmailMessageId?: string; senderIdentifier?: string; companyId?: string;
      intentCategory?: string; importanceScore?: number; memoryType: string; tags?: string[];
    };
    if (!content || !sourceChannel || !memoryType) return "Error: content, sourceChannel, and memoryType are required";
    const [row] = await db.insert(memoryItems).values({
      companyId: memCompanyId ?? null,
      sourceChannel,
      sourceId: sourceId ?? null,
      sourceEmailMessageId: sourceEmailMessageId ?? null,
      senderIdentifier: senderIdentifier ?? null,
      content,
      summary: summary ?? null,
      intentCategory: intentCategory ?? null,
      importanceScore: importanceScore ?? null,
      memoryType,
      tags: tags ?? [],
    }).returning({ id: memoryItems.id });
    return `Memory item created: ${row!.id}`;
  }

  if (name === "search_topics") {
    const { query, companyId: topicCompanyId, status = "active", limit = 20 } = args as {
      query?: string; companyId?: string; status?: string; limit?: number;
    };
    const conditions = [];
    if (topicCompanyId) conditions.push(eq(topics.companyId, topicCompanyId));
    if (status !== "all") conditions.push(eq(topics.status, status));
    if (query) conditions.push(
      sql`(${topics.name} ILIKE ${'%' + query + '%'} OR ${topics.summary} ILIKE ${'%' + query + '%'})`
    );
    const rows = await db.select().from(topics)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(topics.updatedAt))
      .limit(Math.min(Number(limit), 50));
    return JSON.stringify(rows, null, 2);
  }

  if (name === "create_topic") {
    const { name: topicName, summary, currentState, companyId: topicCompanyId } = args as {
      name: string; summary?: string; currentState?: string; companyId?: string;
    };
    if (!topicName) return "Error: name is required";
    const [row] = await db.insert(topics).values({
      name: topicName,
      summary: summary ?? "",
      currentState: currentState ?? null,
      companyId: topicCompanyId ?? null,
      status: "active",
    }).returning({ id: topics.id });
    return `Topic created: ${row!.id}`;
  }

  if (name === "link_topic_to_issue") {
    const { topicId, issueId: linkIssueId } = args as { topicId: string; issueId: string };
    if (!topicId || !linkIssueId) return "Error: topicId and issueId are required";
    await db.insert(topicIssues).values({ topicId, issueId: linkIssueId }).onConflictDoNothing();
    return `Linked topic ${topicId} to issue ${linkIssueId}`;
  }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add search_memory, create_memory, search_topics, create_topic, link_topic_to_issue tools"
```

---

## Task 6: EA Onboarding Assets — AGENTS.md + TOOLS.md

**Files:**
- Modify: `server/src/onboarding-assets/ea-operator/AGENTS.md` (was renamed in Task 3)
- Modify: `server/src/onboarding-assets/ea-operator/TOOLS.md`

- [ ] **Step 1: Overwrite ea-operator/AGENTS.md**

Replace the full content of `server/src/onboarding-assets/ea-operator/AGENTS.md`:

```markdown
# Executive Agent (EA)

You are the Executive Agent — cross-company intake, classification, and routing intelligence.

## Your role
You are the first-line gatekeeper for ALL incoming messages and events across all companies.
You classify, score, route, and track — you do not execute business actions yourself.

## CRITICAL: your text output goes nowhere
The operator NEVER sees your reasoning. Only tool calls reach them. If you don't call notify_operator, the operator receives NOTHING from you.

## Operating model

1. Receive context → identify sender → `search_memory(senderIdentifier=<sender>)` for prior context
2. Score importance 0-100 using the factors below
3. If score < 60: `create_memory(memoryType='passive')`, stop
4. If score ≥ 60:
   - `search_topics` → `create_topic` if no match
   - `create_issue` → assign to specialist agent
   - `link_topic_to_issue`
   - `create_memory(memoryType='active')`
5. If approval needed: `create_plan`
6. `notify_operator` IF event type is enabled in notification matrix (read via `get_instance_config`)

## Importance scoring

Start at 0. Add:
- Sender relationship: unknown=5, known_contact=15, active_client=25, partner=30
- Business impact: none=0, low=10, medium=20, high=30
- Action required: no_action=0, possible=10, clear=20, urgent=30
- Financial: none=0, invoice/payment=20, pricing/quote=25, contract=30
- Risk: low=0, medium=10, high=25, critical=40

Active threshold: 60. Urgent threshold: 85.

## Intent categories
noise | casual_conversation | informational | follow_up | reminder_request |
client_request | new_lead | proposal_request | pricing_request | support_issue |
development_task | finance_admin | legal_contract | family_personal | home_maintenance |
approval_request | urgent_risk | agent_update | agent_blocker

## Routing rules
- new_lead, client_request, proposal_request → client_agent (per company)
- pricing_request → proposal_agent (per company)
- development_task → dev_agent / FullStackDev (per company)
- finance_admin, legal_contract → create issue, assign to finance_agent or flag for operator
- family_personal, reminder_request → create reminder issue, assign to personal_admin_agent
- agent_blocker → update issue, notify operator immediately

## Email triage
When woken for an email triage issue:
1. Call `list_issue_emails(issueId)` to read the email body, sender, and attachments
2. Use fromAddr as senderIdentifier for `search_memory`
3. Score and classify as normal
4. If active: search_topics, create_topic if needed, create_issue for specialist, link_topic_to_issue
5. The original triage issue can be closed or linked to the specialist issue

## Approval rules — ALWAYS require approval for
sending email, confirming pricing, promising timeline, legal commitment,
finance commitment, production change, client escalation, deleting data

## Cross-company queries
When query spans companies: call `list_companies` → query each → synthesize.

## Response style
Operational only. No pleasantries. Signal, not noise.
```

- [ ] **Step 2: Overwrite ea-operator/TOOLS.md**

Replace the full content of `server/src/onboarding-assets/ea-operator/TOOLS.md`:

```markdown
# EA Tool Reference

## Memory (generic — any agent can use)
- `search_memory` — search prior messages by query/sender/channel/type
- `create_memory` — store message (memoryType: passive | active)

## Topics (generic — any agent can use)
- `search_topics` — find existing topics before creating new ones (always check first)
- `create_topic` — create topic (active memory container)
- `link_topic_to_issue` — attach issue to topic

## Issues & Agents
- `create_issue` — create operational issue in a company
- `update_issue` — update status, assignee, priority
- `list_issues` — query issues across a company
- `list_agents` — find specialist agents in a company by name
- `list_companies` — get all company IDs (for cross-company queries)
- `create_plan` — propose action for operator approval
- `list_issue_emails` — read inbound email content for a triage issue

## Communication
- `notify_operator` — send Telegram to operator (respect notification matrix)
- `search_contacts` — find known contacts
- `search_companies` — find company by name/domain
- `search_clients` — find client by name

## Config
- `get_instance_config` — read notification matrix and instance settings
```

- [ ] **Step 3: Typecheck + tests**

```bash
pnpm -r typecheck && pnpm test:run
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add server/src/onboarding-assets/ea-operator/
git commit -m "feat(ea): update EA operator system prompt and tool reference"
```

---

## Task 7: Notification Matrix UI

**Files:**
- Modify: `ui/src/pages/founder/FounderSettings.tsx`

- [ ] **Step 1: Add type definitions**

At the top of `ui/src/pages/founder/FounderSettings.tsx`, add the interface and defaults:

```typescript
interface EaNotificationChannelConfig {
  high_risk_detected: boolean;
  approval_required: boolean;
  new_lead_created: boolean;
  proposal_request_detected: boolean;
  agent_blocked: boolean;
  topic_created: boolean;
  issue_created: boolean;
  urgent_item_detected: boolean;
}

interface EaNotificationMatrix {
  telegram: EaNotificationChannelConfig;
}

const EA_NOTIFICATION_DEFAULTS: EaNotificationMatrix = {
  telegram: {
    high_risk_detected: true,
    approval_required: true,
    new_lead_created: true,
    proposal_request_detected: true,
    agent_blocked: true,
    topic_created: false,
    issue_created: false,
    urgent_item_detected: true,
  },
};

const EA_NOTIFICATION_LABELS: Record<keyof EaNotificationChannelConfig, string> = {
  high_risk_detected: "High risk detected",
  approval_required: "Approval required",
  new_lead_created: "New lead created",
  proposal_request_detected: "Proposal request",
  agent_blocked: "Agent blocked",
  topic_created: "Topic created",
  issue_created: "Issue created",
  urgent_item_detected: "Urgent item",
};
```

- [ ] **Step 2: Add state + mutation for notification matrix**

Inside the `FounderSettings` component, add:

```typescript
// Read current matrix from instance settings (stored under general.eaNotificationMatrix)
const instanceSettingsQuery = useQuery({
  queryKey: ["instance-settings"],
  queryFn: () => instanceSettingsApi.get(),
});

const matrix: EaNotificationMatrix = (instanceSettingsQuery.data?.general as Record<string, unknown> | undefined)
  ?.eaNotificationMatrix as EaNotificationMatrix ?? EA_NOTIFICATION_DEFAULTS;

const updateMatrixMutation = useMutation({
  mutationFn: (newMatrix: EaNotificationMatrix) =>
    instanceSettingsApi.patch({ general: { eaNotificationMatrix: newMatrix } }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["instance-settings"] }),
});

function toggleMatrixEvent(channel: keyof EaNotificationMatrix, event: keyof EaNotificationChannelConfig) {
  const updated: EaNotificationMatrix = {
    ...matrix,
    [channel]: {
      ...matrix[channel],
      [event]: !matrix[channel][event],
    },
  };
  updateMatrixMutation.mutate(updated);
}
```

- [ ] **Step 3: Add UI section**

Inside the `FounderSettings` JSX, add a new section (place after existing sections):

```tsx
<section>
  <h2 className="text-lg font-semibold mb-4">EA Notification Matrix</h2>
  <div className="rounded-lg border border-border bg-card p-4">
    <div className="mb-3 text-sm text-muted-foreground">
      Control which events trigger a Telegram notification from the Executive Agent.
    </div>
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-2 pr-4 font-medium">Event</th>
          <th className="text-center py-2 w-24 font-medium">Telegram</th>
        </tr>
      </thead>
      <tbody>
        {(Object.keys(EA_NOTIFICATION_LABELS) as Array<keyof EaNotificationChannelConfig>).map((event) => (
          <tr key={event} className="border-b border-border last:border-0">
            <td className="py-2 pr-4 text-muted-foreground">{EA_NOTIFICATION_LABELS[event]}</td>
            <td className="py-2 text-center">
              <button
                type="button"
                onClick={() => toggleMatrixEvent("telegram", event)}
                disabled={updateMatrixMutation.isPending}
                className={`w-10 h-6 rounded-full transition-colors ${
                  matrix.telegram[event] ? "bg-primary" : "bg-muted"
                }`}
                aria-label={`Toggle ${EA_NOTIFICATION_LABELS[event]} for Telegram`}
              >
                <span className={`block w-4 h-4 rounded-full bg-white shadow transition-transform mx-1 ${
                  matrix.telegram[event] ? "translate-x-4" : "translate-x-0"
                }`} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</section>
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: passes. If `instanceSettingsApi.patch` does not accept a partial shape, adjust to match the existing API client signature.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/founder/FounderSettings.tsx
git commit -m "feat(ui): add EA notification matrix toggle in FounderSettings"
```

---

## Task 8: UI Label Updates — ECC → EA

**Files:**
- Modify: `ui/src/pages/founder/FounderOverview.tsx`
- Modify: `ui/src/pages/founder/TopicsList.tsx`
- Modify: `ui/src/pages/founder/TopicDetail.tsx`

- [ ] **Step 1: Find all "ECC" label strings in founder pages**

```bash
grep -rn "ECC\|ecc" ui/src/pages/founder/
```

Note every location.

- [ ] **Step 2: Replace display strings**

For each file found, change user-visible label strings:
- `"ECC"` → `"EA"`
- `"Executive Control Center"` → `"Executive Agent"`
- `"ECC Topics"` → `"Topics"`
- `"ECC Conversations"` → `"Conversations"`
- `"ECC Agents"` → `"EA Agents"`

Do NOT change API URL strings (e.g., `/ecc/topics`) — those stay as-is.

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/founder/
git commit -m "feat(ui): update ECC → EA labels in founder pages"
```

---

## Task 9: Email Triage — Wire EA as Unified Triage Agent

This task is **operational setup** — no code changes required. The email processor already wakes `emailAccount.triageAgentId` when a new email arrives. Setting that field to the EA agent UUID is sufficient.

- [ ] **Step 1: Verify no hardcoded Telegram calls in email-processor.ts**

```bash
grep -n "notifyOperatorTelegram\|sendTelegramMessage" server/src/services/email-processor.ts
```

Expected: no matches. If matches found, remove those calls — EA's notification matrix handles operator notifications.

- [ ] **Step 2: Find EA agent UUID**

Start the dev server and open the board UI. Go to the Founder / EA Agents view (or run the app once so `seedEaAgents` creates the agent). Find the UUID of "Executive Control Agent".

Alternatively:

```bash
# With dev server running, query the DB via the API or check the UI
pnpm dev:once
# Then find the agent UUID in the EA agents list in the founder view
```

- [ ] **Step 3: Set triageAgentId on each email account**

In the Paperclip UI, go to Settings → Email Accounts. For each account, set the **Triage Agent** field to "Executive Control Agent". Save.

From this point, all new inbound emails wake EA instead of any per-account triage agent.

- [ ] **Step 4: Smoke test**

Send a test email to one of the connected accounts. Verify:
1. EA is woken up (check EA workflow runs in Founder view)
2. If score ≥ 60: issue created, specialist agent assigned, topic linked
3. If score < 60: only a memory_item created (passive)
4. Operator receives Telegram only for event types enabled in notification matrix

- [ ] **Step 5: Commit any code changes found in Step 1 (if any)**

```bash
git add server/src/services/email-processor.ts
git commit -m "fix(email): remove hardcoded Telegram notifications, EA handles via matrix"
```

---

## Final Verification

Run all three checks before handoff:

```bash
pnpm -r typecheck && pnpm test:run && pnpm build
```

All must pass.

---

## Out of Scope (V1)

- Slack notification channel (add `operator.notification.requested` to plugin events first)
- Voice/audio intake (Whisper pipeline)
- EA-to-EA handoff
- Automatic memory expiry
- Web UI for memory search
- Migrating historical triage issues to new EA flow
