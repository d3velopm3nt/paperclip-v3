# Executive Agent (EA) Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ECC with a proper Executive Agent — a cross-company intake, classification, and routing agent that gates all incoming messages, creates structured memory, and routes work to specialist per-company Paperclip agents. All specialist work is visible in the normal Paperclip UI.

**Architecture:** EA (companyId: null, adapterType: "ea") handles intake only. Specialist agents (client_agent, proposal_agent, dev_agent per company) run through full Paperclip heartbeat/issue flow — visible on board, activity-logged, budget-tracked. Memory and topics are **generic infrastructure** usable by any agent, not EA-specific.

**Tech Stack:** Express 5, Drizzle ORM, React 19 + TanStack Query, existing MCP tool server, existing agent heartbeat system.

---

## File Structure

| File | Change |
|------|--------|
| `packages/db/src/schema/ecc_topics.ts` → `topics.ts` | Rename file + symbols `eccTopics` → `topics`, `eccTopicIssues` → `topicIssues` |
| `packages/db/src/migrations/NNNN_rename_ecc_to_ea.sql` | ALTER TABLE renames + UPDATE adapterType |
| `packages/db/src/schema/memory_items.ts` | New — generic memory store |
| `server/src/services/ecc-agents.ts` → `ea-agents.ts` | Rename + update all symbols |
| `server/src/services/ecc-conversations.ts` → `ea-conversations.ts` | Rename + update all symbols |
| `server/src/services/ecc-topics.ts` → `topics.ts` | Rename + update all symbols |
| `server/src/routes/ecc-topics.ts` → `topics.ts` | Rename + update all symbols |
| `server/src/routes/mcp-tool-server.ts` | Add `search_memory`, `create_memory`, `search_topics`, `create_topic`, `link_topic_to_issue` tools |
| `server/src/onboarding-assets/ea-operator/AGENTS.md` | New — EA system prompt (replaces ecc-operator/AGENTS.md) |
| `server/src/onboarding-assets/ea-operator/TOOLS.md` | New — EA tool reference |
| `ui/src/pages/founder/FounderOverview.tsx` | Update labels ECC → EA |
| `ui/src/pages/founder/TopicsList.tsx` | Update labels |
| `ui/src/pages/founder/TopicDetail.tsx` | Update labels |
| `ui/src/pages/founder/FounderSettings.tsx` | Add notification matrix UI |
| `ui/src/api/topics.ts` | Update any ECC-specific references |

---

## Task 1: Rename ECC → EA (DB + Code)

**Files:**
- Modify: `packages/db/src/schema/ecc_topics.ts` (rename to `topics.ts`)
- Create: `packages/db/src/migrations/NNNN_rename_ecc_to_ea.sql`
- Modify: `server/src/services/ecc-agents.ts` (rename file)
- Modify: `server/src/services/ecc-conversations.ts` (rename file)
- Modify: `server/src/services/ecc-topics.ts` (rename file)
- Modify: `server/src/routes/ecc-topics.ts` (rename file)
- Modify: `server/src/app.ts`, `server/src/index.ts` (import paths)
- Modify: `ui/src/pages/founder/*.tsx` (label strings)

### Migration SQL

```sql
-- Rename tables (ecc → generic names)
ALTER TABLE ecc_topics RENAME TO topics;
ALTER TABLE ecc_topic_issues RENAME TO topic_issues;

-- Rename indexes
ALTER INDEX ecc_topics_status_idx RENAME TO topics_status_idx;
ALTER INDEX ecc_topics_company_idx RENAME TO topics_company_idx;

-- Rename adapterType in agents table
UPDATE agents SET adapter_type = 'ea' WHERE adapter_type = 'ecc';
```

### Schema symbol rename (`topics.ts`)

```typescript
// Before (ecc_topics.ts)
export const eccTopics = pgTable("ecc_topics", { ... });
export const eccTopicIssues = pgTable("ecc_topic_issues", { ... });

// After (topics.ts)
export const topics = pgTable("topics", { ... });
export const topicIssues = pgTable("topic_issues", { ... });
```

Update `packages/db/src/schema/index.ts`:
```typescript
// Before
export { eccTopics, eccTopicIssues } from "./ecc_topics.js";
// After
export { topics, topicIssues } from "./topics.js";
```

