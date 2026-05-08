# ECC Conversation-Workflow Foundation — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the ECC agent (founder-layer) persistent conversation context and workflow tracing across stateless Claude CLI invocations, so each Telegram message from JayJay resolves to an active topic, continues the right conversation thread, and records a traceable workflow run.

**Sub-project:** A of 4 (Conversation-Workflow Foundation). Subsequent sub-projects: B (Topic Intelligence), C (CEO Agent Delegation), D (Workflow UI).

---

## Background

The ECC agent (`orchestrator.ts`, `ECC_SYSTEM_PROMPT`) processes every inbound operator message by spawning a fresh Claude CLI subprocess. Each subprocess exits after responding — it has **zero memory** of previous messages. The only persistence today is the `ecc_topics.summary` field (updated via `update_topic_memory` MCP tool).

This means follow-up messages ("What's the blocker?" sent 5 minutes after a previous exchange) start completely blank. The ECC has no short-term memory.

This sub-project adds:
1. A **conversation entity** that groups messages within a 14-day window per topic
2. **Short-term memory** (last 20 exchanges injected into each new spawn)
3. **Workflow tracing** (a `workflow_run` per conversation turn, with stages)
4. **Expiry management** (agent warns and asks to extend before the window closes)

---

## Data Model

### New table: `ecc_conversations`

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
topicId         uuid NOT NULL REFERENCES ecc_topics(id) ON DELETE CASCADE
status          text NOT NULL DEFAULT 'active'   -- 'active' | 'expired' | 'extended'
startedAt       timestamptz NOT NULL DEFAULT now()
lastMessageAt   timestamptz NOT NULL DEFAULT now()
expiresAt       timestamptz NOT NULL             -- lastMessageAt + 14 days, updated each message
messageCount    integer NOT NULL DEFAULT 0
recentMessages  jsonb NOT NULL DEFAULT '[]'      -- last 20 {role, content, ts} objects
createdAt       timestamptz NOT NULL DEFAULT now()
```

Indexes: `(topicId, status)`, `(expiresAt)` (for expiry scans), `(topicId, lastMessageAt DESC)`.

### Workflow runs (unchanged schema)

Each conversation turn produces one `workflow_run`:
- `workflowType = "ecc_conversation"`
- `sourceId = conversationId`
- `companyId` = topic's companyId (or null if cross-company)

Stages per run (in order):

| stageId | label | Meaning |
|---|---|---|
| `message_received` | Message received | Always passes — marks entry point |
| `topic_matched` | Topic matched | Passes if ECC matched an existing topic; fails if no match found |
| `conversation_resolved` | Conversation resolved | Passes if active conversation found/created |
| `memory_updated` | Memory updated | Passes if `update_topic_memory` was called this turn |
| `action_taken` | Action taken | Passes if any action tool was called (notify, create_plan, list_issues, etc.) |

### Relationship diagram

```
ecc_topics (1) ──→ (many) ecc_conversations
ecc_conversations (1) ──→ (many) workflow_runs  [sourceId = conversationId]
workflow_runs (1) ──→ (many) workflow_stage_results
```

---

## New Service: `eccConversationsService`

File: `server/src/services/ecc-conversations.ts`

```typescript
eccConversationsService(db) → {
  resolveActive(topicId: string): Promise<EccConversation>
  // Finds conversation with status='active' and expiresAt > now() for topicId.
  // If none: creates new conversation (status=active, expiresAt=now+14d).
  // Updates lastMessageAt + expiresAt + messageCount on find.

  appendMessage(conversationId: string, role: "user"|"assistant", content: string): Promise<void>
  // Appends {role, content, ts: now()} to recentMessages jsonb.
  // Trims to last 20 entries.

  extend(conversationId: string, extraDays?: number): Promise<EccConversation>
  // Adds extraDays (default 14) to expiresAt. Sets status='extended'.

  expire(conversationId: string): Promise<void>
  // Sets status='expired'.

  list(topicId: string): Promise<EccConversation[]>
  // All conversations for a topic, newest first.

  listAllActive(): Promise<EccConversation[]>
  // All conversations with status='active' and expiresAt > now(), across all topics.
  // Used by orchestrator to build context for each ECC spawn.
}
```

---

## New MCP Tools

Three new tools added to `server/src/routes/mcp-tool-server.ts`.

### `resolve_conversation`

**Input:** `{ topicId: string }`

**What it does:**
1. Calls `eccConversationsService.resolveActive(topicId)`
2. Creates a `workflow_run` (type=`ecc_conversation`, sourceId=conversationId)
3. Records stages `message_received:passed` + `topic_matched:passed` + `conversation_resolved:passed`
4. Returns `{ conversationId, runId, topicName, summary, currentState, expiresAt, messageCount, warningDays }`

`warningDays` = days until expiry. If `warningDays < 3`, agent must warn JayJay.

### `extend_conversation`

**Input:** `{ conversationId: string }`

**What it does:**
1. Calls `eccConversationsService.extend(conversationId)`
2. Returns `{ newExpiresAt }`

### `complete_conversation_turn`

**Input:** `{ runId: string, memoryUpdated: boolean, issuesLinked: boolean }`

**What it does:**
1. Adds stage `memory_updated` → passed if `memoryUpdated=true`, skipped otherwise
2. Adds stage `action_taken` → passed if any action was taken (always true if Claude called this)
3. Marks `workflow_run.overallStatus = 'passed'`, sets `finishedAt = now()`

---

## Orchestrator Changes

File: `server/src/services/orchestrator.ts`

### Pre-spawn (operator path only)

Before spawning Claude:

1. Fetch `eccConversationsService.listAllActive()` — all active conversations
2. For each active conversation, include its `recentMessages` and topic summary
3. Build a context block injected into the system prompt:

```
## Active Conversations

