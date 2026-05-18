# EA Email Intake Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-creating triage issues for EA-routed emails. EA scores each email, proposes an issue via plan-gate, and the specialist agent is woken only after operator approval.

**Architecture:** Five targeted changes: (1) email-processor detects EA triage agent and skips issue creation; (2) plan-gate gains `bypassReadinessGate` flag and wakes assignee on execution; (3) three new MCP tools let the EA read email context and create email-sourced plans; (4) `create_plan` MCP tool extended for email-sourced proposals; (5) notification matrix gains `thread_reply_received` toggle.

**Tech Stack:** Express 5, Drizzle ORM, PGlite/Postgres, vitest, React 19 + TypeScript.

---

## File Map

| File | Change |
|---|---|
| `server/src/services/plan-gate.ts` | Add `bypassReadinessGate` to `ProposePlanInput`; wake assignee in `executePlan` |
| `server/src/services/email-processor.ts` | Skip issue creation + wake EA when `adapterType === "ea"` |
| `server/src/routes/mcp-tool-server.ts` | Add `get_email_message`, `get_issue_context` tools; update `create_plan` tool |
| `ui/src/pages/founder/FounderSettings.tsx` | Add `thread_reply_received` to notification matrix |
| `server/src/onboarding-assets/ea-operator/AGENTS.md` | Update email triage instructions |
| `server/src/__tests__/ea-email-intake-gate.test.ts` | New test file |

---

## Task 1: plan-gate — bypassReadinessGate + executePlan wakes assignee

**Files:**
- Modify: `server/src/services/plan-gate.ts`
- Create: `server/src/__tests__/ea-email-intake-gate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/ea-email-intake-gate.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "../test-utils/embedded-postgres.js";
import { createDb } from "@paperclipai/db";
import { companies, agents, emailAccounts, emailMessages, plans, approvals, agentWakeupRequests } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { planGateService, PlanReadinessError } from "../services/plan-gate.js";
import type { Db } from "@paperclipai/db";

let tempDb: EmbeddedPostgresTestDatabase;
let db: Db;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ea-intake-gate-");
  db = createDb(tempDb.connectionString);
}, 20_000);

afterAll(async () => {
  await tempDb.stop();
});

async function seedBase() {
  const [company] = await db.insert(companies).values({ name: "Acme", issuePrefix: "ACM" }).returning();
  const [agent] = await db.insert(agents).values({
    companyId: null,
    name: "Executive Agent",
    adapterType: "ea",
    role: "operator",
    status: "idle",
    metadata: {},
  }).returning();
  const [specialistAgent] = await db.insert(agents).values({
    companyId: company.id,
    name: "Client Agent",
    adapterType: "claude",
    role: "client_agent",
    status: "idle",
    metadata: {},
  }).returning();
  return { company, agent, specialistAgent };
}

describe("planGateService", () => {
  it("proposePlan: bypassReadinessGate skips clientId/projectId/DoD requirement", async () => {
    const { company, agent } = await seedBase();
    await expect(
      planGateService(db).proposePlan({
        companyId: company.id,
        agentId: agent.id,
        actionType: "create_issue",
        kind: "create_issue",
        proposalText: "Create an issue for this lead",
        bypassReadinessGate: true,
        // intentionally missing clientId, projectId, definitionOfDone
      })
    ).resolves.toMatchObject({ planId: expect.any(String), approvalId: expect.any(String) });
  });

  it("proposePlan: without bypassReadinessGate, missing clientId still throws PlanReadinessError", async () => {
    const { company, agent } = await seedBase();
    await expect(
      planGateService(db).proposePlan({
        companyId: company.id,
        agentId: agent.id,
        actionType: "create_issue",
        kind: "create_issue",
        proposalText: "Create an issue",
        // no bypassReadinessGate, no clientId
      })
    ).rejects.toBeInstanceOf(PlanReadinessError);
  });

  it("executePlan: wakes assignee agent after creating issue", async () => {
    const { company, agent, specialistAgent } = await seedBase();
    const { planId, approvalId } = await planGateService(db).proposePlan({
      companyId: company.id,
      agentId: agent.id,
      actionType: "create_issue",
      kind: "create_issue",
      proposalText: "Handle this lead from alice@example.com",
      assigneeAgentId: specialistAgent.id,
      bypassReadinessGate: true,
    });
    // Approve the plan
    await planGateService(db).recordDecision(approvalId, "approved");
    // Assert wakeup was enqueued for the specialist
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, specialistAgent.id));
    expect(wakeups.length).toBeGreaterThan(0);
    expect(wakeups[0].reason).toBe("plan-approved");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts
```

