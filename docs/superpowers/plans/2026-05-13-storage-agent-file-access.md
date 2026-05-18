# Storage & Agent File Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File all inbound attachments into a configured storage root (local path or Google Drive), expose storage management to agents via MCP tools, classify unknown email senders, and inject client folder paths into agent context.

**Architecture:** New DB table for blocked domains + `discardedAt` on operator_messages. Seven new MCP tools in `mcp-tool-server.ts`. Backfill function in `client-storage.ts`. Spam check in `email-processor.ts`. Unknown sender routing fix in `inbound-router.ts`. Enriched MCP responses with `clientFolderPath`. Storage banner component in UI.

**Tech Stack:** Express 5, Drizzle ORM, PGlite/Postgres, React 19, Tailwind 4, Vitest

---

## File Map

| File | Change |
|------|--------|
| `packages/db/src/schema/blocked_sender_domains.ts` | **Create** — new table |
| `packages/db/src/schema/operator_messages.ts` | **Modify** — add `discardedAt` |
| `packages/db/src/schema/index.ts` | **Modify** — export new table |
| `server/src/services/client-storage.ts` | **Modify** — `hasStorageRoot`, `backfillClientAttachments`, WhatsApp/Telegram filing |
| `server/src/routes/mcp-tool-server.ts` | **Modify** — 7 new tools + enriched responses |
| `server/src/services/email-processor.ts` | **Modify** — spam check before EA wakeup |
| `server/src/services/inbound-router.ts` | **Modify** — unknown sender routes as `client` not `operator` |
| `ui/src/components/StorageSetupBanner.tsx` | **Create** — banner when no storage root |
| `server/src/onboarding-assets/ea-operator/AGENTS.md` | **Modify** — classification flow |
| `server/src/onboarding-assets/ea-operator/TOOLS.md` | **Modify** — new tool docs (already partially updated) |
| `server/src/__tests__/client-storage.test.ts` | **Create** — unit tests |
| `server/src/__tests__/mcp-storage-tools.test.ts` | **Create** — MCP tool integration tests |

---

## Task 1: Schema — `blocked_sender_domains` + `operator_messages.discardedAt`

