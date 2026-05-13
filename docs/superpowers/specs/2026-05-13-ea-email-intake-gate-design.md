# EA Email Intake Gate — Design Spec

**Goal:** Inbound emails routed to the Executive Agent no longer auto-create issues. The EA scores each email and proposes an issue only when warranted. The operator approves or rejects before any issue exists.

**Architecture:** The email processor detects when the resolved triage agent has `adapterType = "ea"` and skips the existing `createTriageIssue` path. Instead it wakes the EA with `{ emailMessageId }` as payload. The EA reads the email, checks for a prior thread issue, scores, and either archives to memory or proposes an issue via the plan-gate. Approval creates the issue and wakes the specialist. Client-agent email flows are unchanged.

**Tech Stack:** Express 5, Drizzle ORM, PGlite/Postgres, existing heartbeat wakeup queue, existing plan-gate service, MCP tool server.

---

## Flows

### New email — no prior thread issue

1. Email arrives → `email_messages` row created, `issue_id = null` (unchanged)
2. `email-processor.ts` resolves `triageAgentId` → queries `agents` table for `adapterType`
3. `adapterType === "ea"` → skip `createTriageIssue`, call `heartbeat.enqueueWakeup(eaAgentId, { source: "assignment", reason: "email-triage", payload: { emailMessageId } })`
4. EA wakes, calls `get_email_message(emailMessageId)`
   - Returns: `fromAddr`, `subject`, `body`, `receivedAt`, `attachmentSummaries`, `threadHistory` (prior emails in thread), `existingIssueId: null`
5. EA calls `search_memory(senderIdentifier=fromAddr)` for prior context
6. EA scores 0–100 using existing importance scoring rubric
7. **Score < 60** → `create_memory(passive)`, stop
8. **Score ≥ 60**:
   - `search_topics` → `create_topic` if no match
   - `create_plan(emailMessageId, title, proposalText, assigneeAgentId)` → stores plan with `sourceEmailMessageId`, notifies operator on Telegram
9. **Operator approves** → `executePlan()` runs:
   - Creates issue, assigns to `assigneeAgentId`
   - `UPDATE email_messages SET issue_id = <newIssueId> WHERE id = <emailMessageId>`
   - `heartbeat.enqueueWakeup(assigneeAgentId, { source: "assignment", reason: "plan-approved", payload: { issueId } })`
10. **Operator rejects** → plan marked rejected in DB, no issue created, no further action

### Reply email — existing thread issue found

1. Same routing: `adapterType === "ea"` → wake EA with `{ emailMessageId }`
2. EA calls `get_email_message(emailMessageId)`
   - Tool queries thread via `inReplyTo` / `references` / thread key → finds prior email with `issue_id` set → returns `existingIssueId`
3. EA calls `get_issue_context(existingIssueId)` → returns issue details, comments, linked emails, attachment metadata
4. EA understands full context, adds a comment to the issue summarising the new email via `update_issue`
5. EA calls `update_issue` to set status → `"in_progress"` — assignee picked up on next heartbeat cycle (no explicit wake tool exists; immediate wake is a future enhancement)
6. If `thread_reply_received` enabled in notification matrix → `notify_operator`
7. `UPDATE email_messages SET issue_id = <existingIssueId> WHERE id = <newEmailMessageId>`

### Non-EA triage agent (unchanged)

- `adapterType !== "ea"` → existing path: `createTriageIssue`, wake agent with `{ issueId, emailMessageId }` in payload
- `list_issue_emails(issueId)` still used by client agents

---

## Components

### `server/src/services/email-processor.ts`

In `routeInbound()`, after resolving `triageAgentId`:

```typescript
const triageAgent = await db.select({ adapterType: agents.adapterType })
  .from(agents).where(eq(agents.id, triageAgentId)).limit(1);

if (triageAgent[0]?.adapterType === "ea") {
  // New path: skip triage issue, wake EA directly
  await heartbeatService(db).enqueueWakeup(triageAgentId, {
    source: "assignment",
    reason: "email-triage",
    payload: { emailMessageId: emailMessage.id },
    requestedByActorType: "system",
    requestedByActorId: "email-processor",
  });
  return; // done
}
// existing path continues below...
```

### MCP Tool: `get_email_message` (new)

**Input:** `{ emailMessageId: string }`

**Returns:**
```typescript
{
  id: string;
  fromAddr: string;
  subject: string | null;
  body: string;
  receivedAt: string;
  attachmentSummaries: Array<{ filename: string; contentType: string; sizeBytes: number }>;
  threadHistory: Array<{ id: string; fromAddr: string; subject: string | null; body: string; receivedAt: string; issueId: string | null }>;
  existingIssueId: string | null; // set if any thread email has issue_id
}
```