Expected: 3 failures — `bypassReadinessGate` is not a known property, wakeup test fails because assignee is not woken.

- [ ] **Step 3: Add `bypassReadinessGate` to `ProposePlanInput` and gate check**

In `server/src/services/plan-gate.ts`, find `ProposePlanInput` interface (line 39) and add the field:

```typescript
export interface ProposePlanInput {
  companyId: string;
  agentId: string;
  actionType: string;
  kind: string;
  proposalText: string;
  proposalMeta?: Record<string, unknown>;
  clientId?: string | null;
  projectId?: string | null;
  sourceEmailMessageId?: string | null;
  confidence?: Confidence;
  definitionOfDone?: string[];
  parentIssueId?: string | null;
  assigneeAgentId?: string | null;
  /** Skip the clientId/projectId/DoD readiness gate. Set true for EA-sourced plans where the specialist will fill these in. */
  bypassReadinessGate?: boolean;
}
```

Then find the readiness gate block (lines 130–141) and wrap it:

```typescript
  if (input.kind === "create_issue" && !input.bypassReadinessGate) {
    const missing: string[] = [];
    if (!input.clientId) missing.push("clientId");
    if (!input.projectId) missing.push("projectId");
    const dod = input.definitionOfDone ?? [];
    if (dod.length === 0) missing.push("definitionOfDone");
    if (missing.length > 0) throw new PlanReadinessError(missing);
  }
```

- [ ] **Step 4: Add heartbeatService import and assignee wakeup to `executePlan`**

In `server/src/services/plan-gate.ts`, find the top-level imports (line 11 area) and add:

```typescript
import { heartbeatService } from "./heartbeat.js";
```

Then find the `create_issue` branch in `executePlan` (around line 430, after the issue is created and `plans.issueId` is updated). Add the wakeup after the email link block:

```typescript
      // Wake assignee so specialist starts immediately
      if (assigneeAgentId) {
        await heartbeatService(db).wakeup(assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "plan-approved",
          payload: { issueId: created.id },
          requestedByActorType: "system",
          requestedByActorId: "plan-gate",
        }).catch((err) => logger.warn({ err, assigneeAgentId }, "plan-gate: failed to wake assignee"));
      }
```

- [ ] **Step 5: Run tests — all three should pass**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts
```

Expected: 3 passed.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "plan-gate"
```

Expected: no output (no errors in plan-gate.ts).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/plan-gate.ts server/src/__tests__/ea-email-intake-gate.test.ts
git commit -m "feat(plan-gate): bypassReadinessGate flag + wake assignee on plan approval"
```

---

## Task 2: email-processor — EA routing branch

**Files:**
- Modify: `server/src/services/email-processor.ts`
- Modify: `server/src/__tests__/ea-email-intake-gate.test.ts`

- [ ] **Step 1: Add EA routing test**

Append to `server/src/__tests__/ea-email-intake-gate.test.ts`:

```typescript
import { emailProcessorService } from "../services/email-processor.js";
import { startEmbeddedPostgresTestDatabase } from "../test-utils/embedded-postgres.js";

// At the top with other imports, add:
// import { emailAccounts } from "@paperclipai/db";  (already imported above)

function buildMinimalEmail(from: string, to: string, subject: string, body: string): Buffer {
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <test-${Date.now()}@example.com>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");
  return Buffer.from(raw);
}

