# EA Controlled Inbound Email Design

**Date:** 2026-06-08
**Status:** Approved

## Problem

EA agent autonomously creates issues and clients when processing inbound emails. This causes noise — stale backlog emails spawn unwanted issues, and the operator loses control over what enters the system.

## Goal

EA becomes a reader/router for inbound email. Only the operator creates new issues and clients — either by instructing the EA via Telegram or acting directly in the UI.

## Design

### Section 1: MCP Tool Restrictions

Three MCP tools blocked when `isOperator=false`:

| Tool | Guard added |
|------|-------------|
| `create_issue` | `if (!isOperator) return "Error: issue creation requires operator authorization. Use notify_operator instead."` |
| `create_client` | Same |
| `create_project` | Same |

`create_contact` remains open — low-risk, EA needs it for contact upserts.

The orchestrator already sets `isOperator=true` for Telegram (operator) and `isOperator=false` for inbound client emails. No token schema changes needed.

### Section 2: EA Inbound Email Flow

```
inbound email arrives
  → tryContinueThread() — existing issue match via References/In-Reply-To?
      YES → add comment + wake assignee  (no change)
      NO  → check client match
            match found → notify_operator: "Email from {client} — no open issue. Create one or label it."
            no match    → notify_operator: "Unknown sender {from} — no client match. Create issue, label, or block."
            → STOP. EA does nothing else.
```

EA system prompt updated with explicit rule:

> For inbound emails where no existing issue is found, call `notify_operator` and stop. Do not call `create_issue`, `create_client`, or `create_project`.

Operator then acts via Telegram or UI:
- "Create issue: {title}" → EA creates it (runs under `isOperator=true`)
- Labels email → label flow (Section 3)
- Ignores it → email stays unmatched, no issue created

### Section 3: Email Label System

#### Data model

**New table: `email_label_definitions`**
```
id          uuid PK
companyId   uuid FK → companies.id
name        varchar(80) NOT NULL
color       varchar(7)  NOT NULL  -- hex color e.g. "#e74c3c"
createdAt   timestamptz DEFAULT now()
UNIQUE(companyId, name)
```

**New column on `email_messages`:**
```
label  varchar(80)  -- nullable, stores label name as snapshot (no FK — intentional: renaming a label definition does not retroactively change existing email labels)
```

#### New MCP tool: `label_email`

```typescript
label_email(emailId: string, label: string, companyId?: string)
```

1. Sets `email_messages.label = label`
2. Sets `email_messages.processingState = "ignored"`
3. Sends follow-up Telegram: `"Labeled as '{label}'. Block all future emails from {domain}? Reply 'yes' or 'no'."`
4. Operator replies "yes" → EA calls existing `block_sender_domain` tool (relies on Claude session resume for context — orchestrator already persists `claudeSessionId`)
5. Operator replies "no" → done

#### Telegram labeling

Operator replies to no-match notification with a label name (e.g. "spam", "marketing"). EA recognises this as a label instruction and calls `label_email`. Same flow as above.

#### UI labeling

- Email message detail page: label dropdown (populated from `email_label_definitions`)
- Separate "Block domain" button (explicit, not auto-triggered from label)
- Settings → Email Labels page: CRUD for `email_label_definitions` (name + color picker)

### Section 4: Sub-issue Suggestions + Operator-triggered Creation

#### Sub-issue suggestions

EA can suggest sub-issues for existing issues via the existing `create_plan` tool with `kind="create_issue"`. Routes through the approval gate — operator approves in `/governance/plans`, issue is created. No new code needed.

#### Operator-triggered via Telegram

When operator sends "Create issue for the email about X":
- Orchestrator runs with `isOperator=true`
- EA calls `create_issue` with optional `sourceEmailMessageId`
- On creation, if `sourceEmailMessageId` provided: stamp `email_messages.issueId` and flip `processingState → "plan_proposed"`

**Change to `create_issue` tool:** Add optional `sourceEmailMessageId` param. If present, update `email_messages` row to link issue.

#### Operator-triggered via UI

Email detail page gets a "Create Issue" button. Pre-fills title from email subject and description from body. No backend change — uses existing issue creation API. On save, client stamps `emailMessageId` via `PATCH /api/email-messages/:id` or passes it in the create request.

## Files Affected

| File | Change |
|------|--------|
| `packages/db/src/schema/email-messages.ts` | Add `label` column |
| `packages/db/src/schema/` | New `email_label_definitions.ts` table |
| `packages/db/src/schema/index.ts` | Export new table |
| `server/src/routes/mcp-tool-server.ts` | Guard `create_issue`, `create_client`, `create_project`; add `label_email` tool; add `sourceEmailMessageId` to `create_issue` |
| `server/src/services/email-processor.ts` | Update EA inbound flow to notify-and-stop on no-match |
| `server/src/services/orchestrator.ts` | Append hardcoded inbound-restriction block to system prompt when `!isOperator` (code change, not DB config) |
| `ui/src/` | Email detail page: label dropdown + block button + create issue button; Settings: email labels CRUD |
| DB migration | `pnpm db:generate` after schema changes |

## Out of Scope

- Rate-limiting / dedup on `notifyStorageNotConfigured` (separate issue)
- Bulk email backlog review UI
- Agent-triggered issue creation for non-email workflows (heartbeat agents unaffected)