### Service file renames

```bash
mv packages/db/src/schema/ecc_topics.ts packages/db/src/schema/topics.ts
mv server/src/services/ecc-agents.ts server/src/services/ea-agents.ts
mv server/src/services/ecc-conversations.ts server/src/services/ea-conversations.ts
mv server/src/services/ecc-topics.ts server/src/services/topics.ts
mv server/src/routes/ecc-topics.ts server/src/routes/topics.ts
mv server/src/onboarding-assets/ecc-operator server/src/onboarding-assets/ea-operator
mv server/src/onboarding-assets/ecc-client server/src/onboarding-assets/ea-client
mv server/src/__tests__/ecc-agents.test.ts server/src/__tests__/ea-agents.test.ts
mv server/src/__tests__/ecc-conversations.test.ts server/src/__tests__/ea-conversations.test.ts
```

In `ea-agents.ts`, update all `"ecc"` string literals to `"ea"`:
```typescript
// Storage path
return path.resolve(resolvePaperclipInstanceRoot(), "ea", agentId, "instructions");
// DB queries
eq(agents.adapterType, "ea")
// Insert
adapterType: "ea"
```

**Verification:** `pnpm -r typecheck` passes. `pnpm test:run` passes.

---

## Task 2: memory_items Schema + Migration

**Files:**
- Create: `packages/db/src/schema/memory_items.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/NNNN_add_memory_items.sql`

### Schema

```typescript
// packages/db/src/schema/memory_items.ts
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { emailMessages } from "./email_messages.js";

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(), // email | whatsapp | telegram | manual
    sourceId: text("source_id"),                     // external message ID
    sourceEmailMessageId: uuid("source_email_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
    senderIdentifier: text("sender_identifier"),     // email addr, phone, telegram user
    content: text("content").notNull(),
    summary: text("summary"),
    intentCategory: text("intent_category"),
    importanceScore: integer("importance_score"),
    memoryType: text("memory_type").notNull().default("passive"), // passive | active
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

Export from `packages/db/src/schema/index.ts`:
```typescript
export { memoryItems } from "./memory_items.js";
```

### Migration SQL

```sql
CREATE TABLE memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL,
  source_id TEXT,
  source_email_message_id UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  sender_identifier TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  intent_category TEXT,
  importance_score INTEGER,
  memory_type TEXT NOT NULL DEFAULT 'passive',
  tags JSONB NOT NULL DEFAULT '[]',
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX memory_items_company_idx ON memory_items(company_id);
CREATE INDEX memory_items_channel_idx ON memory_items(source_channel);
CREATE INDEX memory_items_sender_idx ON memory_items(sender_identifier);
CREATE INDEX memory_items_type_idx ON memory_items(memory_type);
```

**Verification:** `pnpm db:generate && pnpm -r typecheck` passes.

---

## Task 3: MCP Tools (generic memory + topics)

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

Add 5 new tools. These are generic — available to any agent, not gated to EA only.

### Tool definitions (add to tools array)

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
  description: "Store a message or context in memory. Use memoryType='passive' for low-importance items (noise, FYI, casual). Use memoryType='active' when creating operational context alongside an issue.",
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
  description: "Create a new topic (active memory container). A topic groups related issues under one business context (e.g. 'SafeX Proposal', 'Kevin O'Neill - Teaming Agreement').",
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

### Tool handlers

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
    .limit(Math.min(limit, 50));
  return JSON.stringify(rows);
}

if (name === "create_memory") {
  const { content, summary, sourceChannel, sourceId, sourceEmailMessageId, senderIdentifier,
    companyId: memCompanyId, intentCategory, importanceScore, memoryType, tags } = args as {
    content: string; summary?: string; sourceChannel: string; sourceId?: string;
    sourceEmailMessageId?: string; senderIdentifier?: string; companyId?: string;
    intentCategory?: string; importanceScore?: number; memoryType: string; tags?: string[];
  };
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
    .limit(Math.min(limit, 50));
  return JSON.stringify(rows);
}

if (name === "create_topic") {
  const { name: topicName, summary, currentState, companyId: topicCompanyId } = args as {
    name: string; summary?: string; currentState?: string; companyId?: string;
  };
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
  await db.insert(topicIssues).values({ topicId, issueId: linkIssueId }).onConflictDoNothing();
  return `Linked topic ${topicId} to issue ${linkIssueId}`;
}
```