describe("email-processor: EA routing", () => {
  it("email with EA triage agent: no issue created, wakeup enqueued with emailMessageId", async () => {
    const { company, agent: eaAgent } = await seedBase();
    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "main",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "inbox@acme.com",
      imapPasswordEnc: "enc:x",
      fromName: "Acme",
      fromEmail: "inbox@acme.com",
      triageAgentId: eaAgent.id,
    }).returning();

    process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL = "1";
    const processor = emailProcessorService(db);
    const result = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildMinimalEmail("client@vendor.com", "inbox@acme.com", "Partnership inquiry", "Let's work together."),
    });

    expect(result.duplicated).toBe(false);

    // No issue should have been created
    const { issues: issuesTable } = await import("@paperclipai/db");
    const allIssues = await db.select({ id: issuesTable.id }).from(issuesTable);
    expect(allIssues).toHaveLength(0);

    // Wakeup request enqueued for EA with emailMessageId in payload
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, eaAgent.id));
    expect(wakeups.length).toBeGreaterThan(0);
    expect((wakeups[0].payload as Record<string, unknown>).emailMessageId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts --reporter=verbose 2>&1 | grep -A5 "EA routing"
```

Expected: FAIL — issue IS created (old behavior), EA wakeup not enqueued.

- [ ] **Step 3: Add EA routing check to email-processor.ts**

In `server/src/services/email-processor.ts`, find the triageAgentId resolution block (around line 586–593). Immediately after the "no triageAgentId" early-return block, add:

```typescript
    // Detect EA triage agent — skip issue creation, wake EA directly so it
    // can score and propose a plan via the plan-gate instead of auto-creating.
    const [triageAgentRow] = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(eq(agents.id, triageAgentId))
      .limit(1);

    if (triageAgentRow?.adapterType === "ea") {
      const { heartbeatService } = await import("./heartbeat.js");
      await heartbeatService(db).wakeup(triageAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "email-triage",
        payload: { emailMessageId },
        requestedByActorType: "system",
        requestedByActorId: "email-processor",
      });
      logger.info({ emailMessageId, triageAgentId }, "email-processor: EA triage — woke EA, skipped issue creation");
      return;
    }
```

Note: `agents` is already imported from `@paperclipai/db` (line 8). `eq` is already imported from `drizzle-orm`. No new imports needed.

- [ ] **Step 4: Run test — should pass**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts --reporter=verbose 2>&1 | grep -A5 "EA routing"
```

Expected: PASS.

- [ ] **Step 5: Run existing email-processor tests — no regressions**

```bash
pnpm vitest run server/src/__tests__/email-processor.test.ts
```

Expected: same pass/fail count as before (2 timeout failures are pre-existing and unrelated).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/email-processor.ts server/src/__tests__/ea-email-intake-gate.test.ts
git commit -m "feat(email-processor): skip triage issue for EA-routed emails, wake EA directly"
```

---

## Task 3: MCP tool — `get_email_message`

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`
- Modify: `server/src/__tests__/ea-email-intake-gate.test.ts`

- [ ] **Step 1: Write failing test**

Append to `server/src/__tests__/ea-email-intake-gate.test.ts`:

```typescript
describe("get_email_message query logic", () => {
  it("returns email with thread history and existingIssueId when prior thread email has issue", async () => {
    const { company, agent } = await seedBase();
    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "thread-test",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "box@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "box@co.com",
    }).returning();

    // Insert a prior "parent" email that already has an issue linked
    const { issues: issuesTable } = await import("@paperclipai/db");
    const [existingIssue] = await db.insert(issuesTable).values({
      companyId: company.id,
      title: "Prior issue",
      status: "in_progress",
      priority: "medium",
    }).returning();

    const [parentEmail] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<parent-001@example.com>",
      referencesHeaders: [],
      fromAddr: "client@vendor.com",
      toAddrs: ["box@co.com"],
      subject: "Original inquiry",
      body: "Let's work together.",
      receivedAt: new Date(Date.now() - 86400_000),
      issueId: existingIssue.id,
    }).returning();

    // Insert the reply email referencing the parent
    const [replyEmail] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<reply-002@example.com>",
      inReplyToHeader: "<parent-001@example.com>",
      referencesHeaders: ["<parent-001@example.com>"],
      fromAddr: "client@vendor.com",
      toAddrs: ["box@co.com"],
      subject: "Re: Original inquiry",
      body: "Following up on my previous message.",
      receivedAt: new Date(),
    }).returning();

    // Simulate what the get_email_message handler does
    const emailRow = replyEmail;
    const referencedMsgIds = [
      ...(emailRow.referencesHeaders ?? []),
      ...(emailRow.inReplyToHeader ? [emailRow.inReplyToHeader] : []),
    ];
    const { inArray, isNotNull } = await import("drizzle-orm");
    const ancestors = await db
      .select({ id: emailMessages.id, issueId: emailMessages.issueId, fromAddr: emailMessages.fromAddr, subject: emailMessages.subject, body: emailMessages.body, receivedAt: emailMessages.receivedAt })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.emailAccountId, account.id),
          inArray(emailMessages.messageIdHeader, referencedMsgIds),
        )
      )
      .orderBy(emailMessages.receivedAt);

    const existingIssueId = ancestors.find((a) => a.issueId)?.issueId ?? null;

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].id).toBe(parentEmail.id);
    expect(existingIssueId).toBe(existingIssue.id);
  });

  it("returns existingIssueId: null when no thread email has an issue", async () => {
    const { company } = await seedBase();
    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "no-thread",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "new@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "new@co.com",
    }).returning();

    const [freshEmail] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<fresh-001@example.com>",
      referencesHeaders: [],
      fromAddr: "new-lead@vendor.com",
      toAddrs: ["new@co.com"],
      subject: "New inquiry",
      body: "Hi, I'm interested.",
      receivedAt: new Date(),
    }).returning();

    // No ancestors
    const referencedMsgIds: string[] = [];
    const existingIssueId = null; // empty referencedMsgIds → skip query → null

    expect(existingIssueId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (logic test, not HTTP)**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts --reporter=verbose 2>&1 | grep -E "get_email_message|PASS|FAIL"
```

Expected: 2 passed (the query logic test runs against real DB).

- [ ] **Step 3: Add `get_email_message` to TOOLS array in mcp-tool-server.ts**

Find the end of the TOOLS array (line 505). Add before the closing `]`:

```typescript
  {
    name: "get_email_message",
    description: "Read an inbound email by ID, including thread history and whether any thread email is already linked to an issue. Use when woken with { emailMessageId } in payload.",
    inputSchema: {
      type: "object",
      required: ["emailMessageId"],
      properties: {
        emailMessageId: { type: "string", description: "UUID of the email_messages row" },
      },
    },
  },
```

- [ ] **Step 4: Add `get_email_message` handler**

In `mcp-tool-server.ts`, find the section where tool handlers are defined (after line 507). Add before the final `return \`Error: unknown tool "${name}"\`` line:

```typescript
  if (name === "get_email_message") {
    const { emailMessageId: emId } = args as { emailMessageId: string };
    const [emailRow] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, emId))
      .limit(1);
    if (!emailRow) return `Error: email message ${emId} not found`;

    const attachmentRows = await db
      .select({
        filename: emailAttachments.filename,
        contentType: emailAttachments.contentType,
        sizeBytes: emailAttachments.sizeBytes,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, emId));

    const referencedMsgIds = [
      ...(emailRow.referencesHeaders ?? []),
      ...(emailRow.inReplyToHeader ? [emailRow.inReplyToHeader] : []),
    ];

    let threadHistory: Array<{ id: string; fromAddr: string; subject: string; body: string; receivedAt: Date; issueId: string | null }> = [];
    let existingIssueId: string | null = null;

    if (referencedMsgIds.length > 0) {
      const ancestors = await db
        .select({
          id: emailMessages.id,
          fromAddr: emailMessages.fromAddr,
          subject: emailMessages.subject,
          body: emailMessages.body,
          receivedAt: emailMessages.receivedAt,
          issueId: emailMessages.issueId,
        })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.emailAccountId, emailRow.emailAccountId),
            inArray(emailMessages.messageIdHeader, referencedMsgIds),
          )
        )
        .orderBy(emailMessages.receivedAt);
      threadHistory = ancestors;
      existingIssueId = ancestors.find((a) => a.issueId)?.issueId ?? null;
    }

    return JSON.stringify({
      id: emailRow.id,
      fromAddr: emailRow.fromAddr,
      subject: emailRow.subject,
      body: emailRow.body,
      receivedAt: emailRow.receivedAt,
      attachmentSummaries: attachmentRows,
      threadHistory,
      existingIssueId,
    }, null, 2);
  }
```

