# Direct Chat Implementation Design

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this spec task-by-task.

**Goal:** Add a per-company chat page where the operator can have real-time conversations with any agent or room, bypassing the issue/comment UI entirely.

**Architecture:** Thin layer over the existing `operator_messages` system. Two new DB columns and one new table. WebSocket live events for real-time delivery. No new routing engine — `operator-messaging.ts` handles dispatch as-is.

**Tech Stack:** React + TanStack Query + existing WebSocket (`live-events-ws.ts`) + Drizzle ORM + Express

---

## 1. Data Model

### New table: `chat_threads`

```ts
// packages/db/src/schema/chat_threads.ts
export const chatThreads = pgTable("chat_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

- `agentId = null` → Dispatcher thread (one per company, auto-created on first chat visit; unique constraint on `(companyId)` where `agentId IS NULL`)
- `agentId = <uuid>` → per-agent thread (created lazily when agent first replies via chat; unique on `(companyId, agentId)`)

### Changes to `operator_messages`

Add two columns:

```ts
source: text("source").notNull().default("email"), // "chat" | "email" | "telegram"
chatThreadId: uuid("chat_thread_id").references(() => chatThreads.id, { onDelete: "set null" }),
contextRefs: jsonb("context_refs").$type<ContextRef[]>(), // nullable
```

```ts
interface ContextRef {
  type: "issue" | "project" | "client";
  id: string;
  label: string;
}
```

### New live event types (constants.ts)

```ts
"chat.message.new"   // emitted on every operator_message insert where source = "chat"
"chat.agent.typing"  // emitted when heartbeat run starts for chat-originated issue
"chat.agent.done"    // emitted when that run completes
```

---

## 2. Routing & Dispatch

No new dispatcher agent entity. The existing `operator-messaging.ts` `handleInbound()` handles all routing.

**Inbound flow:**
1. Operator posts message → `POST /api/companies/:id/chat/messages`
2. Server resolves or creates Dispatcher `chat_thread` (agentId = null)
3. Inserts inbound `operator_message` with `source: "chat"`, `chatThreadId`, `contextRefs`
4. Calls `operatorMessagingService.handleInbound({ platform: "chat", body, threadKey: chatThreadId, contextRefs })`
5. Existing routing: `@alice` → Alice, `#engineering` → room broadcast, no mention → role-based routing (CEO agent)
6. Heartbeat wakes target agent(s), emits `chat.agent.typing`

**Outbound flow (agent replies):**
1. Agent calls `sendToOperator()` (unchanged tool)
2. `sendToOperator` detects `platform: "chat"` from the originating `message_thread`
3. Inserts outbound `operator_message` with `source: "chat"`, `chatThreadId`
4. Resolves or creates per-agent `chat_thread` for that agent
5. Emits `chat.message.new` live event
6. Run completes → emits `chat.agent.done`

**Promote to issue:** button on any agent message → opens "New Issue" dialog pre-filled with message body. The backing issue already exists (created by handleInbound); this just surfaces a link to it in the UI.

**contextRefs in agent prompt:** when `contextRefs` is non-empty, prepend to agent system prompt:
```
Operator is referring to:
- Issue #123: Login bug (jwt expiry check)
- Project: Mobile App v2
```

---

## 3. Thread Model

**Dispatcher thread** (agentId = null):
- Auto-created on first visit to `/chat`
- Shows ALL chat messages for the company (union view) — every inbound and every agent reply
- Sorted by `createdAt` ascending