**Verification:** `pnpm -r typecheck` passes. Test with EA agent calling each tool.

---

## Task 4: Notification Matrix Config

**Files:**
- Modify: `ui/src/pages/founder/FounderSettings.tsx`
- Modify: `server/src/routes/instance-settings.ts` (or equivalent settings route)

### Data structure (stored in `instanceSettings.general`)

```typescript
interface EaNotificationMatrix {
  telegram: EaNotificationChannelConfig;
  // email: EaNotificationChannelConfig;  // future
}

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
```

### UI (add to `FounderSettings.tsx`)

Section titled "EA Notification Matrix" with a table of toggles:

```
Channel: Telegram  [master on/off toggle]

Event                      Telegram
─────────────────────────────────────
High risk detected         [●]
Approval required          [●]
New lead created           [●]
Proposal request           [●]
Agent blocked              [●]
Topic created              [○]
Issue created              [○]
Urgent item                [●]
```

Each toggle calls `PATCH /api/instance/settings` updating the matrix key. Read defaults from `EA_NOTIFICATION_DEFAULTS` when key is absent.

### EA notify_operator respects matrix

EA reads notification matrix via `get_instance_config` MCP tool at runtime and calls `notify_operator` only for enabled event types.

**Verification:** Toggle off `approval_required` on Telegram — no Telegram message fires when EA creates approval. Toggle on — message fires.

---

## Task 5: EA Onboarding Assets

**Files:**
- Create: `server/src/onboarding-assets/ea-operator/AGENTS.md`
- Create: `server/src/onboarding-assets/ea-operator/TOOLS.md`

### `AGENTS.md` (EA system prompt)

```markdown
You are the Executive Agent (EA) — JayJay Barnard's cross-company intake and routing intelligence.

## Your role
You are the first-line gatekeeper for ALL incoming messages and events across all companies.
You classify, score, route, and track — you do not execute business actions yourself.

## Operating model
1. Receive message → identify sender → search_memory for prior context on sender
2. Score importance (0-100) using the factors below
3. If score < 60: create_memory(memoryType='passive'), stop
4. If score ≥ 60: search_topics → create_topic if no match → create_issue → assign to specialist agent → link_topic_to_issue → create_memory(memoryType='active')
5. If approval needed: create_plan
6. notify_operator IF event type is enabled in notification matrix (read via get_instance_config)

## Importance scoring

Start at 0. Add:
- Sender: unknown=5, known_contact=15, active_client=25, partner=30
- Business impact: none=0, low=10, medium=20, high=30
- Action required: no_action=0, possible=10, clear=20, urgent=30
- Financial: none=0, invoice/payment=20, pricing/quote=25, contract=30
- Risk: low=0, medium=10, high=25, critical=40

Active threshold: 60. Urgent threshold: 85.

## CRITICAL: your text output goes nowhere
JayJay NEVER sees your reasoning. Only tool calls reach him. If you don't call notify_operator, JayJay receives NOTHING.

## Intent categories
noise | casual_conversation | informational | follow_up | reminder_request |
client_request | new_lead | proposal_request | pricing_request | support_issue |
development_task | finance_admin | legal_contract | family_personal | home_maintenance |
approval_request | urgent_risk | agent_update | agent_blocker

## Routing rules
- new_lead, client_request, proposal_request → client_agent (per company)
- pricing_request → proposal_agent (per company)
- development_task → dev_agent / FullStackDev (per company)
- finance_admin, legal_contract → create issue, assign to finance_agent or flag for JayJay
- personal_reminder, family_personal → create reminder issue, assign to personal_admin_agent
- agent_blocker → update issue, notify JayJay immediately

## Approval rules — always require approval for
sending email, confirming pricing, promising timeline, legal commitment,
finance commitment, production change, client escalation, deleting data

## Cross-company queries
When query spans companies: call list_companies → query each → synthesize.

## Response style
Operational only. No pleasantries. Signal, not noise.
```

### `TOOLS.md`