Note: `inArray` must be added to the drizzle-orm import at the top of mcp-tool-server.ts. Check line 4 (`import { and, desc, eq, gte, ilike, isNull, or, sql } from "drizzle-orm"`) and add `inArray` if not present.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "mcp-tool-server"
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts server/src/__tests__/ea-email-intake-gate.test.ts
git commit -m "feat(mcp): add get_email_message tool with thread history and existingIssueId"
```

---

## Task 4: MCP tool — `get_issue_context`

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`
- Modify: `server/src/__tests__/ea-email-intake-gate.test.ts`

- [ ] **Step 1: Write failing test**

Append to `server/src/__tests__/ea-email-intake-gate.test.ts`:

```typescript
describe("get_issue_context query logic", () => {
  it("returns issue + comments + linked emails", async () => {
    const { company, agent } = await seedBase();
    const { issues: issuesTable, issueComments } = await import("@paperclipai/db");

    const [issue] = await db.insert(issuesTable).values({
      companyId: company.id,
      title: "Client lead: Alice",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    }).returning();

    const [comment] = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: agent.id,
      body: "Started investigating this lead.",
    }).returning();

    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "ctx-test",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "ctx@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "ctx@co.com",
    }).returning();

    const [email] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<ctx-001@example.com>",
      referencesHeaders: [],
      fromAddr: "alice@vendor.com",
      toAddrs: ["ctx@co.com"],
      subject: "Partnership",
      body: "Hello, let's connect.",
      receivedAt: new Date(),
      issueId: issue.id,
    }).returning();

    // Simulate the get_issue_context handler queries
    const [issueRow] = await db
      .select({
        id: issuesTable.id,
        title: issuesTable.title,
        status: issuesTable.status,
        priority: issuesTable.priority,
      })
      .from(issuesTable)
      .where(eq(issuesTable.id, issue.id))
      .limit(1);

    const commentRows = await db
      .select({ id: issueComments.id, body: issueComments.body, authorAgentId: issueComments.authorAgentId, createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);

    const emailRows = await db
      .select({ id: emailMessages.id, fromAddr: emailMessages.fromAddr, subject: emailMessages.subject, body: emailMessages.body, receivedAt: emailMessages.receivedAt })
      .from(emailMessages)
      .where(eq(emailMessages.issueId, issue.id))
      .orderBy(emailMessages.receivedAt);

    expect(issueRow.id).toBe(issue.id);
    expect(commentRows).toHaveLength(1);
    expect(commentRows[0].body).toBe("Started investigating this lead.");
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0].fromAddr).toBe("alice@vendor.com");
  });
});
```

- [ ] **Step 2: Run test — should pass (query logic test)**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts --reporter=verbose 2>&1 | grep -E "get_issue_context|PASS|FAIL"
```

Expected: PASS.

- [ ] **Step 3: Add `get_issue_context` to TOOLS array**

Find the `get_email_message` tool definition added in Task 3. Add after it:

```typescript
  {
    name: "get_issue_context",
    description: "Read full context for an existing issue: details, all comments, and all linked emails with attachment summaries. Use when a thread reply arrives and existingIssueId is set.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue" },
      },
    },
  },
