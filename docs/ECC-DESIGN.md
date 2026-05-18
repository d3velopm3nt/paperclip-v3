# ECC (Executive Command Center) — System Design

Current as of 2026-05-09. Branch: `feature/founder-overview-redesign` (ahead of `feature/ecc-conversation-workflow`).

---

## What It Is

ECC is JayJay's operational intelligence layer. Every inbound Telegram message from JayJay spawns a stateless Claude CLI subprocess with the Paperclip MCP server attached. The subprocess processes the message, calls MCP tools, sends Telegram replies via `notify_operator`, and exits. Persistence is via `ecc_conversations.recentMessages` (DB) injected into every spawn.

---

## Message Flow

```
Telegram message → telegram adapter → operatorMessages table
                                    → runOrchestrator(db, input)
                                         ├─ buildActiveConversationsContext(db)  [inject topics + convs + inbox]
                                         ├─ spawn claude CLI subprocess
                                         │    ├─ resolve_conversation(topicId, messagePreview)   [MANDATORY FIRST]
                                         │    ├─ ... process + tool calls ...
                                         │    └─ complete_conversation_turn(runId, actionSummary, issuesLinked)  [MANDATORY LAST]
                                         └─ post-spawn: appendMessage(user + assistant) to touched conversation
```

---

## Key Files

| File | Role |
|------|------|
| `server/src/services/orchestrator.ts` | Entry point. Builds context, spawns Claude CLI, captures stdout, appends messages post-spawn. |
| `server/src/routes/mcp-tool-server.ts` | All MCP tools. ECC-specific: `list_topics`, `create_topic`, `update_topic_memory`, `link_issue_to_topic`, `resolve_conversation`, `extend_conversation`, `complete_conversation_turn`. |
| `server/src/services/ecc-conversations.ts` | `eccConversationsService`: `resolveActive`, `appendMessage`, `extend`, `expire`, `list`, `getById`, `listAllActive(limit)`, `listAll(limit)`. |
| `server/src/services/ecc-topics.ts` | `eccTopicsService`: CRUD for topics + `linkIssue`, `unlinkIssue`. |
| `server/src/routes/ecc-topics.ts` | REST routes: `/ecc/topics`, `/ecc/conversations`, `/ecc/conversations/:id`. Includes `enrichConv()` helper. |
| `packages/db/src/schema/ecc*.ts` | `ecc_topics` + `ecc_conversations` tables. |

---

## DB Schema

### `ecc_topics`
- `id`, `name`, `companyId` (nullable), `status` (active/archived)
- `summary` — markdown long-term memory, updated via `update_topic_memory`
- `currentState` — single-line status e.g. "Awaiting contract sign-off"
- Topic ↔ Issue link table: `ecc_topic_issues`

### `ecc_conversations`
- `id`, `topicId`, `status` (active/extended/expired)
- `startedAt`, `lastMessageAt`, `expiresAt` (14-day rolling window)
- `messageCount`
- `recentMessages: ConversationMessage[]` — JSON array, max 20, `{ role, content, ts }`

---

## Context Injected Per Spawn (`buildActiveConversationsContext`)

```
## Available Topics
- "Tender pipeline" | topic-id: uuid | state: ... | company: uuid
- ...

## Active Conversations
[Topic: "Tender pipeline" | topic-id: ... | conversation-id: ... | expires-in: 12d | messages: 5]
State: Awaiting sign-off
Memory: <topic.summary first 300 chars>
Recent:
  [user | 09 May 08:12] ...
  [assistant | 09 May 08:12] ...

## Recent Inbox Messages (unassigned — for context when JayJay replies to a previous suggestion)
  [user | ...] ...
  [assistant | ...] ...

## Inbox fallback
If no topic matches, use topic-id: <inboxId> (ECC Inbox) for resolve_conversation, then notify_operator.
```

---

## Topic Matching Rules (System Prompt)

1. Read message content first — what company/person/project does it concern?
2. Check **Available Topics** — does any name clearly match? Use that `topicId`.
3. Check **Active Conversations** for memory/context — NOT for default assignment.
4. If ambiguous → call `list_topics` for broader search.
5. No match → use Inbox `topicId` for `resolve_conversation`, then `notify_operator` asking which topic.
6. **After topic creation**: Available Topics updated immediately. Next message MUST check Available Topics first before Active Conversations.

