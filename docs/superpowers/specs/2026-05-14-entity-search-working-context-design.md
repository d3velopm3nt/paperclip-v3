# Entity Search & Operator Working Context

**Date:** 2026-05-14  
**Status:** Approved  
**Scope:** Operator ↔ EA agent comms only. Client messages unaffected.

---

## Problem

The EA agent (Claude) cannot resolve partial or casual entity references like "Rockdog" or "the footer issue" without either guessing or asking the operator repeatedly. Each Telegram message arrives without knowledge of which company/client/project/issue the operator is focused on, causing repetitive clarification questions and context loss between turns.

---

## Goals

1. Fuzzy entity search with typo tolerance across all major entity types
2. Persistent working context scoped to the current EA topic
3. Natural "switch to X" command with no friction
4. Agent uses stored context automatically — no re-lookup on every message

---

## Non-Goals

- Client-facing messages (unaffected by this change)
- Full audit history of context switches (future: Phase C — dedicated table)
- Automatic entity extraction from every message (agent decides when to search)

---

## Architecture

```
Operator Telegram message
        ↓
Orchestrator reads working context from current topic metadata
Injects it at top of operator prompt
        ↓
Claude receives prompt with [Working Context] + [message]
        ↓
If context missing or operator references something new:
  Claude calls search_entities("Rockdog") or switch_context("Rockdog")
        ↓
Server runs pg_trgm similarity query across 6 entity tables
FK chain resolved server-side: project → client → company
Returns ranked, fully-resolved matches
        ↓
Claude calls set_working_context({companyId, clientId, projectId, issueId, topicId, ...})
Stored in topics.workingContext JSONB column
        ↓
If no matching topic exists: Claude creates topic, links to issue/client
        ↓
Next operator message: orchestrator injects stored context automatically
Claude acts directly using stored IDs — no re-search needed
```

---

## Database Changes

### 1. Enable pg_trgm extension

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 2. Add GIN indexes for trigram search

```sql
CREATE INDEX idx_companies_name_trgm   ON companies   USING GIN (name gin_trgm_ops);
CREATE INDEX idx_clients_name_trgm     ON clients     USING GIN (name gin_trgm_ops);
CREATE INDEX idx_projects_name_trgm    ON projects    USING GIN (name gin_trgm_ops);
CREATE INDEX idx_issues_title_trgm     ON issues      USING GIN (title gin_trgm_ops);
CREATE INDEX idx_topics_name_trgm      ON topics      USING GIN (name gin_trgm_ops);
CREATE INDEX idx_contacts_name_trgm    ON contacts    USING GIN ((first_name || ' ' || last_name) gin_trgm_ops);
```

### 3. Add `workingContext` column to topics

```sql
ALTER TABLE topics ADD COLUMN working_context jsonb;
```

**Shape:**
```json
{
  "companyId": "aaa", "companyName": "Develtech",
  "clientId":  "bbb", "clientName":  "Rockdog",
  "projectId": "ccc", "projectName": "Rockdog Website",
  "issueId":   "ddd", "issueIdentifier": "DEV-12", "issueTitle": "Update footer email",
  "topicId":   "eee", "topicName": "Rockdog",
  "notes": "focusing on footer email task",
  "updatedAt": "2026-05-14T19:00:00Z"
}
```

Any field may be null/absent. Agent sets only what it has resolved.

---

## New MCP Tools

### `search_entities`

Search across entity types using pg_trgm similarity (threshold 0.2). Returns ranked, FK-resolved results. Used when agent needs to inspect matches before acting.

**Input:**
```typescript
{
  query: string,
  types?: Array<"company" | "client" | "project" | "issue" | "topic" | "contact">
  // default: all types
}
```

**Output:** Array sorted by score desc, max 5 per type:
```json
[
  {
    "type": "client",
    "id": "bbb",
    "name": "Rockdog",
    "score": 1.0,
    "company": { "id": "aaa", "name": "Develtech" }
  },
  {
    "type": "project",
    "id": "ccc",
    "name": "Rockdog Website",
    "score": 0.8,
    "client": { "id": "bbb", "name": "Rockdog" },
    "company": { "id": "aaa", "name": "Develtech" }
  },
  {
    "type": "issue",
    "id": "ddd",
    "name": "DEV-12 — Update footer email",
    "score": 0.6,
    "project": { "id": "ccc", "name": "Rockdog Website" },
    "company": { "id": "aaa", "name": "Develtech" }
  },
  {
    "type": "topic",
    "id": "eee",
    "name": "Rockdog",
    "score": 1.0,
    "status": "active"
  }
]
```