**Implementation:**
1. Fetch `email_messages` row by `emailMessageId`
2. Find thread peers: query `email_messages` WHERE `thread_key = row.thread_key` AND `email_account_id = row.email_account_id` ORDER BY `received_at ASC`
3. `existingIssueId` = first non-null `issue_id` found across thread peers
4. Return assembled object

### MCP Tool: `get_issue_context` (new)

**Input:** `{ issueId: string }`

**Returns:**
```typescript
{
  issue: { id: string; identifier: string; title: string; description: string; status: string; priority: string; assigneeId: string | null };
  comments: Array<{ id: string; body: string; authorType: string; createdAt: string }>;
  emails: Array<{ id: string; fromAddr: string; subject: string | null; body: string; receivedAt: string; attachmentSummaries: Array<{ filename: string; contentType: string; sizeBytes: number }> }>;
}
```

**Implementation:** JOIN issues + issue_comments + email_messages (WHERE issue_id = issueId)

### MCP Tool: `create_plan` (updated)

`issueId` becomes optional. New optional params: `emailMessageId`, `assigneeAgentId`, `title`.

When `emailMessageId` provided (no `issueId`): routes to `planGateService.proposePlan()` with:
- `kind: "create_issue"`
- `sourceEmailMessageId: emailMessageId`
- `assigneeAgentId`
- `proposalText`

`planGateService.proposePlan()` already supports `sourceEmailMessageId` and `assigneeAgentId`. The readiness gate (clientId/projectId/DoD required for `create_issue`) is relaxed for EA-sourced plans — EA may not have clientId/projectId at scoring time; these can be populated after approval or by the specialist agent.

Telegram notification includes: email subject, sender, proposed issue title, EA's reasoning summary.

### `server/src/services/plan-gate.ts` — `executePlan()` (updated)

After creating issue on `kind = "create_issue"` approval:

```typescript
// Link source email to new issue
if (plan.sourceEmailMessageId) {
  await db.update(emailMessages)
    .set({ issueId: newIssue.id })
    .where(eq(emailMessages.id, plan.sourceEmailMessageId));
}

// Wake assignee
if (plan.assigneeAgentId) {
  await heartbeatService(db).enqueueWakeup(plan.assigneeAgentId, {
    source: "assignment",
    reason: "plan-approved",
    payload: { issueId: newIssue.id },
    requestedByActorType: "system",
    requestedByActorId: "plan-gate",
  });
}
```

### `ui/src/pages/founder/FounderSettings.tsx`

Add `thread_reply_received` to `EaNotificationChannelConfig` interface and `EA_NOTIFICATION_LABELS`:

```typescript
thread_reply_received: "Thread reply received",
```

Default: `false` (opt-in, reduces noise).

### `server/src/onboarding-assets/ea-operator/AGENTS.md`

Update email triage section:

```markdown
## Email triage
When woken with payload { emailMessageId }:
1. Call get_email_message(emailMessageId) — read email, thread history, check existingIssueId
2. If existingIssueId set:
   - Call get_issue_context(existingIssueId) to read full issue history
   - Add comment to issue summarising new email
   - Call update_issue to add comment and set status in_progress (assignee woken on next heartbeat)
   - Notify operator if thread_reply_received enabled in matrix
   - Stop — do NOT create new issue or plan
3. If no existingIssueId:
   - Use fromAddr as senderIdentifier for search_memory
   - Score and classify as normal
   - If score < 60: create_memory(passive), stop
   - If score ≥ 60: search_topics → create_topic if needed → create_plan(emailMessageId, title, proposalText, assigneeAgentId)
```

---

## What does NOT change

- Client-agent email flow (`adapterType !== "ea"`) — triage issue auto-created as before
- `list_issue_emails` tool — still used by client agents and legacy EA conversations
- Telegram / WhatsApp inbound flow
- `plans` and `approvals` DB schema — no migrations needed
- Existing notification matrix events

---

## Error handling

- EA woken but `emailMessageId` not found in DB → EA logs error, calls `notify_operator` with "email-triage failed: message not found"
- `create_plan` called without sufficient context → EA must gather more before proposing (call `search_contacts`, `search_clients` first)
- `executePlan` assignee agent not found → issue created unassigned, operator notified

---

## Testing

- Unit: `email-processor` routing branch — assert no issue created when `adapterType === "ea"`, assert wakeup enqueued with correct payload
- Unit: `get_email_message` — returns thread history, detects `existingIssueId` from thread peers
- Unit: `get_issue_context` — returns issue + comments + emails
- Unit: `executePlan` — assert `email_messages.issue_id` updated and assignee woken on approval
- Integration: full flow — email in → EA woken → plan created → approval → issue + wakeup
- Integration: reply flow — email reply in → EA woken → existing issue found → comment added
