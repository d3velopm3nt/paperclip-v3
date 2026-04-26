# Operator Messaging System — Design Spec

**Date:** 2026-04-26
**Status:** Approved, pending implementation
**Scope:** Phase 1 (email). Telegram + SMS in subsequent phases.

---

## Problem

Operators have no direct way to message agents or groups of agents ad-hoc. Agents have no standard way to proactively reach operators mid-task. The only current communication path is the plan-gate approval email, which is too rigid for general collaboration.

---

## Goal

Build a unified, platform-agnostic operator↔agent messaging system where:
- Operator emails agent_voice (or later Telegram/SMS) to send instructions, questions, or updates to any agent or room of agents.
- Agents proactively reach the operator when blocked or need a decision — via `@operator` in comments or a direct API call.
- Every conversation is backed by a Paperclip issue for full audit trail + UI visibility.
- Rooms are first-class configurable entities: named groups of agents the operator can broadcast to.

---

## Architecture

```
Operator                    Platform Layer              Routing Engine           Paperclip
──────────                  ──────────────              ──────────────           ─────────
email agent_voice    ──▶    EmailAdapter                MentionParser            rooms table
Telegram (phase 2)   ──▶    TelegramAdapter   ──▶      ContentRouter    ──▶     operator_messages
SMS (phase 3)        ──▶    SmsAdapter                  AgentResolver            issues (backing record)
                                ▼
                    OperatorMessageService
                    (platform-agnostic core)
                                │
                    ┌───────────┴────────────┐
                    ▼                        ▼
              Route to agent          Route to room
              (create issue,          (fan out to members,
               wake agent)            all agents notified)
```

`OperatorMessageService` is the platform-agnostic core. Adapters translate raw platform payloads into a normalized `InboundMessage` shape. The service never imports a specific adapter — always resolves via `MessageAdapterRegistry` by platform key.

---

## Data Model

### New Tables

```sql
-- Configurable rooms (e.g. "Dev Team", "CEO Direct", "All Hands")
rooms
  id uuid PK
  company_id uuid FK companies
  name text                             -- "Dev Team"
  slug text UNIQUE per company          -- "dev-team" (used in @room-slug mentions)
  description text
  require_approval bool DEFAULT false   -- plan-gate toggle per room
  created_at timestamptz
  updated_at timestamptz

-- Agents (+ operator seat) in a room
room_members
  id uuid PK
  room_id uuid FK rooms ON DELETE CASCADE
  agent_id uuid FK agents (nullable)
  is_operator bool DEFAULT false        -- true = operator notification seat
  notify_on_message bool DEFAULT true

-- Every message in/out, any platform
operator_messages
  id uuid PK
  company_id uuid FK companies
  room_id uuid FK rooms (nullable)      -- null = direct thread (no room)
  issue_id uuid FK issues (nullable)    -- backing Paperclip record
  direction enum(inbound, outbound)
  platform enum(email, telegram, sms, internal)
  from_agent_id uuid FK agents (nullable)  -- null = from operator
  body text
  raw_payload jsonb                     -- original platform payload for debugging
  created_at timestamptz

-- Per-platform thread context (keeps reply chains intact)
message_threads
  id uuid PK
  operator_message_id uuid FK operator_messages
  platform enum(email, telegram, sms)
  thread_key text  -- email Message-ID, Telegram chat_id:thread_id, etc.
```

### Existing Tables Used

| Table | Role |
|-------|------|
| `issues` | Backing record for every conversation thread |
| `issue_comments` | Agent + operator replies, visible in Paperclip UI |
| `agent_wakeup_requests` | Routing triggers for waking agents |
| `email_accounts` | agent_voice account used as email transport |

---

## Message Routing Engine

`OperatorMessageService.handleInbound(msg: InboundMessage)` flow:

```
1. PARSE MENTIONS
   Scan subject + body for @agent-name and @room-slug patterns.

2. ROUTE DECISION
   ├─ @agent-name found ──▶ direct route
   │                         find agent by name/shortname
   │                         wake immediately (no plan-gate — operator intent is explicit)
   │                         create issue if no existing thread
   │
   ├─ @room-slug found ───▶ room route
   │                         fan-out: wake all room member agents
   │                         shared issue as anchor, all agents see same context
   │
   ├─ reply to existing ──▶ continue thread
   │   thread?               attach to existing issue as comment
   │                         wake assigned agent
   │
   └─ no mention, no ─────▶ auto-route
       thread                inline content classification in OperatorMessageService:
                             simple keyword match on agent roles first (fast, free)
                             if ambiguous: single Claude Haiku call with agent roster
                             pick best-fit agent by role match
                             fallback: CEO agent always

3. ISSUE RESOLUTION (agent responsibility, not routing engine)
   Agent checks existing issues before creating new one:
     GET /api/companies/:id/issues?status=todo,in_progress&search=<keywords>
   If related issue found → link as sub-issue or add comment
   If none → create new issue
   Agent always reports back: "Found existing issue #42 — linked your request."

4. OPERATOR REPLY PATH (outbound)
   Agent posts @operator comment on issue
     → issue_comments hook detects @operator mention
     → OperatorMessageService.sendToOperator(...)
     → resolves platform adapter from message_threads.platform
     → sends on same thread (email reply-chain, Telegram reply, etc.)
   OR agent calls POST /api/companies/:id/operator-messages directly
```

---

## Platform Adapter Layer

```typescript
interface MessagePlatformAdapter {
  platform: "email" | "telegram" | "sms";
  parse(raw: unknown): Promise<InboundMessage>;
  send(msg: OutboundMessage): Promise<{ threadKey: string }>;
  reply(threadKey: string, body: string, html?: string): Promise<void>;
}

interface InboundMessage {
  platform: "email" | "telegram" | "sms";
  from: string;           // email addr / telegram user_id / phone
  body: string;
  subject?: string;
  threadKey?: string;
  attachments?: Attachment[];
  raw: unknown;
}

interface OutboundMessage {
  to: string[];
  body: string;
  html?: string;
  subject?: string;
  threadKey?: string;
}
```

**Phase 1 — EmailAdapter:**
- Wraps existing `sendEmailFromAccount` + IMAP polling
- `parse()` converts `email_messages` row → `InboundMessage`
- `reply()` sets `inReplyTo` + `references` headers to preserve chain
- Inbound trigger: `routeOperatorReply` in `email-processor.ts` — currently ignores untagged messages. Extended to call `OperatorMessageService.handleInbound()` instead.

**Phase 2 — TelegramAdapter:**
- Uses existing Telegram MCP plugin tools
- `parse()` converts Telegram message event → `InboundMessage`
- `reply()` uses `mcp__plugin_telegram_telegram__reply`

**Phase 3 — SmsAdapter:**
- Twilio or similar. Plain text only, no HTML.

Adapters registered in `MessageAdapterRegistry`. No direct imports in the service layer.

---

## Agent-Side Integration

### Surface 1 — `@operator` in issue comments (passive, context-aware)

Agent posts: `@operator: Found two conflicting implementations — which should I extend?`

- After `POST /issues/:id/comments` succeeds in the issues route, scan body for `@operator` pattern
- If found: call `OperatorMessageService.sendToOperator(issueId, agentId, body)` (fire-and-forget, failures logged not thrown)
- Platform adapter sends on the same thread the operator used to initiate conversation (looked up via `message_threads` by `issue_id`)
- If no prior thread exists (agent-initiated first contact): send as new email to company `ownerEmail` via agent_voice
- Operator reply routes back as issue comment, wakes agent

### Surface 2 — `send_operator_message` API (active, standalone)

```
POST /api/companies/:id/operator-messages
Authorization: Bearer $PAPERCLIP_API_KEY
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID

{
  "body": "Need a decision: extend heroes form or replace it?",
  "issueId": "<current issue>",    // thread anchor (optional)
  "roomId": "<room id>",           // fan-out to room (optional)
  "urgent": false                  // true = immediate notification
}
```