**SQL strategy per type:**
- companies: `name % $query`
- clients: `name % $query`
- projects: `name % $query`
- issues: `title % $query OR identifier ILIKE $query||'%'`
- topics: `name % $query`
- contacts: `(first_name||' '||last_name) % $query OR email ILIKE '%'||$query||'%'`

Issues also searched by identifier prefix (e.g. "DEV-12" exact match bypasses similarity).

---

### `set_working_context`

Persist working context on the current topic. Agent calls this after resolving entities. Any field can be null to clear it.

**Input:**
```typescript
{
  topicId: string,            // required — which topic to store on
  companyId?: string | null,  companyName?: string | null,
  clientId?:  string | null,  clientName?:  string | null,
  projectId?: string | null,  projectName?: string | null,
  issueId?:   string | null,  issueIdentifier?: string | null, issueTitle?: string | null,
  notes?: string | null
}
```

**Returns:** the stored working context object with `updatedAt`.

---

### `switch_context`

Atomic: search by query → auto-pick highest-score match per type → call set_working_context → return confirmation. Used for casual operator commands like "switch to Life" or "now working on Innotrack".

**Input:**
```typescript
{
  query: string,
  topicId: string   // current topic to store context on
}
```

**Server behaviour:**
1. Run same pg_trgm query as `search_entities`
2. For each type, pick the highest-score result
3. Resolve FK chain
4. If results span multiple companies, prefer the company with the most matched entities (majority vote); include a warning in the response
5. Write to `topics.working_context`
6. Return human-readable confirmation

**Output:**
```json
{
  "switched": true,
  "context": {
    "company": "Develtech",
    "client": "Rockdog",
    "project": "Rockdog Website",
    "issue": "DEV-12 — Update footer email",
    "topic": "Rockdog (active)"
  },
  "message": "Switched → Develtech | Rockdog | Rockdog Website | DEV-12"
}
```

If no match found (score below threshold): `{ "switched": false, "message": "No match found for 'X'. Try search_entities to inspect." }`

---

## Orchestrator Changes

### Injection (operator only)

At the top of `buildActiveConversationsContext()`, before topics/conversations:

```
## Working Context
Company:  Develtech (aaa)
Client:   Rockdog (bbb)
Project:  Rockdog Website (ccc)
Issue:    DEV-12 — Update footer email (ddd)
Topic:    Rockdog (eee)
Notes:    focusing on footer email task

Use these IDs directly for all actions. Call search_entities or switch_context only
when the operator references something outside this context.
```

Only injected if `topics.workingContext` is set for the current operator topic. If no topic is active yet, context block is omitted.

### Finding the current topic

The orchestrator needs to determine which topic is "current" for the operator session:
- Use the most recently active EA topic (highest `lastMessageAt`) that has a `workingContext` set
- If none, omit the working context block — agent will set it after calling `resolve_conversation`

---

## Server Route

New route: `GET /api/ea/search`

```
GET /api/ea/search?q=Rockdog&types=client,project,issue,topic
Authorization: Bearer <mcp-token>  (operator token only)
```

Returns the same JSON array as `search_entities` output above. MCP tool is a thin wrapper over this route.

The `set_working_context` and `switch_context` tools map to:
```
PUT /api/ea/working-context
POST /api/ea/switch-context
```

All three routes are operator-token-gated via `isOperator` check in MCP session token middleware.

---

## Agent Instruction Updates

The EA operator agent's instruction file needs a new section:

```
## Entity Resolution

Before creating or modifying any entity, use search_entities or switch_context to
resolve partial names to IDs. Do not guess IDs.

If the operator says "switch to X" or "now working on Y": call switch_context(query, topicId).
If you need to inspect multiple matches before deciding: call search_entities(query).

After resolving, call set_working_context to persist — subsequent messages will have
the context pre-injected and you can act directly without re-searching.
```

---

## Implementation Phases

**Phase A (this spec):** search_entities + set_working_context + switch_context + pg_trgm + topic.workingContext column + orchestrator injection

**Phase C (future):** dedicated `operator_context_history` table — full audit log of every context switch per operator session. Enables replay, debugging, and analytics.

---

## Files Affected

| File | Change |
|------|--------|
| `packages/db/src/schema/topics.ts` | Add `workingContext` jsonb column |
| `packages/db/src/migrations/` | pg_trgm extension + GIN indexes + topics.workingContext |
| `server/src/routes/ea-search.ts` | New route: GET /api/ea/search, PUT /api/ea/working-context, POST /api/ea/switch-context |
| `server/src/routes/mcp-tool-server.ts` | Register 3 new tools: search_entities, set_working_context, switch_context |
| `server/src/services/orchestrator.ts` | Inject workingContext block into operator prompt |
| `server/src/app.ts` (or router index) | Mount new ea-search route |
| EA operator agent instructions file | Add Entity Resolution section |