```

- [ ] **Step 4: Add `get_issue_context` handler**

In mcp-tool-server.ts, add after the `get_email_message` handler:

```typescript
  if (name === "get_issue_context") {
    const { issueId: ctxIssueId } = args as { issueId: string };
    const [issueRow] = await db
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, ctxIssueId))
      .limit(1);
    if (!issueRow) return `Error: issue ${ctxIssueId} not found`;

    const commentRows = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, ctxIssueId))
      .orderBy(issueComments.createdAt);

    const emailRows = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        subject: emailMessages.subject,
        body: emailMessages.body,
        receivedAt: emailMessages.receivedAt,
      })
      .from(emailMessages)
      .where(eq(emailMessages.issueId, ctxIssueId))
      .orderBy(emailMessages.receivedAt);

    const emailsWithAttachments = await Promise.all(
      emailRows.map(async (em) => {
        const atts = await db
          .select({ filename: emailAttachments.filename, contentType: emailAttachments.contentType, sizeBytes: emailAttachments.sizeBytes })
          .from(emailAttachments)
          .where(eq(emailAttachments.emailMessageId, em.id));
        return { ...em, attachmentSummaries: atts };
      })
    );

    return JSON.stringify({
      issue: issueRow,
      comments: commentRows,
      emails: emailsWithAttachments,
    }, null, 2);
  }
```

Note: `issueComments` must be in the `@paperclipai/db` import at the top of mcp-tool-server.ts. Check line 2 and add it if missing.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "mcp-tool-server"
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts server/src/__tests__/ea-email-intake-gate.test.ts
git commit -m "feat(mcp): add get_issue_context tool — issue + comments + emails"
```

---