**Files:**
- Create: `packages/db/src/schema/blocked_sender_domains.ts`
- Modify: `packages/db/src/schema/operator_messages.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create `blocked_sender_domains.ts`**

```typescript
// packages/db/src/schema/blocked_sender_domains.ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const blockedSenderDomains = pgTable(
  "blocked_sender_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("blocked_sender_domains_company_idx").on(table.companyId),
    uniqueDomain: uniqueIndex("blocked_sender_domains_company_domain_idx").on(
      table.companyId,
      table.domain,
    ),
  }),
);
```

- [ ] **Step 2: Add `discardedAt` to `operator_messages.ts`**

Open `packages/db/src/schema/operator_messages.ts`. After `rawPayload: jsonb("raw_payload"),` add:

```typescript
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
```

- [ ] **Step 3: Export from schema index**

Open `packages/db/src/schema/index.ts`. After the `operatorMessages` export line add:

```typescript
export { blockedSenderDomains } from "./blocked_sender_domains.js";
```

- [ ] **Step 4: Generate migration**

```bash
pnpm db:generate
```

Expected: new migration file in `packages/db/drizzle/` containing `CREATE TABLE blocked_sender_domains` and `ALTER TABLE operator_messages ADD COLUMN discarded_at`.

- [ ] **Step 5: Apply migration and typecheck**

```bash
pnpm db:migrate && pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/blocked_sender_domains.ts packages/db/src/schema/operator_messages.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): add blocked_sender_domains table and operator_messages.discardedAt"
```

---

## Task 2: `client-storage.ts` — `hasStorageRoot` + `backfillClientAttachments`

**Files:**
- Modify: `server/src/services/client-storage.ts`
- Create: `server/src/__tests__/client-storage.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/client-storage.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hasStorageRoot, backfillClientAttachments } from "../services/client-storage.js";
import { companies, clients, emailMessages, emailAttachments, emailAccounts } from "@paperclipai/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("client-storage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-client-storage-");
    db = createDb(tempDb.connectionString);
    const [co] = await db.insert(companies).values({ name: "Test Co" }).returning();
    companyId = co!.id;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("hasStorageRoot", () => {
    it("returns false when no root configured", async () => {
      expect(await hasStorageRoot(db, companyId)).toBe(false);
    });

    it("returns true when localPath set", async () => {
      await db.update(companies)
        .set({ storageLocalPath: "/tmp/test" })
        .where(eq(companies.id, companyId));
      expect(await hasStorageRoot(db, companyId)).toBe(true);
    });
  });

  describe("backfillClientAttachments", () => {
    it("no-ops when client has no localPath or driveFolderId", async () => {
      const [client] = await db.insert(clients).values({ companyId, name: "Acme" }).returning();
      // Should not throw
      await expect(backfillClientAttachments(db, client!.id)).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run server/src/__tests__/client-storage.test.ts
```

Expected: FAIL — `hasStorageRoot` and `backfillClientAttachments` not exported.

- [ ] **Step 3: Add `hasStorageRoot` to `client-storage.ts`**

Open `server/src/services/client-storage.ts`. After the `listCompaniesWithStorage` function, add:

```typescript
export async function hasStorageRoot(db: Db, companyId: string): Promise<boolean> {
  const root = await getCompanyStorageRoot(db, companyId);
  return !!(root.localPath || root.driveFolderId);
}
```

- [ ] **Step 4: Add `backfillClientAttachments` to `client-storage.ts`**

At the bottom of `server/src/services/client-storage.ts`, add the needed imports and the function. First add to imports at the top of the file:

```typescript
import { emailMessages, emailAttachments } from "@paperclipai/db";
import { isNull, inArray } from "drizzle-orm";
```

Then add the function:

```typescript
/**
 * Files all unfiled email attachments for a client into their storage folder.
 * Fire-and-forget safe — caller should not await in hot paths.
 */
export async function backfillClientAttachments(db: Db, clientId: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client || (!client.localPath && !client.driveFolderId)) return;

  const emails = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(eq(emailMessages.matchedClientId, clientId));

  if (emails.length === 0) return;
  const emailIds = emails.map((e) => e.id);

  const unfiled = await db
    .select()
    .from(emailAttachments)
    .where(and(inArray(emailAttachments.emailMessageId, emailIds), isNull(emailAttachments.filedAt)));

  for (const att of unfiled) {
    if (!att.storagePath) continue;
    await fileAttachmentToClientFolder(db, att.storagePath, att.filename, clientId, "emails", att.id);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm vitest run server/src/__tests__/client-storage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/client-storage.ts server/src/__tests__/client-storage.test.ts
git commit -m "feat(storage): hasStorageRoot + backfillClientAttachments"
```

---

## Task 3: MCP Tools — Storage Management

Add `set_storage_root`, `ensure_client_folder`, `ensure_project_folder` to `server/src/routes/mcp-tool-server.ts`.

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`
- Create: `server/src/__tests__/mcp-storage-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/mcp-storage-tools.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companies, agents } from "@paperclipai/db";
import { createApp } from "../app.js";
import { signMcpToken } from "../services/mcp-session-token.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("MCP storage tools", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: Express.Application;
  let token: string;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-storage-");
    db = createDb(tempDb.connectionString);
    app = createApp(db);

    const [co] = await db.insert(companies).values({ name: "Test Co" }).returning();
    companyId = co!.id;
    const [ag] = await db.insert(agents).values({
      companyId,
      name: "EA",
      adapterType: "ea",
      status: "idle",
    }).returning();
    token = await signMcpToken(db, ag!.id);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("set_storage_root sets localPath", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "set_storage_root",
        arguments: { localPath: "/tmp/test-storage" },
      }});
    expect(res.status).toBe(200);
    const result = JSON.parse(res.body.result.content[0].text);
    expect(result.localPath).toBe("/tmp/test-storage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run server/src/__tests__/mcp-storage-tools.test.ts
```

Expected: FAIL — `set_storage_root` not found in tool list.

- [ ] **Step 3: Add tool definitions to TOOLS array in `mcp-tool-server.ts`**

Open `server/src/routes/mcp-tool-server.ts`. In the `TOOLS` array, after the last existing tool definition, add:

```typescript
  {
    name: "set_storage_root",
    description: "Set the company storage root for filing attachments and client folders. Pass localPath for a local filesystem path (including mounted Google Drive). Pass driveFolderId for a Google Drive folder ID.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute local path (e.g. /home/user/Google Drive/Paperclip)" },
        driveFolderId: { type: "string", description: "Google Drive folder ID" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "ensure_client_folder",
    description: "Create the storage folder for a client (if it doesn't exist) and backfill all unfiled attachments into it. Call after set_storage_root or after creating a client.",
    inputSchema: {
      type: "object",
      required: ["clientId"],
      properties: {
        clientId: { type: "string", description: "UUID of the client" },
      },
    },
  },
  {
    name: "ensure_project_folder",
    description: "Create the storage folder for a project under its client folder.",
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string", description: "UUID of the project" },
      },
    },
  },
```

- [ ] **Step 4: Add imports to `mcp-tool-server.ts`**

At the top of the file, add imports (after existing imports):

```typescript
import {
  setCompanyStorageRoot,
  hasStorageRoot,
  backfillClientAttachments,
} from "../services/client-storage.js";
import { ensureClientFolder, ensureProjectFolder } from "../services/client-storage.js";
```

Note: `ensureClientFolder` and `ensureProjectFolder` are already in `client-storage.ts`. Merge the import if needed.

- [ ] **Step 5: Add tool handlers in the `callTool` function**

In `mcp-tool-server.ts`, find the `callTool` switch/if block. Add handlers after the existing ones:

```typescript
  if (name === "set_storage_root") {
    const { localPath, driveFolderId, companyId: argCompanyId } = args as {
      localPath?: string; driveFolderId?: string; companyId?: string;
    };
    const targetCompanyId = argCompanyId ?? agent.companyId;
    await setCompanyStorageRoot(db, targetCompanyId, {
      localPath: localPath ?? null,
      driveFolderId: driveFolderId ?? null,
    });
    const root = { localPath: localPath ?? null, driveFolderId: driveFolderId ?? null };
    return ok(id, textContent(JSON.stringify(root)));
  }

  if (name === "ensure_client_folder") {
    const { clientId } = args as { clientId: string };
    await ensureClientFolder(db, clientId);
    // backfill is fire-and-forget
    backfillClientAttachments(db, clientId).catch((err) =>
      logger.warn({ err, clientId }, "mcp: backfillClientAttachments failed"),
    );
    return ok(id, textContent(`Client folder ensured for ${clientId}. Backfill started.`));
  }

  if (name === "ensure_project_folder") {
    const { projectId } = args as { projectId: string };
    await ensureProjectFolder(db, projectId);
    return ok(id, textContent(`Project folder ensured for ${projectId}.`));
  }
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm vitest run server/src/__tests__/mcp-storage-tools.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts server/src/__tests__/mcp-storage-tools.test.ts server/src/services/client-storage.ts
git commit -m "feat(mcp): add set_storage_root, ensure_client_folder, ensure_project_folder tools"
```

---

## Task 4: MCP Tools — Sender Classification

Add `create_client`, `create_contact`, `block_sender_domain`, `discard_message`.

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Add tool definitions to TOOLS array**

In the `TOOLS` array in `mcp-tool-server.ts`, append:

```typescript
  {
    name: "create_client",
    description: "Create a new client record. Automatically creates their storage folder and backfills existing attachments. Use when an unknown sender is confirmed as a new client.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Client display name" },
        emailDomain: { type: "string", description: "Primary email domain (e.g. acme.com)" },
        extraEmails: { type: "array", items: { type: "string" }, description: "Individual email addresses to route to this client" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "create_contact",
    description: "Create or update a contact record. Use to register a specific email address with a role (partner, vendor, referral, internal). Link to an existing client with clientId.",
    inputSchema: {
      type: "object",
      required: ["email", "role"],
      properties: {
        email: { type: "string", description: "Contact email address" },
        name: { type: "string", description: "Contact display name" },
        role: { type: "string", description: "partner | vendor | referral | internal | client" },
        clientId: { type: "string", description: "UUID of client to link this contact to" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "block_sender_domain",
    description: "Block all future emails from a domain. Emails from blocked domains are silently discarded without creating issues or notifying the operator.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain to block (e.g. spam.com)" },
        reason: { type: "string", description: "Why this domain is blocked" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "discard_message",
    description: "Mark a specific operator message as discarded. One-off action — does not block the sender's domain. Use for single irrelevant messages.",
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string", description: "UUID of the operator_messages row to discard" },
        reason: { type: "string", description: "Why this message is discarded" },
      },
    },
  },
```

- [ ] **Step 2: Add imports**

At the top of `mcp-tool-server.ts`, ensure these are imported (add to existing import from `@paperclipai/db`):

```typescript
import { ..., blockedSenderDomains, operatorMessages } from "@paperclipai/db";
```

Also ensure `clientService` and `contactService` are imported:

```typescript
import { clientService } from "../services/clients.js";
import { contactService } from "../services/contacts.js";
```

- [ ] **Step 3: Add handlers in the `callTool` function**

After the storage tools handlers, add:

```typescript
  if (name === "create_client") {
    const { name: clientName, emailDomain, extraEmails, companyId: argCompanyId } = args as {
      name: string; emailDomain?: string; extraEmails?: string[]; companyId?: string;
    };
    const targetCompanyId = argCompanyId ?? agent.companyId;
    const svc = clientService(db);
    const client = await svc.create(targetCompanyId, {
      name: clientName,
      emailDomain: emailDomain ?? null,
      extraEmails: extraEmails ?? [],
    });
    // clientService.create already calls ensureClientFolder + backfill runs async
    return ok(id, textContent(JSON.stringify({ clientId: client.id, name: client.name })));
  }

  if (name === "create_contact") {
    const { email, name: contactName, role, clientId, companyId: argCompanyId } = args as {
      email: string; name?: string; role: string; clientId?: string; companyId?: string;
    };
    const targetCompanyId = argCompanyId ?? agent.companyId;
    const svc = contactService(db);
    const contact = await svc.upsertByEmail(targetCompanyId, email, clientId ?? null);
    if (contactName || role) {
      await svc.update(targetCompanyId, contact.id, {
        firstName: contactName?.split(" ")[0],
        lastName: contactName?.split(" ").slice(1).join(" ") || undefined,
        role,
      });
    }
    return ok(id, textContent(JSON.stringify({ contactId: contact.id, email: contact.email })));
  }

  if (name === "block_sender_domain") {
    const { domain, reason, companyId: argCompanyId } = args as {
      domain: string; reason?: string; companyId?: string;
    };
    const targetCompanyId = argCompanyId ?? agent.companyId;
    await db.insert(blockedSenderDomains)
      .values({ companyId: targetCompanyId, domain: domain.toLowerCase(), reason: reason ?? null })
      .onConflictDoNothing();
    return ok(id, textContent(`Domain ${domain} blocked.`));
  }

  if (name === "discard_message") {
    const { messageId, reason } = args as { messageId: string; reason?: string };
    const patch: Record<string, unknown> = { discardedAt: new Date() };
    // rawPayload is only set if reason provided; don't overwrite existing payload
    if (reason) {
      patch.rawPayload = { discardReason: reason };
    }
    await db.update(operatorMessages)
      .set(patch)
      .where(eq(operatorMessages.id, messageId));
    return ok(id, textContent(`Message ${messageId} discarded.`));
  }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors. Fix any import issues if `blockedSenderDomains` import conflicts with existing destructuring.

- [ ] **Step 5: Run all server tests**

```bash
pnpm vitest run server/src/__tests__/mcp-storage-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add create_client, create_contact, block_sender_domain, discard_message tools"
```

---

## Task 5: Spam Check in `email-processor.ts`

**Files:**
- Modify: `server/src/services/email-processor.ts`

- [ ] **Step 1: Add import**

At the top of `server/src/services/email-processor.ts`, ensure `blockedSenderDomains` is imported:

```typescript
import { ..., blockedSenderDomains } from "@paperclipai/db";
```

- [ ] **Step 2: Add the spam check**

In `email-processor.ts`, find the `routeInbound` function (around line 445+). Locate where `fromAddr` is extracted from the email message. Add the spam check immediately before the triage agent lookup:

```typescript
  // Spam domain check — applies before any routing or wakeup
  const fromDomain = fromAddr.split("@")[1]?.toLowerCase() ?? "";
  if (fromDomain) {
    const [blocked] = await db
      .select({ id: blockedSenderDomains.id })
      .from(blockedSenderDomains)
      .where(
        and(
          eq(blockedSenderDomains.companyId, companyId),
          eq(blockedSenderDomains.domain, fromDomain),
        ),
      )
      .limit(1);
    if (blocked) {
      logger.info({ emailMessageId, fromAddr }, "email-processor: discarding email from blocked domain");
      return;
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
git add server/src/services/email-processor.ts
git commit -m "feat(email): discard emails from blocked sender domains before routing"
```

---

## Task 6: Fix Unknown Sender Routing in `inbound-router.ts`

**Files:**
- Modify: `server/src/services/inbound-router.ts`

Currently, when `resolveClientByEmail` returns `undefined` for an email, `fromType` stays `"operator"`. Fix: route unknown email senders as `"client"` with no `clientId`, so the EA/orchestrator handles classification.

- [ ] **Step 1: Update the routing logic**

Open `server/src/services/inbound-router.ts`. Find this block (around line 45-55):

```typescript
  } else if (platform === "email") {
    const resolved = await resolveClientByEmail(db, companyId, fromAddr);
    if (resolved) {
      fromType = "client";
      clientId = resolved;
    }
  }
```

Replace with:

```typescript
  } else if (platform === "email") {
    const resolved = await resolveClientByEmail(db, companyId, fromAddr);
    if (resolved) {
      fromType = "client";
      clientId = resolved;
    } else {
      // Unknown sender — route as client so orchestrator/EA can classify
      fromType = "client";
      clientId = undefined;
    }
  }
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Run related tests**

```bash
pnpm vitest run server/src/__tests__/
```

Expected: no regressions. If any test asserts operator routing for unknown email senders, update the assertion to `"client"`.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/inbound-router.ts
git commit -m "fix(routing): route unknown email senders as client not operator"
```

---

## Task 7: Enrich MCP Responses with `clientFolderPath`

Add `clientFolderPath` to `list_issues`, `create_issue`, and `get_client` responses. Also add it to `get_email_message` (defined in the intake gate spec — add the field there when implementing that plan; note it here for cross-reference).

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

The `clientFolderPath` value is: `client.localPath` if set, else `drive:<client.driveFolderId>` if set, else `null`.

- [ ] **Step 1: Add `getClientFolderPath` helper**

In `mcp-tool-server.ts`, add a helper near the top of the file (after the imports):

```typescript
function getClientFolderPath(client: { localPath: string | null; driveFolderId: string | null } | null | undefined): string | null {
  if (!client) return null;
  if (client.localPath) return client.localPath;
  if (client.driveFolderId) return `drive:${client.driveFolderId}`;
  return null;
}
```

- [ ] **Step 2: Enrich `list_issues` response**

The current `list_issues` handler (line ~584) selects `id, identifier, title, status, priority, assigneeAgentId, description` — no `clientId`. Update it:

```typescript
  if (name === "list_issues") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    const filters = [eq(issues.companyId, effectiveCompanyId)];
    if (args.status) filters.push(eq(issues.status, String(args.status)));
    if (args.priority) filters.push(eq(issues.priority, String(args.priority)));

    const rows = await db
      .select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
        status: issues.status, priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId, description: issues.description,
        clientId: issues.clientId,
      })
      .from(issues)
      .where(and(...filters))
      .orderBy(desc(issues.updatedAt))
      .limit(limit);

    // Enrich with clientFolderPath
    const clientIds = [...new Set(rows.flatMap(r => r.clientId ? [r.clientId] : []))];
    const clientRows = clientIds.length > 0
      ? await db.select({ id: clients.id, localPath: clients.localPath, driveFolderId: clients.driveFolderId })
          .from(clients).where(inArray(clients.id, clientIds))
      : [];
    const folderMap = new Map(clientRows.map(c => [c.id, getClientFolderPath(c)]));

    const enriched = rows.map(r => ({
      ...r,
      clientFolderPath: r.clientId ? (folderMap.get(r.clientId) ?? null) : null,
    }));

    return JSON.stringify(enriched, null, 2);
  }
```

Add `inArray` to the drizzle imports at the top if not already present.

- [ ] **Step 3: Enrich `create_issue` response**

The current handler (line ~604) inserts and returns `created`. After the insert, add:

```typescript
    // Enrich with clientFolderPath
    let issueClientFolderPath: string | null = null;
    if (args.clientId) {
      const [cl] = await db
        .select({ localPath: clients.localPath, driveFolderId: clients.driveFolderId })
        .from(clients)
        .where(eq(clients.id, String(args.clientId)))
        .limit(1);
      issueClientFolderPath = getClientFolderPath(cl ?? null);
    }

    return JSON.stringify({ ...created, clientFolderPath: issueClientFolderPath }, null, 2);
```

Remove the original `return JSON.stringify(created, null, 2);` line.

- [ ] **Step 4: Enrich `get_client` response**

Find the `get_client` handler (line ~1108). It currently queries issues for a client. Find where it returns the client data and add `localPath` and `driveFolderId`:

```typescript
    const [cl] = await db
      .select({
        id: clients.id, name: clients.name, emailDomain: clients.emailDomain,
        extraEmails: clients.extraEmails, trustLevel: clients.trustLevel,
        notes: clients.notes, localPath: clients.localPath, driveFolderId: clients.driveFolderId,
        clientFolderPath: sql<string | null>`CASE WHEN ${clients.localPath} IS NOT NULL THEN ${clients.localPath} WHEN ${clients.driveFolderId} IS NOT NULL THEN 'drive:' || ${clients.driveFolderId} END`,
      })
      .from(clients)
      .where(eq(clients.id, gcId))
      .limit(1);
```

Add `sql` to drizzle imports at top if not already present.

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): include clientFolderPath in list_issues, create_issue, get_client responses"
```

---

## Task 8: Storage Warning Notification

When an inbound message arrives and no storage root is configured, notify the operator once per day.

**Files:**
- Modify: `server/src/services/client-storage.ts`
- Modify: `server/src/services/email-processor.ts` (add call)

- [ ] **Step 1: Add `notifyStorageNotConfigured` helper to `client-storage.ts`**

```typescript
import { operatorMessages } from "@paperclipai/db";
import { desc } from "drizzle-orm";
import { sendTelegramMessage } from "./telegram-adapter.js";
import { readInstanceToken } from "./instance-token-store.js";

const STORAGE_WARN_BODY = "⚠️ No storage root configured. Reply with: set storage to <path> — or configure at Settings → Storage.";

/**
 * Sends a Telegram notification to the operator if storage root is missing.
 * Throttled to once per day per company.
 */
export async function notifyStorageNotConfigured(db: Db, companyId: string): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ id: operatorMessages.id })
    .from(operatorMessages)
    .where(
      and(
        eq(operatorMessages.companyId, companyId),
        eq(operatorMessages.body, STORAGE_WARN_BODY),
        gte(operatorMessages.createdAt, oneDayAgo),
      ),
    )
    .limit(1);
  if (recent) return;

  try {
    const token = await readInstanceToken(db);
    if (token?.telegramBotToken && token?.telegramChatId) {
      await sendTelegramMessage(token.telegramBotToken, token.telegramChatId, STORAGE_WARN_BODY);
      await db.insert(operatorMessages).values({
        companyId,
        direction: "outbound",
        platform: "telegram",
        source: "system",
        body: STORAGE_WARN_BODY,
      });
    }
  } catch {
    // Non-fatal
  }
}
```

- [ ] **Step 2: Call from `email-processor.ts`**

In `email-processor.ts`, in the `routeInbound` function, after the spam check and before the triage agent lookup, add:

```typescript
  // Notify operator if no storage root (throttled to once/day)
  if (!(await hasStorageRoot(db, companyId))) {
    notifyStorageNotConfigured(db, companyId).catch(() => {});
  }
```

Add the import at the top:

```typescript
import { hasStorageRoot, notifyStorageNotConfigured } from "./client-storage.js";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/client-storage.ts server/src/services/email-processor.ts
git commit -m "feat(storage): notify operator once/day when storage root not configured"
```

---

## Task 9: `StorageSetupBanner` UI Component

**Files:**
- Create: `ui/src/components/StorageSetupBanner.tsx`
- Modify: company settings or dashboard page (wherever the company overview is shown)

- [ ] **Step 1: Find where to place the banner**

```bash
grep -rn "storageLocalPath\|storage.*root\|StorageRoot" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/ui/src/ --include="*.tsx" | head -10
```

This will tell you which UI page already queries or displays storage settings. Place the banner on that page.

- [ ] **Step 2: Create `StorageSetupBanner.tsx`**

```tsx
// ui/src/components/StorageSetupBanner.tsx
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FolderSelector, type FolderSelection } from "./FolderSelector.js";

interface StorageSetupBannerProps {
  companyId: string;
  onConfigured: () => void;
}

export function StorageSetupBanner({ companyId, onConfigured }: StorageSetupBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: async (body: { localPath: string | null; driveFolderId: string | null }) => {
      const res = await fetch(`/api/companies/${companyId}/storage/root`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save storage root");
    },
    onSuccess: () => { setOpen(false); onConfigured(); },
  });

  if (dismissed) return null;

  function handleSelect(selection: FolderSelection) {
    if (selection.type === "local") {
      mutate({ localPath: selection.path, driveFolderId: null });
    } else if (selection.type === "drive") {
      mutate({ localPath: null, driveFolderId: selection.folderId });
    }
  }

  return (
    <div className="rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 flex items-start gap-3 text-sm">
      <span className="text-yellow-600 font-medium">Storage not configured</span>
      <span className="text-yellow-700 flex-1">
        Attachments from email, WhatsApp, and Telegram won't be filed until you set a storage location.
      </span>
      <div className="flex gap-2 shrink-0">
        <button
          className="text-yellow-700 underline hover:no-underline"
          onClick={() => setOpen(true)}
        >
          Configure
        </button>
        <button
          className="text-yellow-500 hover:text-yellow-700"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-lg shadow-lg p-6 w-96">
            <h2 className="font-semibold mb-3">Set Storage Location</h2>
            <FolderSelector companyId={companyId} onSelect={handleSelect} />
            {isPending && <p className="text-xs text-muted-foreground mt-2">Saving…</p>}
            <button
              className="mt-3 text-sm text-muted-foreground hover:underline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add banner to the relevant page**

Using the grep result from Step 1, open the relevant page file. Import `StorageSetupBanner` and add it at the top of the page content when `storageLocalPath` and `storageDriveFolderId` are both null:

```tsx
{!company.storageLocalPath && !company.storageDriveFolderId && (
  <StorageSetupBanner
    companyId={company.id}
    onConfigured={() => refetch()}
  />
)}
```

- [ ] **Step 4: Build and verify no TypeScript errors**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/StorageSetupBanner.tsx
git commit -m "feat(ui): StorageSetupBanner shown when no storage root configured"
```

---

## Task 10: Update EA Operator AGENTS.md

**Files:**
- Modify: `server/src/onboarding-assets/ea-operator/AGENTS.md`
- Modify: `server/src/onboarding-assets/ea-operator/TOOLS.md`

- [ ] **Step 1: Update AGENTS.md email triage section**

Open `server/src/onboarding-assets/ea-operator/AGENTS.md`. Find the email triage section and replace with:

```markdown
## Email triage
When woken with payload { emailMessageId }:
1. Call get_email_message(emailMessageId) — read email, thread history, existingIssueId, clientFolderPath
2. If existingIssueId set:
   - Call get_issue_context(existingIssueId) to read full issue history
   - Add comment summarising new email via add_issue_comment
   - Call update_issue status=in_progress
   - Notify operator if thread_reply_received enabled in matrix
   - Stop — do NOT create a new issue or plan
3. If no existingIssueId:
   a. Identify sender: call search_contacts(email=fromAddr) and search_clients(name=emailDomain)
   b. If sender unknown (no match):
      - Propose classification to operator via notify_operator:
        "New email from <fromAddr> — <Subject>. What is this?
        A) New client  B) Vendor  C) Partner of [client name]  D) Block domain  E) Discard once"
      - Wait for operator reply. Then call:
        - A → create_client + ensure_client_folder
        - B → create_contact(role=vendor)
        - C → create_contact(role=partner, clientId=<id>)
        - D → block_sender_domain
        - E → discard_message
      - Only continue to step (c) if A or C chosen
   c. Call search_memory(senderIdentifier=fromAddr) for prior context
   d. Score email 0-100 (see scoring rubric below)
   e. Score < 60: create_memory(memoryType=passive), stop
   f. Score ≥ 60: search_topics → create_topic if needed → create_plan(emailMessageId, title, proposalText, assigneeAgentId)
```

- [ ] **Step 2: Update TOOLS.md with new storage and classification tools**

Open `server/src/onboarding-assets/ea-operator/TOOLS.md`. Add after the existing `## Config` section:

```markdown
## Storage
- `set_storage_root` — set company storage path (localPath or driveFolderId)
- `ensure_client_folder` — create client folder and backfill existing attachments
- `ensure_project_folder` — create project folder under client folder

## Sender Classification
- `create_client` — create new client record (auto-creates folder + backfills)
- `create_contact` — create/update contact with role (partner/vendor/referral/internal)
- `block_sender_domain` — block all future emails from a domain
- `discard_message` — discard a single message without blocking the domain
```

- [ ] **Step 3: Commit**

```bash
git add server/src/onboarding-assets/ea-operator/AGENTS.md server/src/onboarding-assets/ea-operator/TOOLS.md
git commit -m "docs(ea): update AGENTS.md with classification flow and TOOLS.md with new tools"
```

---

## Task 11: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm test:run
```

Expected: all tests pass.

- [ ] **Step 2: Typecheck all workspaces**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Manual smoke test — set storage via agent**

Start the dev server: `pnpm dev`

Send via Telegram: *"Set my storage to /tmp/paperclip-test"*

Verify in DB:
```sql
SELECT storage_local_path FROM companies WHERE id = '<your-company-id>';
```

Expected: `/tmp/paperclip-test`

- [ ] **Step 5: Manual smoke test — block domain**

Send via Telegram: *"Block emails from spam.com"*

Verify in DB:
```sql
SELECT * FROM blocked_sender_domains WHERE domain = 'spam.com';
```

Expected: row exists.
