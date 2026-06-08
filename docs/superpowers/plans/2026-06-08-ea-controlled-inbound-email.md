# EA Controlled Inbound Email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the EA agent from autonomously creating issues/clients/projects for inbound emails; add an email labeling system so operators can categorize and suppress unwanted messages.

**Architecture:** MCP tool-level enforcement (isOperator guard on create_issue/create_client/create_project) combined with a hardcoded inbound restriction block appended to the orchestrator system prompt. A new `email_label_definitions` table + `email_messages.label` column support operator-defined tags. The `label_email` MCP tool sets labels and prompts for domain blocking.

**Tech Stack:** Drizzle ORM (PGlite dev / Postgres prod), Express 5, React 19 + TanStack Query, Vitest, supertest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/db/src/schema/email_label_definitions.ts` | Create | New table: company-scoped label definitions |
| `packages/db/src/schema/email_messages.ts` | Modify | Add `label` text column |
| `packages/db/src/schema/index.ts` | Modify | Export `emailLabelDefinitions` |
| `server/src/routes/mcp-tool-server.ts` | Modify | Guard create_issue/create_client/create_project; add label_email tool; add sourceEmailMessageId to create_issue |
| `server/src/services/orchestrator.ts` | Modify | Append inbound restriction block for !isOperator |
| `server/src/routes/email-messages.ts` | Modify | Support `label` in PATCH; add label-definitions CRUD routes |
| `server/src/__tests__/mcp-email-label-gates.test.ts` | Create | Tests: tool guards, label_email |
| `ui/src/api/emailMessages.ts` | Modify | Add `label` field to types; add `setLabel` method |
| `ui/src/api/emailLabelDefinitions.ts` | Create | CRUD API client for label definitions |
| `ui/src/pages/EmailInbox.tsx` | Modify | Add label dropdown + "Create Issue" button on email detail |
| `ui/src/pages/settings/EmailLabels.tsx` | Create | Settings page: CRUD for label definitions |
| `ui/src/pages/Settings.tsx` (or router) | Modify | Register Email Labels settings route |

---

### Task 1: DB Schema — email_label_definitions table

**Files:**
- Create: `packages/db/src/schema/email_label_definitions.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the schema file**

```typescript
// packages/db/src/schema/email_label_definitions.ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const emailLabelDefinitions = pgTable(
  "email_label_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6b7280"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("email_label_definitions_company_idx").on(table.companyId),
    uniqueName: uniqueIndex("email_label_definitions_company_name_idx").on(
      table.companyId,
      table.name,
    ),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, find the `blockedSenderDomains` export line (currently line 96) and add after it:

```typescript
export { emailLabelDefinitions } from "./email_label_definitions.js";
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm -r typecheck
```

Expected: no errors (schema not yet used anywhere beyond the export).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/email_label_definitions.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add email_label_definitions table"
```

---

### Task 2: DB Schema — label column on email_messages

**Files:**
- Modify: `packages/db/src/schema/email_messages.ts`

- [ ] **Step 1: Add label column**

In `packages/db/src/schema/email_messages.ts`, find `errorText: text("error_text"),` and add after it:

```typescript
    label: text("label"),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Run migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: generates a new migration file under `packages/db/src/migrations/`, applies it without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/email_messages.ts packages/db/src/migrations/
git commit -m "feat(db): add label column to email_messages, add email_label_definitions table"
```

---

### Task 3: MCP tool guards — block create_issue/create_client/create_project for non-operators