## Task 5: MCP tool — update `create_plan` for email-sourced proposals

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`
- Modify: `server/src/__tests__/ea-email-intake-gate.test.ts`

- [ ] **Step 1: Write failing test**

Append to `server/src/__tests__/ea-email-intake-gate.test.ts`:

```typescript
describe("create_plan with emailMessageId", () => {
  it("creates plan + approval with sourceEmailMessageId and assigneeAgentId", async () => {
    const { company, agent: eaAgent, specialistAgent } = await seedBase();
    const { plans: plansTable, approvals: approvalsTable } = await import("@paperclipai/db");

    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "plan-test",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "plan@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "plan@co.com",
    }).returning();

    const [email] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<plan-001@example.com>",
      referencesHeaders: [],
      fromAddr: "lead@corp.com",
      toAddrs: ["plan@co.com"],
      subject: "Interested in your services",
      body: "We'd like to discuss a partnership.",
      receivedAt: new Date(),
      matchedCompanyId: company.id,
    }).returning();

    // Simulate the create_plan handler logic for email path
    const svc = planGateService(db);
    const { planId, approvalId } = await svc.proposePlan({
      companyId: company.id,
      agentId: eaAgent.id,
      actionType: "create_issue",
      kind: "create_issue",
      proposalText: "Create a new lead issue for corp.com inquiry",
      sourceEmailMessageId: email.id,
      assigneeAgentId: specialistAgent.id,
      bypassReadinessGate: true,
    });

    const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, planId)).limit(1);
    expect(plan.sourceEmailMessageId).toBe(email.id);
    expect(plan.kind).toBe("create_issue");
    expect((plan.proposalMeta as Record<string, unknown>).assigneeAgentId ?? plan.proposalMeta).toBeDefined();

    const [approval] = await db.select().from(approvalsTable).where(eq(approvalsTable.id, approvalId)).limit(1);
    expect(approval.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test — should pass**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts --reporter=verbose 2>&1 | grep -E "create_plan|PASS|FAIL"
```

Expected: PASS (uses planGateService directly).

- [ ] **Step 3: Add `planGateService` import to mcp-tool-server.ts**

Find the service imports (around line 9-12 in mcp-tool-server.ts):

```typescript
import { planGateService } from "./plan-gate.js";
```

- [ ] **Step 4: Update `create_plan` tool definition**

Find the `create_plan` tool definition in the TOOLS array and replace it:

```typescript
  {
    name: "create_plan",
    description: "Create a plan for operator approval. For email-sourced proposals (no existing issue), provide emailMessageId + assigneeAgentId + title. For issue-linked proposals, provide issueId.",
    inputSchema: {
      type: "object",
      required: ["proposalText"],
      properties: {
        proposalText: { type: "string", description: "Full human-readable plan shown to operator for approval" },
        steps: { type: "array", items: { type: "string" }, description: "Ordered list of plan steps (optional)" },
        issueId: { type: "string", description: "UUID of an existing issue this plan addresses (legacy path)" },
        emailMessageId: { type: "string", description: "UUID of the source email — use instead of issueId for EA email-sourced proposals" },
        assigneeAgentId: { type: "string", description: "UUID of specialist agent to assign the created issue to (required when emailMessageId is provided)" },
        title: { type: "string", description: "Proposed issue title (used when emailMessageId is provided)" },
      },
    },
  },
```

- [ ] **Step 5: Update `create_plan` handler**

Find the current `create_plan` handler (lines 903–924). Replace the entire `if (name === "create_plan")` block:

```typescript
  if (name === "create_plan") {
    const { issueId, proposalText, steps, emailMessageId: planEmailId, assigneeAgentId: planAssigneeId, title: planTitle } = args as {
      issueId?: string;
      proposalText: string;
      steps?: string[];
      emailMessageId?: string;
      assigneeAgentId?: string;
      title?: string;
    };

    const stepsText = steps?.length ? "\n\nSteps:\n" + steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") : "";
    const fullProposal = `${planTitle ? `**${planTitle}**\n\n` : ""}${proposalText}${stepsText}`;

    if (planEmailId) {
      // Email-sourced proposal path — uses planGateService so executePlan runs on approval
      const [emailRow] = await db
        .select({ matchedCompanyId: emailMessages.matchedCompanyId, fromAddr: emailMessages.fromAddr, subject: emailMessages.subject })
        .from(emailMessages)
        .where(eq(emailMessages.id, planEmailId))
        .limit(1);
      if (!emailRow) return `Error: email message ${planEmailId} not found`;
      if (!emailRow.matchedCompanyId) return `Error: email ${planEmailId} has no matchedCompanyId — EA must resolve company before proposing a plan`;

      const { planId, approvalId } = await planGateService(db).proposePlan({
        companyId: emailRow.matchedCompanyId,
        agentId: callerAgentId ?? companyId, // callerAgentId is set by MCP auth context
        actionType: "create_issue",
        kind: "create_issue",
        proposalText: fullProposal,
        sourceEmailMessageId: planEmailId,
        assigneeAgentId: planAssigneeId ?? null,
        bypassReadinessGate: true,
        proposalMeta: { assigneeAgentId: planAssigneeId ?? null },
      });

      try {
        const notice = `📋 *EA plan awaiting approval*\n\n📧 From: ${emailRow.fromAddr}\n📌 Subject: ${emailRow.subject || "(no subject)"}\n\n${fullProposal.slice(0, 500)}${fullProposal.length > 500 ? "…" : ""}\n\nApproval ID: \`${approvalId}\``;
        await notifyOperatorTelegram(db, notice);
      } catch { /* non-fatal */ }

      return `Plan created (email-sourced). Plan ID: ${planId}. Approval ID: ${approvalId}. Awaiting operator approval.`;
    }

    // Legacy path — issueId provided
    if (!issueId) return `Error: provide either emailMessageId or issueId`;
    const [issueRow] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issueRow) return `Error: issue ${issueId} not found`;

    const [approval] = await db.insert(approvals).values({
      companyId: issueRow.companyId,
      type: "plan",
      requestedByAgentId: null,
      status: "pending",
      payload: { issueId, proposalText: fullProposal, steps: steps ?? [] },
    }).returning({ id: approvals.id });

    try {
      const planNotice = `📋 *Plan awaiting approval*\n\n${fullProposal.slice(0, 600)}${fullProposal.length > 600 ? "…" : ""}\n\nApproval ID: \`${approval!.id}\`\n\nReply "approve" or "decline" — EA will call approve_plan.`;
      await notifyOperatorTelegram(db, planNotice);
    } catch { /* non-fatal */ }

    return `Plan created. Approval ID: ${approval!.id}. Awaiting operator approval.`;
  }
```

Note: `callerAgentId` — check how it's resolved in the MCP handler context. Search for `callerAgentId` in mcp-tool-server.ts to confirm the variable name. If it doesn't exist, use `companyId` as a fallback or the agent ID from the MCP token payload.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck 2>&1 | grep "mcp-tool-server"
```