### Universal Agent Rule (AGENTS.md + default instructions)

```
## Operator Communication

If you need operator input, are blocked, or want to report progress mid-task:

1. Post a comment with `@operator: <message>` on the current issue (preferred
   when the context is issue-related).
2. Call POST /api/companies/{companyId}/operator-messages (preferred for
   standalone messages or broadcasting to a room).

Rules:
- Never stay silently blocked. Surface blockers in the same heartbeat they are discovered.
- Before creating a new issue from an operator message, search existing issues
  for related work. Link rather than duplicate.
- @agent-name messages from the operator require no plan-gate approval — act immediately.
```

---

## Rooms UI

### `/rooms` — Room List

Sidebar location: **Communications → Rooms** (below Email Inbox).

```
┌─────────────────────────────────────────┐
│ Rooms                          [+ New]  │
├─────────────────────────────────────────┤
│ # dev-team        3 agents  ● active    │
│ # ceo-direct      1 agent   ● active    │
│ # all-hands       5 agents  ● active    │
└─────────────────────────────────────────┘
```

### `/rooms/:id` — Room Detail + Thread

```
┌─────────────────────────────────────────┐
│ # dev-team                    [Edit]    │
│ "Development team discussions"          │
├─────────────────────────────────────────┤
│ Members                                 │
│  ● CEO Agent                  [remove]  │
│  ● Dev Agent                  [remove]  │
│  [+ Add agent]                          │
│                                         │
│ Settings                                │
│  Require approval  [ OFF ]              │
│  Notify on message [ ON  ]              │
│                                         │
│ How to reach this room:                 │
│  Email: reply to agent_voice with       │
│         @dev-team anywhere in body      │
├─────────────────────────────────────────┤
│ Thread                                  │
│  [operator] Add waiting list field...   │
│  [CEO]      Found issue #42, linked.    │
│  [Dev]      Started on heroes form...   │
└─────────────────────────────────────────┘
```

Thread view shows chronological messages across all participants. Each entry shows: sender, platform badge (email/telegram), timestamp, link to backing issue.

---

## API Routes (Phase 1)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies/:id/rooms` | List rooms |
| POST | `/api/companies/:id/rooms` | Create room |
| GET | `/api/rooms/:id` | Get room + members |
| PATCH | `/api/rooms/:id` | Update room config |
| DELETE | `/api/rooms/:id` | Delete room |
| POST | `/api/rooms/:id/members` | Add member (agent or operator) |
| DELETE | `/api/rooms/:id/members/:memberId` | Remove member |
| GET | `/api/rooms/:id/messages` | Get room message thread |
| POST | `/api/companies/:id/operator-messages` | Send message (agent or UI) |
| GET | `/api/companies/:id/operator-messages` | List messages (filtered) |

---

## What Changes in Existing Code

| File | Change |
|------|--------|
| `email-processor.ts` | `routeOperatorReply` — untagged messages call `OperatorMessageService.handleInbound()` instead of ignoring |
| `issue_comments` insert | Detect `@operator` pattern → trigger `sendToOperator` |
| `default-agent-instructions.ts` | Add operator communication rule |
| `AGENTS.md` (skills) | Add `communicate` section to `paperclip` + `paperclip-ops` skills |
| `Sidebar.tsx` | Add Rooms link under Communications |

---

## Phase Breakdown

| Phase | Scope |
|-------|-------|
| **1 (now)** | DB schema, OperatorMessageService, EmailAdapter, routing engine, rooms CRUD API, rooms UI, agent skill updates, AGENTS.md rule |
| **2** | TelegramAdapter — connects existing Telegram MCP plugin |
| **3** | SmsAdapter (Twilio), urgent notifications, per-message read receipts |

---

## Out of Scope (this spec)

- End-to-end encryption of message content
- Operator-to-operator messaging (not applicable, single operator model)
- Message search / full-text indexing
- File/image attachments in rooms UI (stored in raw_payload, not displayed yet)