```markdown
# EA Tool Reference

## Memory (generic — any agent can use)
- search_memory — search prior messages by query/sender/channel/type
- create_memory — store message (memoryType: passive | active)

## Topics (generic — any agent can use)
- search_topics — find existing topics before creating new ones
- create_topic — create topic (active memory container)
- link_topic_to_issue — attach issue to topic

## Issues & Agents
- create_issue — create operational issue in a company
- update_issue — update status, assignee
- list_issues — query issues across a company
- list_agents — find specialist agents in a company by name
- list_companies — get all company IDs (for cross-company queries)
- create_plan — propose action for JayJay approval

## Communication
- notify_operator — send Telegram to JayJay (respect notification matrix)
- search_contacts — find known contacts
- search_companies — find company by name/domain
- search_clients — find client by name
```

**Verification:** EA agent starts, loads correct system prompt, can call all tools.

---

## Task 6: Specialist Agent Registration

**Not a code change** — operational setup documented here.

Specialist agents are created via Paperclip UI (New Agent) per company:

| Role | Agent name | adapterType | companyId |
|------|-----------|-------------|-----------|
| Client comms | `client_agent` | `claude` (or preferred) | per-company |
| Proposals | `proposal_agent` | `claude` | per-company |
| Dev work | `FullStackDev` (exists) | `claude` | per-company |
| Finance/admin | `finance_agent` | `claude` | per-company |

Each gets a skills injection with its specialist AGENTS.md. EA routes to these by assigning issues in the correct company.

EA does NOT need to know agent UUIDs — it calls `list_agents(companyId)` and matches by name.

---

## Task 7: EA as Unified Email Triage Agent

**Goal:** Replace the per-account `triageAgentId` with EA so all inbound email flows through the same intake/classification pipeline as Telegram and WhatsApp. Email processor keeps handling IMAP, attachment extraction, and HTML parsing — EA replaces the triage agent at the end of that pipeline.

### Current flow (before)

```
IMAP monitor → email-processor → wakes triageAgentId (dedicated per-account agent)
                               → notifyOperatorTelegram (own hardcoded call)
                               → triage agent creates issue + assigns specialist
```

### Unified flow (after)

```
IMAP monitor → email-processor → wakes EA
EA:  list_issue_emails OR read emailMessage context from issue
  → search_memory(senderIdentifier=fromAddr) for prior context
  → score + classify
  → passive: create_memory(passive), stop
  → active:  search_topics → create_topic → create_issue → assign specialist → link_topic_to_issue
  → notify_operator per notification matrix
```

### Changes

**Files:**
- Modify: `server/src/services/email-processor.ts` — remove own `notifyOperatorTelegram` calls (EA handles notifications via matrix)
- Operational: set `emailAccounts.triageAgentId = EA agent ID` for all accounts via UI or migration

**Remove from `email-processor.ts`:**

All `notifyOperatorTelegram` / `sendTelegramMessage` calls inside the email processor. EA's notification matrix takes over. The processor still sends `teamEmails` (those are client-facing account notifications, not operator notifications — keep as-is).

**EA system prompt addition** (add to `AGENTS.md` routing rules section):

```markdown
## Email triage
When woken up for an email triage issue:
1. Call list_issue_emails(issueId) to read the email body, sender, attachments
2. Use fromAddr as senderIdentifier for search_memory
3. Score and classify as normal
4. If active: search_topics, create_topic if needed, create_issue for specialist, link_topic_to_issue
5. The original triage issue can be closed or linked to the new specialist issue
```

**Operational setup (not code):**

After EA agent is created, set `triageAgentId` on each `emailAccount` to the EA agent UUID via the Email Accounts settings page. From that point, all new inbound emails wake EA instead of the old triage agent.

**Verification:** Send test email → EA woken up → EA classifies → if score ≥ 60, issue created and assigned to specialist agent. Operator receives Telegram only for event types enabled in notification matrix.

---

## Out of Scope (V1)

- Slack notification channel (future — use plugin event system after `operator.notification.requested` event added)
- Voice/audio message intake (future — Whisper pipeline)
- EA-to-EA handoff (future — multi-EA for different personal domains)
- Automatic memory expiry/cleanup
- Web UI for memory search (future — can query via EA Telegram commands)
- Migrating existing triage issues to new EA flow (historical data stays as-is)