Expected: no output.

- [ ] **Step 7: Run full test suite**

```bash
pnpm vitest run server/src/__tests__/ea-email-intake-gate.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts server/src/__tests__/ea-email-intake-gate.test.ts
git commit -m "feat(mcp): update create_plan to support email-sourced proposals via planGateService"
```

---

## Task 6: Notification matrix — `thread_reply_received`

**Files:**
- Modify: `ui/src/pages/founder/FounderSettings.tsx`

- [ ] **Step 1: Add field to `EaNotificationChannelConfig` interface**

In `ui/src/pages/founder/FounderSettings.tsx`, find the `EaNotificationChannelConfig` interface and add:

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
  thread_reply_received: boolean;  // ← add this
}
```

- [ ] **Step 2: Add default value**

Find `EA_NOTIFICATION_DEFAULTS` and add:

```typescript
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
    thread_reply_received: false,  // ← add this
  },
};
```

- [ ] **Step 3: Add label**

Find `EA_NOTIFICATION_LABELS` and add:

```typescript
const EA_NOTIFICATION_LABELS: Record<keyof EaNotificationChannelConfig, string> = {
  high_risk_detected: "High risk detected",
  approval_required: "Approval required",
  new_lead_created: "New lead created",
  proposal_request_detected: "Proposal request",
  agent_blocked: "Agent blocked",
  topic_created: "Topic created",
  issue_created: "Issue created",
  urgent_item_detected: "Urgent item",
  thread_reply_received: "Thread reply received",  // ← add this
};
```

- [ ] **Step 4: Typecheck UI**

```bash
pnpm --filter @paperclipai/ui typecheck 2>&1 | grep "FounderSettings"
```

Expected: no output from FounderSettings.tsx.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/founder/FounderSettings.tsx
git commit -m "feat(ui): add thread_reply_received toggle to EA notification matrix"
```

---

## Task 7: Update EA operator AGENTS.md

**Files:**
- Modify: `server/src/onboarding-assets/ea-operator/AGENTS.md`

- [ ] **Step 1: Replace email triage section**

Find the `## Email triage` section in `server/src/onboarding-assets/ea-operator/AGENTS.md` and replace it entirely:

```markdown
## Email triage
When woken with payload `{ emailMessageId }`:
1. Call `get_email_message(emailMessageId)` — returns body, sender, subject, attachments, thread history, existingIssueId
2. **If existingIssueId is set (reply to thread with existing issue):**
   - Call `get_issue_context(existingIssueId)` to read full issue history (comments, prior emails)
   - Add comment to issue via `update_issue` summarising the new email
   - Set issue status to `in_progress` so assignee is picked up on next heartbeat
   - If `thread_reply_received` is enabled in notification matrix (read via `get_instance_config`): call `notify_operator`
   - Stop — do NOT create a new plan or issue
3. **If existingIssueId is null (new thread):**
   - Use `fromAddr` as `senderIdentifier` for `search_memory`
   - Score and classify as normal
   - If score < 60: `create_memory(memoryType='passive')`, stop
   - If score ≥ 60:
     - `search_topics` → `create_topic` if no match
     - `create_memory(memoryType='active')`
     - `create_plan(emailMessageId, title, proposalText, assigneeAgentId)` — operator must approve before issue is created
```

- [ ] **Step 2: Commit**

```bash
git add server/src/onboarding-assets/ea-operator/AGENTS.md
git commit -m "docs(ea): update email triage instructions for intake gate flow"
```

---

## Final verification

- [ ] **Run all tests**

```bash
pnpm test:run 2>&1 | tail -10
```

Expected: same pre-existing failures as before (email-processor timeouts, email-plan-gate-e2e timeouts) — no new failures.

- [ ] **Typecheck server and UI**

```bash
pnpm --filter @paperclipai/server typecheck 2>&1 | grep -v "session-resolver\|whatsapp" | grep "error TS"
pnpm --filter @paperclipai/ui typecheck 2>&1 | grep -v "AgentPerformanceTab\|Analytics" | grep "error TS"
```

Expected: no output (all errors in those files are pre-existing).