**Per-agent thread** (agentId = agent):
- Created lazily when an agent first replies via chat
- Shows only messages where `fromAgentId = agentId` (that agent's replies only)
- Filter: `operator_messages WHERE source = "chat" AND fromAgentId = agentId`
- Original operator messages that triggered the agent remain visible in Dispatcher thread for context

**Sidebar order:**
1. Dispatcher (always pinned top)
2. Per-agent threads (sorted by latest message desc, unread badge on new messages)
3. Rooms (existing rooms list, navigates to existing RoomDetail page)

---

## 4. Mention System

Autocomplete popup triggers on `@`, `#`, `$` in the message composer.

| Trigger | Searches | Behaviour |
|---------|----------|-----------|
| `@name` | agents by name | routes to that agent |
| `#slug` | rooms by slug | broadcasts to room |
| `$issue:query` | issues by title/id | attaches as `contextRef` |
| `$project:query` | projects by name | attaches as `contextRef` |
| `$client:query` | clients by name | attaches as `contextRef` |

- `@` and `#` affect routing (passed through to `handleInbound` body as-is — existing parser handles them)
- `$` mentions strip from body text and are stored in `contextRefs` array only
- Autocomplete: client-side fuzzy match against existing REST APIs, keyboard nav, Enter to select
- Selected `$` context tags render as chips above the composer input (dismissible)

---

## 5. UI Structure

### Route

`/${prefix}/chat` — added to `boardRoutes()` in App.tsx and `BOARD_ROUTE_ROOTS` in company-routes.ts

### Components

```
ui/src/pages/Chat.tsx                  — page shell, thread sidebar + outlet
ui/src/components/chat/ChatSidebar.tsx — thread list (Dispatcher + agents + rooms)
ui/src/components/chat/ChatThread.tsx  — message list for a thread
ui/src/components/chat/ChatComposer.tsx — input with mention autocomplete + context tags
ui/src/components/chat/ChatMessage.tsx — single message bubble (inbound/outbound)
ui/src/components/chat/MentionPopup.tsx — @/#/$ autocomplete dropdown
ui/src/hooks/useChatMessages.ts        — REST initial load + WebSocket append
ui/src/hooks/useChatTyping.ts          — typing indicator state from WebSocket
ui/src/api/chat.ts                     — API client methods
```

### Layout

Two-panel: `ChatSidebar` (180px fixed) + `ChatThread` (flex-1). No nested router — thread selection is local state in `Chat.tsx` (selected `chatThreadId`).

### Message bubbles

- Operator messages: right-aligned, indigo background
- Agent messages: left-aligned, dark background, agent name + colour dot above
- Typing indicator: animated dots under agent name while `chat.agent.typing` active
- "view issue →" link on agent messages (links to `/issues/:id`)

---

## 6. Real-time

Reuses existing WebSocket at `/api/companies/:companyId/events/ws`.

**`chat.message.new` payload:**
```ts
{
  type: "chat.message.new",
  message: {
    id, body, direction, fromAgentId, agentName,
    chatThreadId, contextRefs, createdAt
  }
}
```

**`chat.agent.typing` payload:**
```ts
{ type: "chat.agent.typing", agentId, agentName, chatThreadId }
```

**`chat.agent.done` payload:**
```ts
{ type: "chat.agent.done", agentId, chatThreadId }
```

`useChatMessages(threadId)`:
1. Initial load: `GET /api/companies/:id/chat/threads/:threadId/messages`
2. Subscribe to WebSocket; on `chat.message.new` where `message.chatThreadId === threadId`, append to list
3. No polling

`useChatTyping(threadId)`:
- Maintains `Map<agentId, agentName>` of currently-typing agents
- Adds on `chat.agent.typing`, removes on `chat.agent.done`

---

## 7. Backend Routes

```
POST   /api/companies/:companyId/chat/threads           — get-or-create Dispatcher thread
GET    /api/companies/:companyId/chat/threads           — list all threads (sidebar)
GET    /api/companies/:companyId/chat/threads/:id/messages — paginated messages (limit 50)
POST   /api/companies/:companyId/chat/messages          — send operator message
```

Auth: all routes require board session (operators only). Agents do not post to chat directly — they use `sendToOperator()` tool as before.

---

## 8. Out of Scope

- Token-by-token streaming (backlog — requires adapter layer refactor)
- Founder profile / cross-company chat (separate spec)
- File/image attachments in chat
- Message editing or deletion
- Read receipts
- Push notifications to phone (separate channel concern)