**Files:**
- Create: `server/src/__tests__/mcp-email-label-gates.test.ts`
- Modify: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/mcp-email-label-gates.test.ts`:

```typescript
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { companies, agents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpToolServerRoutes } from "../routes/mcp-tool-server.js";
import { signMcpToken } from "../services/mcp-session-token.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("MCP email label gates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let agentToken!: string;   // isOperator=false
  let operatorToken!: string; // isOperator=true
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-label-gates-");
    db = createDb(tempDb.connectionString);

    const [co] = await db.insert(companies).values({ name: "Test Co", issuePrefix: "TC" }).returning();
    companyId = co!.id;
    const [ag] = await db
      .insert(agents)
      .values({ companyId, name: "EA", adapterType: "ea", status: "idle" })
      .returning();

    agentToken = signMcpToken({ companyId, agentId: ag!.id, isOperator: false });
    operatorToken = signMcpToken({ companyId, agentId: ag!.id, isOperator: true });

    app = express();
    app.use(express.json());
    app.use("/api", mcpToolServerRoutes(db));
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function callTool(token: string, name: string, args: Record<string, unknown>) {
    return request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  }

  describe("create_issue guard", () => {
    it("returns error when isOperator=false", async () => {
      const res = await callTool(agentToken, "create_issue", { title: "Test issue" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/operator authorization/i);
    });

    it("succeeds when isOperator=true", async () => {
      const res = await callTool(operatorToken, "create_issue", { title: "Operator-created issue", companyId });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).not.toMatch(/error/i);
      expect(JSON.parse(text)).toMatchObject({ title: "Operator-created issue" });
    });
  });

  describe("create_client guard", () => {
    it("returns error when isOperator=false", async () => {
      const res = await callTool(agentToken, "create_client", { name: "Acme Corp" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/operator authorization/i);
    });
  });

  describe("create_project guard", () => {
    it("returns error when isOperator=false", async () => {
      const res = await callTool(agentToken, "create_project", { name: "New Project" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/operator authorization/i);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run server/src/__tests__/mcp-email-label-gates.test.ts
```

Expected: `create_issue guard` / `create_client guard` / `create_project guard` tests FAIL — tool currently succeeds for non-operators.

- [ ] **Step 3: Add isOperator guards to the three tools**

In `server/src/routes/mcp-tool-server.ts`, find `if (name === "create_issue") {` (line ~1073) and add guard as the first line of the block:

```typescript
  if (name === "create_issue") {
    if (!isOperator) return "Error: issue creation requires operator authorization. Call notify_operator() to inform the operator instead.";
    // ... rest of handler unchanged
```

Find `if (name === "create_client") {` (line ~2277) and add guard:

```typescript
  if (name === "create_client") {
    if (!isOperator) return "Error: client creation requires operator authorization. Call notify_operator() to inform the operator instead.";
    // ... rest of handler unchanged
```

Find `if (name === "create_project") {` by searching for that string and add guard (same pattern):

```typescript
  if (name === "create_project") {
    if (!isOperator) return "Error: project creation requires operator authorization. Call notify_operator() to inform the operator instead.";
    // ... rest of handler unchanged
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm vitest run server/src/__tests__/mcp-email-label-gates.test.ts
```

Expected: all guards tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/mcp-email-label-gates.test.ts server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): restrict create_issue/create_client/create_project to operators"
```

---

### Task 4: label_email MCP tool

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`
- Modify: `server/src/__tests__/mcp-email-label-gates.test.ts`

- [ ] **Step 1: Write failing test — add to existing test file**

Add this `describe` block inside `describeEmbeddedPostgres("MCP email label gates", ...)` in `server/src/__tests__/mcp-email-label-gates.test.ts`, after the imports add the needed DB schema imports:

```typescript
import { emailAccounts, emailMessages, emailLabelDefinitions } from "@paperclipai/db";
```

Then add this describe block at the bottom of the outer describe:

```typescript
  describe("label_email tool", () => {
    let emailMessageId: string;

    beforeAll(async () => {
      const [acct] = await db.insert(emailAccounts).values({
        companyId,
        fromEmail: "inbox@test.com",
        label: "Test Inbox",
        role: "inbound",
        smtpHost: null, smtpPort: null, smtpUser: null, smtpPass: null,
        imapHost: null, imapPort: null, imapUser: null, imapPass: null,
      }).returning();
      const [msg] = await db.insert(emailMessages).values({
        emailAccountId: acct!.id,
        messageIdHeader: "<test-label@example.com>",
        fromAddr: "sender@spammer.com",
        toAddrs: ["inbox@test.com"],
        subject: "Spam email",
        body: "Buy now!",
        receivedAt: new Date(),
        processingState: "pending",
      }).returning();
      emailMessageId = msg!.id;

      // Seed a label definition
      await db.insert(emailLabelDefinitions).values({
        companyId,
        name: "spam",
        color: "#e74c3c",
      });
    });

    it("sets label and processingState=ignored on the email", async () => {
      const res = await callTool(agentToken, "label_email", { emailId: emailMessageId, label: "spam" });
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text as string);
      expect(parsed.success).toBe(true);
      expect(parsed.label).toBe("spam");
      expect(parsed.senderDomain).toBe("spammer.com");

      const [row] = await db.select({ label: emailMessages.label, processingState: emailMessages.processingState })
        .from(emailMessages).where(eq(emailMessages.id, emailMessageId)).limit(1);
      expect(row?.label).toBe("spam");
      expect(row?.processingState).toBe("ignored");
    });

    it("returns error for non-existent email", async () => {
      const res = await callTool(agentToken, "label_email", { emailId: "00000000-0000-0000-0000-000000000000", label: "spam" });
      expect(res.status).toBe(200);
      expect(res.body.result.content[0].text).toMatch(/not found/i);
    });
  });
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm vitest run server/src/__tests__/mcp-email-label-gates.test.ts
```

Expected: `label_email tool` tests FAIL — tool does not exist yet.

- [ ] **Step 3: Add label_email tool definition to TOOLS array**

In `server/src/routes/mcp-tool-server.ts`, find the `block_sender_domain` tool definition (line ~648) and add this new tool after it:

```typescript
  {
    name: "label_email",
    description: "Label an inbound email (e.g. 'spam', 'marketing', 'AI', 'news'). Marks it as ignored. Returns the sender domain so you can offer to block it with block_sender_domain.",
    inputSchema: {
      type: "object",
      required: ["emailId", "label"],
      properties: {
        emailId: { type: "string", description: "UUID of the email message to label" },
        label: { type: "string", description: "Label name (e.g. 'spam', 'marketing', 'AI', 'news')" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
```

- [ ] **Step 4: Add label_email handler**

In `server/src/routes/mcp-tool-server.ts`, find `if (name === "block_sender_domain") {` (line ~2307) and add after its closing brace:

```typescript
  if (name === "label_email") {
    const emailId = String(args.emailId ?? "").trim();
    const label = String(args.label ?? "").trim();
    if (!emailId) return "Error: emailId is required";
    if (!label) return "Error: label is required";

    const [msg] = await db
      .select({ id: emailMessages.id, fromAddr: emailMessages.fromAddr, emailAccountId: emailMessages.emailAccountId })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailId))
      .limit(1);
    if (!msg) return "Error: email not found";

    const [account] = await db
      .select({ companyId: emailAccounts.companyId })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, msg.emailAccountId))
      .limit(1);
    if (!account || (!isOperator && account.companyId !== companyId)) {
      return "Error: email not found or access denied";
    }

    await db.update(emailMessages).set({
      label,
      processingState: "ignored",
      processedAt: new Date(),
    }).where(eq(emailMessages.id, emailId));

    const domain = msg.fromAddr.split("@")[1] ?? "";
    return JSON.stringify({ success: true, emailId, label, senderDomain: domain });
  }
```

Also add `emailLabelDefinitions` to the import from `@paperclipai/db` at the top of `mcp-tool-server.ts` (find the existing import line and add it):

```typescript
import { ..., emailLabelDefinitions } from "@paperclipai/db";
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
pnpm vitest run server/src/__tests__/mcp-email-label-gates.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts server/src/__tests__/mcp-email-label-gates.test.ts
git commit -m "feat(mcp): add label_email tool"
```

---

### Task 5: sourceEmailMessageId for create_issue

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Add sourceEmailMessageId to create_issue tool definition**

In `server/src/routes/mcp-tool-server.ts`, find the `create_issue` tool definition (line ~83) and add `sourceEmailMessageId` to properties:

```typescript
        sourceEmailMessageId: { type: "string", description: "UUID of inbound email this issue was created from. Links the email to the new issue." },
```

- [ ] **Step 2: Add sourceEmailMessageId handling in create_issue handler**

In the `create_issue` handler (line ~1073), after the `return JSON.stringify(...)` line that returns the created issue, add the email linkage before the return:

```typescript
    // Link source email to the created issue
    if (args.sourceEmailMessageId && typeof args.sourceEmailMessageId === "string") {
      await db.update(emailMessages).set({
        issueId: created.id,
        processingState: "plan_proposed",
        processedAt: new Date(),
      }).where(eq(emailMessages.id, String(args.sourceEmailMessageId))).catch(() => {});
    }

    return JSON.stringify({ ...created, clientFolderPath: issueClientFolderPath }, null, 2);
```

(Replace the existing `return JSON.stringify(...)` with this block — move the `return` after the email update.)

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add sourceEmailMessageId param to create_issue"
```

---

### Task 6: Orchestrator inbound restriction block

**Files:**
- Modify: `server/src/services/orchestrator.ts`

- [ ] **Step 1: Add inbound restriction block after system prompt write**

In `server/src/services/orchestrator.ts`, find the line:

```typescript
  await fs.writeFile(promptPath, systemPrompt + memorySection, "utf-8");
```

Replace it with:

```typescript
  const inboundRestriction = !isOperator
    ? `\n\n---\n\n# Inbound Email Rules (MANDATORY)\n\nYou are processing an inbound client message. These rules override all other instructions:\n\n1. **DO NOT call create_issue, create_client, or create_project.** These tools will return an authorization error. You do not have permission to create entities autonomously.\n2. **Thread match found** (existingIssueId is set) → call add_issue_comment to append the message, then stop.\n3. **No thread match** → call notify_operator with a brief summary (sender, subject, first 200 chars of body) and stop. Do not take any other action.\n4. The operator will decide whether to create an issue, label the email, or ignore it.\n`
    : "";
  await fs.writeFile(promptPath, systemPrompt + memorySection + inboundRestriction, "utf-8");
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/orchestrator.ts
git commit -m "feat(orchestrator): append inbound restriction block for non-operator context"
```

---

### Task 7: Email label definitions CRUD API route

**Files:**
- Modify: `server/src/routes/email-messages.ts`

- [ ] **Step 1: Add label definitions routes**

In `server/src/routes/email-messages.ts`, add `emailLabelDefinitions` to the import from `@paperclipai/db`:

```typescript
import { emailAccounts, emailAttachments, emailMessages, emailLabelDefinitions, issueComments, issues, agentWakeupRequests } from "@paperclipai/db";
```

Then add these three routes before the `return router;` line at the end of `emailMessageRoutes`:

```typescript
  // GET /api/companies/:companyId/email-label-definitions
  router.get("/companies/:companyId/email-label-definitions", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const rows = await db
      .select()
      .from(emailLabelDefinitions)
      .where(eq(emailLabelDefinitions.companyId, companyId))
      .orderBy(emailLabelDefinitions.name);
    res.json(rows);
  });

  // POST /api/companies/:companyId/email-label-definitions
  router.post("/companies/:companyId/email-label-definitions", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const { name, color } = req.body as { name?: string; color?: string };
    if (!name?.trim()) throw badRequest("name is required");
    const [created] = await db
      .insert(emailLabelDefinitions)
      .values({ companyId, name: name.trim(), color: color ?? "#6b7280" })
      .returning();
    res.status(201).json(created);
  });

  // DELETE /api/companies/:companyId/email-label-definitions/:labelId
  router.delete("/companies/:companyId/email-label-definitions/:labelId", async (req, res) => {
    const { companyId, labelId } = req.params;
    assertCompanyAccess(req, companyId);
    await db
      .delete(emailLabelDefinitions)
      .where(and(eq(emailLabelDefinitions.id, labelId), eq(emailLabelDefinitions.companyId, companyId)));
    res.status(204).end();
  });
```

- [ ] **Step 2: Add label support to existing PATCH /email-messages/:id**

In `server/src/routes/email-messages.ts`, find the PATCH route's patch object construction (line ~215):

```typescript
    const patch: Record<string, unknown> = {};
    if ("issueId" in req.body) patch.issueId = req.body.issueId ?? null;
    if ("approvalId" in req.body) patch.approvalId = req.body.approvalId ?? null;
```

Add after those lines:

```typescript
    if ("label" in req.body) {
      patch.label = req.body.label ?? null;
      if (req.body.label) {
        patch.processingState = "ignored";
        patch.processedAt = new Date();
      }
    }
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/email-messages.ts
git commit -m "feat(api): add email-label-definitions CRUD routes and label field to email PATCH"
```

---

### Task 8: UI API clients

**Files:**
- Modify: `ui/src/api/emailMessages.ts`
- Create: `ui/src/api/emailLabelDefinitions.ts`

- [ ] **Step 1: Add label field to EmailMessageSummary and setLabel method**

In `ui/src/api/emailMessages.ts`, add `label: string | null;` to the `EmailMessageSummary` interface after `errorText`:

```typescript
  label: string | null;
```

Then add `setLabel` to the `emailMessagesApi` object:

```typescript
  setLabel: (id: string, label: string | null) =>
    api.patch<EmailMessageSummary>(`/email-messages/${encodeURIComponent(id)}`, { label }),
```

- [ ] **Step 2: Create emailLabelDefinitions API client**

Create `ui/src/api/emailLabelDefinitions.ts`:

```typescript
import { api } from "./client";

export interface EmailLabelDefinition {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: string;
}

export const emailLabelDefinitionsApi = {
  list: (companyId: string) =>
    api.get<EmailLabelDefinition[]>(
      `/companies/${encodeURIComponent(companyId)}/email-label-definitions`,
    ),
  create: (companyId: string, data: { name: string; color: string }) =>
    api.post<EmailLabelDefinition>(
      `/companies/${encodeURIComponent(companyId)}/email-label-definitions`,
      data,
    ),
  remove: (companyId: string, labelId: string) =>
    api.delete<void>(
      `/companies/${encodeURIComponent(companyId)}/email-label-definitions/${encodeURIComponent(labelId)}`,
    ),
};
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/emailMessages.ts ui/src/api/emailLabelDefinitions.ts
git commit -m "feat(ui): add emailLabelDefinitions API client and label field to email API"
```

---

### Task 9: Label dropdown + Create Issue button on email detail

**Files:**
- Modify: `ui/src/pages/EmailInbox.tsx`

The `EmailInbox.tsx` page has an email detail panel. We need to add:
1. A label dropdown (populated from label definitions)
2. A "Create Issue" button that opens the existing issue-create flow

- [ ] **Step 1: Add imports**

At the top of `ui/src/pages/EmailInbox.tsx`, add these imports:

```typescript
import { emailLabelDefinitionsApi, type EmailLabelDefinition } from "../api/emailLabelDefinitions";
import { Tag, Plus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
```

- [ ] **Step 2: Add state + queries + mutations in the component**

Inside the main component (after the existing `useCompany()` call), add:

```typescript
  const [createIssueEmailId, setCreateIssueEmailId] = useState<string | null>(null);

  const { data: labelDefs = [] } = useQuery({
    queryKey: queryKeys.emailLabelDefinitions(company.id),
    queryFn: () => emailLabelDefinitionsApi.list(company.id),
  });

  const setLabelMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string | null }) =>
      emailMessagesApi.setLabel(id, label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emailMessages(company.id) });
      toast("Label updated");
    },
  });
```

- [ ] **Step 3: Add CreateIssueFromEmailDialog component** (add above the main component export or in a separate file `ui/src/components/CreateIssueFromEmailDialog.tsx`):

```tsx
// If adding inline, place before the main page component.
// If separate file, import it at the top of EmailInbox.tsx.
function CreateIssueFromEmailDialog({
  email, companyId, onClose, onCreated,
}: {
  email: EmailMessageSummary;
  companyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState(`Email: ${email.subject || "(no subject)"}`);
  const toast = useToast();
  const createMutation = useMutation({
    mutationFn: () =>
      issuesApi.create(companyId, {
        title,
        description: `Created from inbound email.\n\n**From:** ${email.fromAddr}\n**Email ID:** ${email.id}`,
        sourceEmailMessageId: email.id,
      }),
    onSuccess: () => { toast("Issue created"); onCreated(); },
    onError: () => toast("Failed to create issue"),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Issue from Email</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            className="text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => createMutation.mutate()} disabled={!title.trim() || createMutation.isPending}>
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

Note: `issuesApi.create` must accept `sourceEmailMessageId`. Check `ui/src/api/issues.ts` — if the `create` method doesn't pass this field, add it to the payload type and call args.

- [ ] **Step 4: Add label dropdown and Create Issue button to the email detail panel**

Find the section in `EmailInbox.tsx` where the email detail is rendered (the right-side panel showing subject, from, body). Add this block inside the detail panel, near the action buttons area:

```tsx
{/* Label + Create Issue actions */}
<div className="flex items-center gap-2 mt-3">
  {/* Label selector */}
  <Select
    value={selectedEmail.label ?? ""}
    onValueChange={(val) => {
      setLabelMutation.mutate({ id: selectedEmail.id, label: val || null });
    }}
  >
    <SelectTrigger className="h-8 w-40 text-xs">
      <Tag className="h-3 w-3 mr-1" />
      <SelectValue placeholder="Add label…" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">No label</SelectItem>
      {labelDefs.map((def) => (
        <SelectItem key={def.id} value={def.name}>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: def.color }}
            />
            {def.name}
          </span>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>

  {/* Create Issue from email */}
  {!selectedEmail.issueId && (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs"
        onClick={() => setCreateIssueEmailId(selectedEmail.id)}
      >
        <Plus className="h-3 w-3 mr-1" />
        Create Issue
      </Button>
      {createIssueEmailId === selectedEmail.id && (
        <CreateIssueFromEmailDialog
          email={selectedEmail}
          companyId={company.id}
          onClose={() => setCreateIssueEmailId(null)}
          onCreated={() => {
            setCreateIssueEmailId(null);
            void queryClient.invalidateQueries({ queryKey: queryKeys.emailMessages(company.id) });
          }}
        />
      )}
    </>
  )}
</div>
```

- [ ] **Step 5: Add queryKeys entry for emailLabelDefinitions**

In `ui/src/lib/queryKeys.ts` (or wherever queryKeys is defined), add:

```typescript
emailLabelDefinitions: (companyId: string) => ["emailLabelDefinitions", companyId] as const,
```

- [ ] **Step 6: Typecheck and verify no import errors**

```bash
pnpm -r typecheck
```

Fix any TypeScript errors before proceeding.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/EmailInbox.tsx ui/src/lib/queryKeys.ts
git commit -m "feat(ui): add label dropdown and create-issue button to email detail panel"
```

---

### Task 10: Email Labels settings page

**Files:**
- Create: `ui/src/pages/EmailLabels.tsx`
- Modify: `ui/src/App.tsx` (register route under company prefix)

- [ ] **Step 1: Create EmailLabels page**

Create `ui/src/pages/EmailLabels.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { emailLabelDefinitionsApi, type EmailLabelDefinition } from "../api/emailLabelDefinitions";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Tag } from "lucide-react";

const PRESET_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
  "#3498db", "#9b59b6", "#1abc9c", "#6b7280",
];

export default function EmailLabels() {
  const { company } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6b7280");

  const { data: labels = [], isLoading } = useQuery({
    queryKey: queryKeys.emailLabelDefinitions(company.id),
    queryFn: () => emailLabelDefinitionsApi.list(company.id),
  });

  const createMutation = useMutation({
    mutationFn: () => emailLabelDefinitionsApi.create(company.id, { name: newName.trim(), color: newColor }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emailLabelDefinitions(company.id) });
      setNewName("");
      toast("Label created");
    },
    onError: () => toast("Failed to create label"),
  });

  const deleteMutation = useMutation({
    mutationFn: (labelId: string) => emailLabelDefinitionsApi.remove(company.id, labelId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emailLabelDefinitions(company.id) });
      toast("Label deleted");
    },
  });

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Email Labels</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Define labels for categorizing inbound emails. Labels help the EA agent and you triage noise (spam, marketing, AI-generated mail, etc.).
        </p>
      </div>

      {/* Existing labels */}
      <div className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {labels.map((label: EmailLabelDefinition) => (
          <div key={label.id} className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: label.color }}
              />
              <span className="text-sm font-medium">{label.name}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => deleteMutation.mutate(label.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {!isLoading && labels.length === 0 && (
          <p className="text-sm text-muted-foreground">No labels yet. Add one below.</p>
        )}
      </div>

      {/* Add new label */}
      <div className="space-y-3 rounded-md border p-4">
        <p className="text-sm font-medium">Add label</p>
        <div className="flex gap-2">
          <Input
            placeholder="Label name (e.g. spam, marketing)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) createMutation.mutate();
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`h-6 w-6 rounded-full border-2 transition-transform ${newColor === c ? "border-foreground scale-110" : "border-transparent"}`}
              style={{ backgroundColor: c }}
              onClick={() => setNewColor(c)}
            />
          ))}
        </div>
        <Button
          size="sm"
          onClick={() => createMutation.mutate()}
          disabled={!newName.trim() || createMutation.isPending}
        >
          <Tag className="h-3.5 w-3.5 mr-1.5" />
          Add Label
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the route in App.tsx**

In `ui/src/App.tsx`, add the import near other company-level page imports:

```typescript
import { EmailLabels } from "./pages/EmailLabels";
```

Then find the company route block (around line 153 where `company/settings` is registered) and add:

```tsx
<Route path="company/email-labels" element={<EmailLabels />} />
```

Add a nav link in the company sidebar or email accounts page pointing to `email-labels` so the operator can reach it. Find the nav link list in `ui/src/components/Sidebar.tsx` or equivalent and add an entry with path `company/email-labels` and label "Email Labels".

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Fix any errors before proceeding.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/EmailLabels.tsx ui/src/App.tsx
git commit -m "feat(ui): add Email Labels settings page"
```

---

### Task 11: Final verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm -r typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Full test run**

```bash
pnpm test:run
```

Expected: all tests pass, including the new `mcp-email-label-gates` suite.

- [ ] **Step 3: Build check**

```bash
pnpm build
```

Expected: clean build, no errors.

- [ ] **Step 4: Manual smoke test**

Start dev server:
```bash
pnpm dev
```

1. Open Email Inbox — confirm label dropdown appears on email detail.
2. Select a label — confirm email processingState flips to "ignored".
3. Open Settings → Email Labels — confirm labels list and create/delete work.
4. Start a fresh orchestrator run via Telegram with an inbound email that has no existing issue — confirm EA sends a notify_operator message and stops (does not create an issue).

- [ ] **Step 5: Final commit if any loose changes**

```bash
git status
# commit anything uncommitted
```