[Conversation: "Innotrack Recruitment" | topic-id: xxx | expires: 2026-05-23 | 5 messages]
Recent messages:
  [user, 2026-05-08 14:32] Update on the recruitment project
  [assistant, 2026-05-08 14:32] Found 3 open issues in Innotrack...
  ...

[Conversation: "Develtech Website Redesign" | topic-id: yyy | expires: 2026-05-15 | 2 messages]
...
```

4. Inject this block into the ECC system prompt before spawning.

### Post-spawn (operator path only)

After Claude subprocess exits:

1. Append user message to conversation: `appendMessage(conversationId, "user", inputText)`
2. Capture Claude's text output (stdout) and append: `appendMessage(conversationId, "assistant", claudeOutput)`

The `conversationId` is known because Claude called `resolve_conversation` via MCP — the service stores it in a request-scoped variable accessible to the orchestrator.

---

## ECC System Prompt Additions

Append to `ECC_SYSTEM_PROMPT` in `orchestrator.ts`:

```
## Conversation protocol (REQUIRED — follow on every message)

You are stateless. Each message is a fresh subprocess with no memory of previous turns.
The "Active Conversations" section above gives you short-term memory — read it first.

**On every message:**
1. Read Active Conversations above — identify which conversation this message continues
2. If a matching active conversation exists: call resolve_conversation(topicId)
3. If no match AND topic exists but no active conversation: call resolve_conversation(topicId) to start new conversation
4. If no matching topic at all: ask JayJay which topic this belongs to, or propose a new topic name and wait for confirmation before calling create_topic
5. Do your work (list_issues, update_topic_memory, notify_operator, etc.)
6. Always call complete_conversation_turn(runId, {memoryUpdated, issuesLinked}) before finishing

## Expiry management

After resolve_conversation returns:
- If warningDays < 3: immediately notify_operator "Conversation '[name]' expires in X days. Reply 'extend' to continue."
- If the message contains intent to extend (e.g. "extend", "keep going"): call extend_conversation(conversationId)
- If expiresAt is already past: tell JayJay the conversation expired, ask to start fresh
```

---

## Test Scenarios

### Test 1 — First message, new topic match (Telegram)

JayJay sends: *"Update on the recruitment project for Innotrack"*

Expected flow:
1. Telegram polling → inbound-router (`fromType=operator`) → orchestrator
2. Orchestrator fetches active conversations (empty first time), injects blank active conversations context
3. Claude spawns, reads message, calls `list_topics` → finds "Innotrack Recruitment"
4. Calls `resolve_conversation("innotrack-topic-id")` → new conversation created, `workflow_run` created with stages `message_received:pass`, `topic_matched:pass`, `conversation_resolved:pass`
5. Calls `list_issues(innotrackCompanyId)` → retrieves open/blocked
6. Calls `update_topic_memory(topicId, updated notes)`
7. Calls `notify_operator` with summary
8. Calls `complete_conversation_turn(runId, {memoryUpdated:true, issuesLinked:false})`
9. Workflow run: all stages green, `overallStatus=passed`
10. Orchestrator appends user message + Claude response to `recentMessages`

**Verify:** `GET /api/workflow-runs/by-source/ecc_conversation/:conversationId` → returns run with 5 stages

### Test 2 — Follow-up message, conversation continues

JayJay sends (5 min later): *"What's the main blocker?"*

Expected flow:
1. Orchestrator fetches active conversations → finds "Innotrack Recruitment" with `recentMessages` from Test 1
2. Injects recent messages into context
3. Claude spawns, reads active conversations context, recognises this continues the Innotrack conversation
4. Calls `resolve_conversation` → finds existing conversation, increments messageCount, new `workflow_run` created
5. Claude has full context — answers about the blocker from recentMessages + live `list_issues` call
6. Full workflow run recorded

### Test 3 — Expiry warning

JayJay sends a message when `expiresAt` is in 2 days:

Expected: Claude calls `resolve_conversation` → `warningDays=2` → Claude calls `notify_operator` "Conversation expires in 2 days. Reply 'extend' to continue." alongside normal response.

### Test 4 — Telegram paste of client message

JayJay sends: *"Client Acme Corp said: 'We need the proposal by Friday.' This is for the Develtech Consulting project."*

Expected: Claude identifies "Develtech Consulting" topic, resolves conversation, updates memory with the client's request, links relevant issues, notifies JayJay of actions taken.

---

## Files to Create / Modify

| File | Action |
|---|---|
| `packages/db/src/schema/ecc_conversations.ts` | Create — new table schema |
| `packages/db/src/schema/index.ts` | Modify — export new schema |
| `packages/db/src/migrations/NNNN_ecc_conversations.sql` | Generate via `pnpm db:generate` |
| `server/src/services/ecc-conversations.ts` | Create — new service |
| `server/src/routes/mcp-tool-server.ts` | Modify — add 3 new tools |
| `server/src/services/orchestrator.ts` | Modify — pre/post spawn logic + updated ECC_SYSTEM_PROMPT |
| `server/src/app.ts` | No change needed |

---

## Out of Scope for This Sub-project

- CEO Agent delegation (Sub-project C)
- Workflow UI improvements (Sub-project D)
- Gmail operator email recognition
- Client-side conversation tracking (client messages via email/WhatsApp get their own conversation model in a later sub-project)
- Automated expiry cron job (manual expiry via agent warning is sufficient for now)