**Never** force-match unrelated content to an existing active conversation (e.g. Rockdog message → Life topic just because it's the only active conversation).

---

## Mandatory Per-Turn Protocol

Every message MUST bookend with:
1. **First call**: `resolve_conversation(topicId, messagePreview)` — creates/finds active conversation, returns `runId` + full context.
2. **Last call**: `complete_conversation_turn(runId, actionSummary, issuesLinked)` — closes the workflow run.

---

## Memory Systems

| Type | Storage | Updated by | Injected into context |
|------|---------|------------|----------------------|
| Short-term | `ecc_conversations.recentMessages` (last 20 msgs) | Orchestrator post-spawn (`appendMessage`) | ✅ Always — via Active Conversations + Inbox sections |
| Long-term | `ecc_topics.summary` + `currentState` | Agent calling `update_topic_memory` | ✅ Always — "Memory:" line per active conversation |

**Known gap**: `update_topic_memory` is not mandatory in system prompt — agent calls it at its discretion. Could make mandatory (similar to `complete_conversation_turn`).

---

## MCP Tools (ECC-Relevant)

| Tool | Purpose |
|------|---------|
| `list_topics` | Search/find topics by name or company |
| `create_topic` | Create new topic — REQUIRES prior `notify_operator` approval. Returns topicId + instruction to use it next message. |
| `update_topic_memory` | Update `topic.summary` (markdown) and/or `currentState` |
| `link_issue_to_topic` | Link issue UUID to topic |
| `resolve_conversation` | Start/find active conversation for topicId. Returns `runId`, `conversationId`, full recent messages. |
| `extend_conversation` | Extend expiry when `warningDays <= 3` |
| `complete_conversation_turn` | Close workflow run. Params: `runId`, `actionSummary`, `issuesLinked`. |
| `notify_operator` | Send Telegram message to JayJay. **Only way to reach JayJay** — agent text output goes nowhere. |
| `list_companies` | Get all company IDs/names for cross-company queries |

---

## Workflow Tracing

Every `resolve_conversation` creates a `workflow_runs` row (`workflowType: "ecc_conversation"`). Stages:
- `message_received` — actuals: `{ topicId, messagePreview }`
- `topic_matched` — actuals: `{ topicId, topicName }`
- `memory_updated` — always `passed` (messages appended post-spawn by orchestrator)
- `action_taken` — actuals: `{ actionSummary, issuesLinked }`

Viewable at: `/workflows` → filter by ECC type, or `/founder/conversations/:convId` → click a turn.

---

## UI Structure

```
/founder                        → FounderView (tab shell)
  /founder (index)              → FounderOverview — two-column:
                                    Left: CompanyCards (topics + running agents) + NeedsAttention
                                    Right: Live Conversations panel (top 8 active)
  /founder/topics               → TopicsList
  /founder/conversations        → FounderConversations (full list, active/all toggle)
  /founder/conversations/:id    → FounderConversationDetail (workflow runs per conversation)
/workflows/run/:runId           → WorkflowRunDetail (pipeline stages + event timeline)
/workflows                      → EmailWorkflows (all workflow types, type filter dropdown)
```

### Conversation Card Design
Same pattern used in both `FounderConversations` and `FounderOverview` right panel:
- Status icon left (CheckCircle=active, XCircle=expired, Activity=running, Clock=unknown)
- Badges row: topic (violet), company (blue), issues (green), expiring (amber)
- Last user message (line-clamp-1)
- Assistant reply preview `↳ ...` (line-clamp-1)
- Time top-right

---

## ECC Inbox Topic

Auto-created on every spawn if missing (`name: "ECC Inbox", companyId: null`). Used as fallback when no topic matches a message. Its `recentMessages` are injected into context as "Recent Inbox Messages" so multi-turn exchanges (e.g. "yes create the topic") retain memory of what was previously suggested.

---

## Known Issues / Next Steps

- `update_topic_memory` not mandatory — topic summaries only updated if agent chooses to call it
- Agent chips on company cards (Overview) show running workflow runs — visible only during active spawns (~30-60s window)
- `feature/founder-overview-redesign` branch not yet merged to master
