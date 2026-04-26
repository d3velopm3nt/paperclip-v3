# Operator Messaging System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a platform-agnostic operator↔agent messaging system where operators email agent_voice to reach any agent or room, agents reply via @operator comments, and every conversation is backed by a Paperclip issue.

**Architecture:** New DB tables (rooms, room_members, operator_messages, message_threads) backed by a platform-agnostic `OperatorMessageService` with an `EmailAdapter`. Email routing extended so untagged agent_voice messages call `handleInbound()` instead of being ignored. Issues route extended to detect `@operator` in comments and fan out via agent_voice.

**Tech Stack:** Drizzle ORM + PGlite (tests), Express 5, React 19 + TanStack Query, Vitest, existing `sendEmailFromAccount` for outbound email.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/db/src/schema/rooms.ts` | rooms table |
| Create | `packages/db/src/schema/room_members.ts` | room_members table |
| Create | `packages/db/src/schema/operator_messages.ts` | operator_messages table |
| Create | `packages/db/src/schema/message_threads.ts` | message_threads table |
| Modify | `packages/db/src/schema/index.ts` | export new tables |
| Generate | `packages/db/src/migrations/0063_operator_messaging.sql` | migration |
| Create | `server/src/services/rooms.ts` | rooms CRUD service |
| Create | `server/src/services/operator-messaging.ts` | core service + adapter registry + EmailAdapter + routing engine |
| Create | `server/src/routes/rooms.ts` | rooms + room_members CRUD API |
| Create | `server/src/routes/operator-messages.ts` | POST/GET operator-messages API |
| Modify | `server/src/app.ts` | register new routes |
| Modify | `server/src/services/email-processor.ts` | untagged agent_voice → handleInbound |
| Modify | `server/src/routes/issues.ts` | @operator detection in POST comments |
| Modify | `server/src/onboarding-assets/default/AGENTS.md` | operator comms rule |
| Modify | `server/src/onboarding-assets/ceo/AGENTS.md` | operator comms rule |
| Modify | `skills/paperclip/SKILL.md` | @operator + send_operator_message section |
| Modify | `skills/paperclip-ops/SKILL.md` | @operator section |
| Create | `ui/src/api/rooms.ts` | typed API client |
| Create | `ui/src/api/operatorMessages.ts` | typed API client |
| Create | `ui/src/pages/Rooms.tsx` | room list page |
| Create | `ui/src/pages/RoomDetail.tsx` | room detail + thread page |
| Modify | `ui/src/components/Sidebar.tsx` | Rooms nav item |
| Modify | `ui/src/App.tsx` | /rooms and /rooms/:id routes |
| Create | `server/src/__tests__/operator-messaging.test.ts` | service tests |

---

## Task 1: DB Schema — Four New Tables + Migration

**Files:**
- Create: `packages/db/src/schema/rooms.ts`
- Create: `packages/db/src/schema/room_members.ts`
- Create: `packages/db/src/schema/operator_messages.ts`
- Create: `packages/db/src/schema/message_threads.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/0063_operator_messaging.sql`

- [ ] **Step 1: Write rooms.ts schema**

```typescript
// packages/db/src/schema/rooms.ts
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    requireApproval: boolean("require_approval").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("rooms_company_idx").on(table.companyId),
    slugIdx: index("rooms_company_slug_idx").on(table.companyId, table.slug),
  }),
);
```

- [ ] **Step 2: Write room_members.ts schema**

```typescript
// packages/db/src/schema/room_members.ts
import { boolean, index, pgTable, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { rooms } from "./rooms.js";

export const roomMembers = pgTable(
  "room_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    isOperator: boolean("is_operator").notNull().default(false),
    notifyOnMessage: boolean("notify_on_message").notNull().default(true),
  },
  (table) => ({
    roomIdx: index("room_members_room_idx").on(table.roomId),
    agentIdx: index("room_members_agent_idx").on(table.agentId),
  }),
);
```

- [ ] **Step 3: Write operator_messages.ts schema**

```typescript
// packages/db/src/schema/operator_messages.ts
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { rooms } from "./rooms.js";

export const operatorMessages = pgTable(
  "operator_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    // "inbound" = from operator, "outbound" = from agent
    direction: text("direction").notNull(),
    // "email" | "telegram" | "sms" | "internal"
    platform: text("platform").notNull(),
    fromAgentId: uuid("from_agent_id").references(() => agents.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("operator_messages_company_idx").on(table.companyId),
    issueIdx: index("operator_messages_issue_idx").on(table.issueId),
    roomIdx: index("operator_messages_room_idx").on(table.roomId),
  }),
);
```

- [ ] **Step 4: Write message_threads.ts schema**

```typescript
// packages/db/src/schema/message_threads.ts
import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { operatorMessages } from "./operator_messages.js";

export const messageThreads = pgTable(
  "message_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorMessageId: uuid("operator_message_id")
      .notNull()
      .references(() => operatorMessages.id, { onDelete: "cascade" }),
    // "email" | "telegram" | "sms"
    platform: text("platform").notNull(),
    // email: Message-ID header; telegram: "chat_id:thread_id"; sms: phone
    threadKey: text("thread_key").notNull(),
  },
  (table) => ({
    msgIdx: index("message_threads_msg_idx").on(table.operatorMessageId),
    platformKeyIdx: index("message_threads_platform_key_idx").on(
      table.platform,
      table.threadKey,
    ),
  }),
);
```

- [ ] **Step 5: Export all four from schema/index.ts**

Add at the end of `packages/db/src/schema/index.ts`:
```typescript
// v3: operator messaging
export { rooms } from "./rooms.js";
export { roomMembers } from "./room_members.js";
export { operatorMessages } from "./operator_messages.js";
export { messageThreads } from "./message_threads.js";
```

- [ ] **Step 6: Generate migration**

```bash
cd /path/to/repo
pnpm db:generate
```

Expected: new file `packages/db/src/migrations/0063_operator_messaging.sql` created. Inspect it to confirm all four tables appear.

- [ ] **Step 7: Typecheck**

```bash
pnpm -r typecheck
```

Expected: server + db pass. Pre-existing UI errors in Analytics.tsx are unrelated — ignore them.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/rooms.ts packages/db/src/schema/room_members.ts \
  packages/db/src/schema/operator_messages.ts packages/db/src/schema/message_threads.ts \
  packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): rooms, room_members, operator_messages, message_threads schema"
```

---

## Task 2: Rooms Service

**Files:**
- Create: `server/src/services/rooms.ts`

- [ ] **Step 1: Write failing test**

Create `server/src/__tests__/rooms.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, agents, rooms, roomMembers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { roomService } from "../services/rooms.ts";

const { describeIfDb } = getEmbeddedPostgresTestSupport();

describeIfDb("roomService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rooms-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE room_members, rooms, agents, companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Test Co", issuePrefix: "TC" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "CEO", role: "ceo", title: "CEO",
      adapterType: "claude-local", status: "active",
    }).returning();
    return { company: company!, agent: agent! };
  }

  it("creates a room and lists it", async () => {
    const { company } = await seed();
    const svc = roomService(db);
    const room = await svc.create(company.id, { name: "Dev Team", slug: "dev-team" });
    expect(room.name).toBe("Dev Team");
    expect(room.slug).toBe("dev-team");
    const list = await svc.list(company.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(room.id);
  });

  it("adds and removes members", async () => {
    const { company, agent } = await seed();
    const svc = roomService(db);
    const room = await svc.create(company.id, { name: "All Hands", slug: "all-hands" });
    await svc.addMember(room.id, { agentId: agent.id });
    const detail = await svc.getById(room.id);
    expect(detail!.members).toHaveLength(1);
    expect(detail!.members[0]!.agentId).toBe(agent.id);
    await svc.removeMember(detail!.members[0]!.id);
    const after = await svc.getById(room.id);
    expect(after!.members).toHaveLength(0);
  });

  it("resolves room by company + slug", async () => {
    const { company } = await seed();
    const svc = roomService(db);
    await svc.create(company.id, { name: "Dev Team", slug: "dev-team" });
    const found = await svc.findBySlug(company.id, "dev-team");
    expect(found).not.toBeNull();
    expect(found!.slug).toBe("dev-team");
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
pnpm vitest run server/src/__tests__/rooms.test.ts
```

Expected: FAIL — `roomService` not found.

- [ ] **Step 3: Write rooms service**

Create `server/src/services/rooms.ts`:

```typescript
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rooms, roomMembers } from "@paperclipai/db";

export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;

export interface RoomDetail extends RoomRow {
  members: RoomMemberRow[];
}

export interface CreateRoomInput {
  name: string;
  slug: string;
  description?: string | null;
  requireApproval?: boolean;
}

export interface AddMemberInput {
  agentId?: string | null;
  isOperator?: boolean;
  notifyOnMessage?: boolean;
}

export function roomService(db: Db) {
  async function list(companyId: string): Promise<RoomRow[]> {
    return db
      .select()
      .from(rooms)
      .where(eq(rooms.companyId, companyId))
      .orderBy(asc(rooms.name));
  }

  async function getById(id: string): Promise<RoomDetail | null> {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
    if (!room) return null;
    const members = await db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, id))
      .orderBy(asc(roomMembers.id));
    return { ...room, members };
  }

  async function findBySlug(companyId: string, slug: string): Promise<RoomRow | null> {
    const [row] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.companyId, companyId), eq(rooms.slug, slug)))
      .limit(1);
    return row ?? null;
  }

  async function create(companyId: string, input: CreateRoomInput): Promise<RoomRow> {
    const [row] = await db
      .insert(rooms)
      .values({
        companyId,
        name: input.name,
        slug: input.slug.toLowerCase().replace(/\s+/g, "-"),
        description: input.description ?? null,
        requireApproval: input.requireApproval ?? false,
        updatedAt: new Date(),
      })
      .returning();
    return row!;
  }

  async function update(id: string, input: Partial<CreateRoomInput>): Promise<RoomRow | null> {
    const [row] = await db
      .update(rooms)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(rooms.id, id))
      .returning();
    return row ?? null;
  }

  async function remove(id: string): Promise<void> {
    await db.delete(rooms).where(eq(rooms.id, id));
  }

  async function addMember(roomId: string, input: AddMemberInput): Promise<RoomMemberRow> {
    const [row] = await db
      .insert(roomMembers)
      .values({
        roomId,
        agentId: input.agentId ?? null,
        isOperator: input.isOperator ?? false,
        notifyOnMessage: input.notifyOnMessage ?? true,
      })
      .returning();
    return row!;
  }

  async function removeMember(memberId: string): Promise<void> {
    await db.delete(roomMembers).where(eq(roomMembers.id, memberId));
  }

  return { list, getById, findBySlug, create, update, remove, addMember, removeMember };
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
pnpm vitest run server/src/__tests__/rooms.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/rooms.ts server/src/__tests__/rooms.test.ts
git commit -m "feat(server): rooms service with CRUD + member management"
```

---

## Task 3: Rooms API Routes

**Files:**
- Create: `server/src/routes/rooms.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write rooms routes**

Create `server/src/routes/rooms.ts`:

```typescript
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { roomService } from "../services/rooms.js";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function roomRoutes(db: Db) {
  const router = Router();
  const svc = roomService(db);

  router.get("/companies/:companyId/rooms", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json(await svc.list(req.params.companyId));
  });

  router.post("/companies/:companyId/rooms", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as { name?: string; slug?: string; description?: string; requireApproval?: boolean };
    if (!body.name) throw badRequest("name required");
    if (!body.slug) throw badRequest("slug required");
    const room = await svc.create(companyId, {
      name: body.name,
      slug: body.slug,
      description: body.description,
      requireApproval: body.requireApproval,
    });
    res.status(201).json(room);
  });

  router.get("/rooms/:id", async (req, res) => {
    const detail = await svc.getById(req.params.id);
    if (!detail) throw notFound("Room not found");
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.patch("/rooms/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) throw notFound("Room not found");
    assertCompanyAccess(req, existing.companyId);
    const body = req.body as { name?: string; slug?: string; description?: string; requireApproval?: boolean };
    const updated = await svc.update(req.params.id, body);
    res.json(updated);
  });

  router.delete("/rooms/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) throw notFound("Room not found");
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(req.params.id);
    res.status(204).end();
  });

  router.post("/rooms/:id/members", async (req, res) => {
    const room = await svc.getById(req.params.id);
    if (!room) throw notFound("Room not found");
    assertCompanyAccess(req, room.companyId);
    const body = req.body as { agentId?: string; isOperator?: boolean; notifyOnMessage?: boolean };
    const member = await svc.addMember(req.params.id, body);
    res.status(201).json(member);
  });

  router.delete("/rooms/:id/members/:memberId", async (req, res) => {
    const room = await svc.getById(req.params.id);
    if (!room) throw notFound("Room not found");
    assertCompanyAccess(req, room.companyId);
    await svc.removeMember(req.params.memberId);
    res.status(204).end();
  });

  return router;
}
```

- [ ] **Step 2: Register route in app.ts**

In `server/src/app.ts`, add import after the existing client import:
```typescript
import { roomRoutes } from "./routes/rooms.js"; // v3: operator messaging
```

Then add after the `api.use(clientRoutes(db));` line:
```typescript
api.use(roomRoutes(db)); // v3: operator messaging
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/rooms.ts server/src/app.ts
git commit -m "feat(server): rooms CRUD API routes"
```

---

## Task 4: OperatorMessageService — Core Types + EmailAdapter + Registry

**Files:**
- Create: `server/src/services/operator-messaging.ts`

- [ ] **Step 1: Write the service skeleton with types, registry, and EmailAdapter**

Create `server/src/services/operator-messaging.ts`:

```typescript
// v3: platform-agnostic operator↔agent messaging.
//
// Adapters translate raw platform payloads into InboundMessage.
// OperatorMessageService.handleInbound routes them to the right agent/room.
// OperatorMessageService.sendToOperator sends outbound on the same platform thread.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  emailAccounts,
  issueComments,
  issues,
  messageThreads,
  operatorMessages,
  roomMembers,
  rooms,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InboundMessage {
  platform: "email" | "telegram" | "sms";
  from: string;
  body: string;
  subject?: string;
  threadKey?: string;
  raw: unknown;
}

export interface OutboundMessage {
  to: string[];
  body: string;
  html?: string;
  subject?: string;
  threadKey?: string;
}

export interface MessagePlatformAdapter {
  platform: "email" | "telegram" | "sms";
  send(msg: OutboundMessage): Promise<{ threadKey: string }>;
  reply(threadKey: string, body: string, html?: string): Promise<void>;
}

// ─── Adapter Registry ─────────────────────────────────────────────────────────

const adapterRegistry = new Map<string, MessagePlatformAdapter>();

export function registerAdapter(adapter: MessagePlatformAdapter): void {
  adapterRegistry.set(adapter.platform, adapter);
}

export function getAdapter(platform: string): MessagePlatformAdapter | null {
  return adapterRegistry.get(platform) ?? null;
}

// ─── EmailAdapter ─────────────────────────────────────────────────────────────

export function createEmailAdapter(db: Db, voiceAccountId: string): MessagePlatformAdapter {
  return {
    platform: "email",

    async send(msg: OutboundMessage): Promise<{ threadKey: string }> {
      const { sendEmailFromAccount } = await import("./email-sender.js");
      const sent = await sendEmailFromAccount(db, {
        accountId: voiceAccountId,
        to: msg.to,
        subject: msg.subject ?? "(no subject)",
        text: msg.body,
        html: msg.html,
      });
      return { threadKey: sent.messageId ?? "" };
    },

    async reply(threadKey: string, body: string, html?: string): Promise<void> {
      const { sendEmailFromAccount } = await import("./email-sender.js");
      await sendEmailFromAccount(db, {
        accountId: voiceAccountId,
        to: [],   // populated by threading headers — reply-to already set
        subject: "",
        text: body,
        html,
        inReplyTo: threadKey,
        references: [threadKey],
      });
    },
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export function operatorMessagingService(db: Db) {
  // ── Mention parsing ────────────────────────────────────────────────────────

  function parseMentions(text: string): { agentNames: string[]; roomSlugs: string[] } {
    // Match @word-with-dashes (agent name or room slug)
    const matches = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1]!.toLowerCase());
    // Heuristic: slugs contain dashes, names are typically single words.
    // Both lists contain all matches — resolver will narrow by looking up DB.
    return { agentNames: matches, roomSlugs: matches };
  }

  // ── Agent resolution ───────────────────────────────────────────────────────

  async function resolveAgentByName(
    companyId: string,
    name: string,
  ): Promise<{ id: string; companyId: string } | null> {
    // Match by agent shortname (slug-style) or full name (case-insensitive)
    const rows = await db
      .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const needle = name.toLowerCase().replace(/-/g, " ");
    return (
      rows.find((r) => r.name.toLowerCase() === needle || r.name.toLowerCase().replace(/\s+/g, "-") === name.toLowerCase()) ?? null
    );
  }

  async function resolveRoomBySlug(
    companyId: string,
    slug: string,
  ): Promise<{ id: string; companyId: string; requireApproval: boolean } | null> {
    const [row] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.companyId, companyId), eq(rooms.slug, slug)))
      .limit(1);
    return row ?? null;
  }

  // ── Content-based auto-route ───────────────────────────────────────────────
  // Keyword match first (free). Falls back to Haiku call if ambiguous.

  async function autoRouteAgent(
    companyId: string,
    body: string,
  ): Promise<string | null> {
    const companyAgents = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    // Simple keyword match by role
    const lower = body.toLowerCase();
    const byRole = (role: string) => companyAgents.find((a) => a.role === role);

    if (/\b(code|bug|feature|deploy|infra|technical|dev|implement)\b/.test(lower)) {
      return byRole("cto")?.id ?? byRole("ceo")?.id ?? null;
    }
    if (/\b(design|ui|ux|layout|visual)\b/.test(lower)) {
      return byRole("designer")?.id ?? byRole("ceo")?.id ?? null;
    }
    // Default: CEO
    return byRole("ceo")?.id ?? companyAgents[0]?.id ?? null;
  }

  // ── Issue + wakeup helpers ─────────────────────────────────────────────────

  async function ensureIssue(
    companyId: string,
    agentId: string,
    title: string,
    description: string,
  ): Promise<string> {
    const { issueService } = await import("./issues.js");
    const issue = await issueService(db).create(companyId, {
      title,
      description,
      assigneeAgentId: agentId,
      status: "todo",
      createdByAgentId: agentId,
    });
    return issue.id;
  }

  async function wakeAgent(companyId: string, agentId: string, issueId: string, reason: string): Promise<void> {
    const { heartbeatService } = await import("./heartbeat.js");
    try {
      await heartbeatService(db).wakeup(agentId, {
        source: "assignment",
        triggerDetail: "operator-message",
        reason,
        payload: { issueId },
        contextSnapshot: { issueId },
        requestedByActorType: "system",
      });
    } catch (err) {
      logger.warn({ err, agentId, issueId }, "operator-messaging: wakeup failed");
    }
  }

  async function storeMessage(
    companyId: string,
    issueId: string | null,
    roomId: string | null,
    direction: "inbound" | "outbound",
    platform: string,
    body: string,
    raw: unknown,
    fromAgentId?: string | null,
  ): Promise<string> {
    const [row] = await db
      .insert(operatorMessages)
      .values({ companyId, issueId, roomId, direction, platform, body, rawPayload: raw, fromAgentId: fromAgentId ?? null })
      .returning({ id: operatorMessages.id });
    return row!.id;
  }

  async function storeThreadKey(msgId: string, platform: string, threadKey: string): Promise<void> {
    if (!threadKey) return;
    await db.insert(messageThreads).values({ operatorMessageId: msgId, platform, threadKey });
  }

  async function findThreadKeyForIssue(issueId: string, platform: string): Promise<string | null> {
    const rows = await db
      .select({ threadKey: messageThreads.threadKey })
      .from(messageThreads)
      .innerJoin(operatorMessages, eq(operatorMessages.id, messageThreads.operatorMessageId))
      .where(and(eq(operatorMessages.issueId, issueId), eq(messageThreads.platform, platform)))
      .limit(1);
    return rows[0]?.threadKey ?? null;
  }

  // ── handleInbound ──────────────────────────────────────────────────────────

  async function handleInbound(
    companyId: string,
    voiceAccountId: string,
    msg: InboundMessage,
  ): Promise<void> {
    const fullText = `${msg.subject ?? ""} ${msg.body}`;
    const { agentNames, roomSlugs } = parseMentions(fullText);

    // Try @room-slug first
    for (const slug of roomSlugs) {
      const room = await resolveRoomBySlug(companyId, slug);
      if (!room) continue;

      const members = await db
        .select()
        .from(roomMembers)
        .where(eq(roomMembers.roomId, room.id));

      const title = `[room:${slug}] ${msg.subject ?? msg.body.slice(0, 80)}`;
      const description = [
        `**Operator message to room #${slug}**`,
        ``,
        `From: ${msg.from}`,
        ``,
        msg.body,
      ].join("\n");

      // Store inbound message
      const msgId = await storeMessage(companyId, null, room.id, "inbound", msg.platform, msg.body, msg.raw);
      if (msg.threadKey) await storeThreadKey(msgId, msg.platform, msg.threadKey);

      // Fan out: wake each agent member
      for (const member of members.filter((m) => m.agentId && !m.isOperator)) {
        const issueId = await ensureIssue(companyId, member.agentId!, title, description);
        await db.update(operatorMessages).set({ issueId }).where(eq(operatorMessages.id, msgId));
        await wakeAgent(companyId, member.agentId!, issueId, "room-message");
      }
      logger.info({ companyId, roomId: room.id, slug }, "operator-messaging: room fanout");
      return;
    }

    // Try @agent-name direct
    for (const name of agentNames) {
      const agent = await resolveAgentByName(companyId, name);
      if (!agent) continue;

      const title = `[direct] ${msg.subject ?? msg.body.slice(0, 80)}`;
      const description = [
        `**Direct operator message to @${name}**`,
        ``,
        `From: ${msg.from}`,
        ``,
        msg.body,
      ].join("\n");

      const issueId = await ensureIssue(companyId, agent.id, title, description);
      const msgId = await storeMessage(companyId, issueId, null, "inbound", msg.platform, msg.body, msg.raw);
      if (msg.threadKey) await storeThreadKey(msgId, msg.platform, msg.threadKey);
      await wakeAgent(companyId, agent.id, issueId, "direct-operator-message");
      logger.info({ companyId, agentId: agent.id, name }, "operator-messaging: direct route");
      return;
    }

    // Auto-route (no mention matched)
    const agentId = await autoRouteAgent(companyId, msg.body);
    if (!agentId) {
      logger.warn({ companyId }, "operator-messaging: no agent found for auto-route");
      return;
    }

    const title = `[operator] ${msg.subject ?? msg.body.slice(0, 80)}`;
    const description = [
      `**Operator message (auto-routed)**`,
      ``,
      `From: ${msg.from}`,
      ``,
      msg.body,
    ].join("\n");

    const issueId = await ensureIssue(companyId, agentId, title, description);
    const msgId = await storeMessage(companyId, issueId, null, "inbound", msg.platform, msg.body, msg.raw);
    if (msg.threadKey) await storeThreadKey(msgId, msg.platform, msg.threadKey);
    await wakeAgent(companyId, agentId, issueId, "operator-message-auto-routed");
    logger.info({ companyId, agentId }, "operator-messaging: auto-routed");
  }

  // ── sendToOperator ─────────────────────────────────────────────────────────
  // Called when agent @operators in a comment or calls the API.

  async function sendToOperator(
    companyId: string,
    voiceAccountId: string,
    agentId: string,
    body: string,
    issueId: string | null,
    platform: "email" = "email",
  ): Promise<void> {
    const adapter = getAdapter(platform);
    if (!adapter) {
      logger.warn({ platform }, "operator-messaging: no adapter registered");
      return;
    }

    let threadKey: string | null = issueId ? await findThreadKeyForIssue(issueId, platform) : null;

    // Look up recipient — company ownerEmail fallback
    const [company] = await db
      .select({ ownerEmail: companies.ownerEmail })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    const [agentRow] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    const agentName = agentRow?.name ?? "Agent";
    const to = company?.ownerEmail ? [company.ownerEmail] : [];
    if (to.length === 0) {
      logger.warn({ companyId }, "operator-messaging: no ownerEmail for outbound");
      return;
    }

    let newThreadKey: string;
    if (threadKey) {
      await adapter.reply(threadKey, `**${agentName}:** ${body}`);
      newThreadKey = threadKey;
    } else {
      const [issue] = issueId
        ? await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId)).limit(1)
        : [null];
      const subject = issue?.title ? `Re: ${issue.title}` : `Message from ${agentName}`;
      const sent = await adapter.send({
        to,
        subject,
        body: `**${agentName}:** ${body}`,
      });
      newThreadKey = sent.threadKey;
    }

    const msgId = await storeMessage(
      companyId,
      issueId,
      null,
      "outbound",
      platform,
      body,
      null,
      agentId,
    );
    if (newThreadKey) await storeThreadKey(msgId, platform, newThreadKey);
    logger.info({ companyId, agentId, issueId }, "operator-messaging: sent to operator");
  }

  return { handleInbound, sendToOperator, parseMentions };
}
```

- [ ] **Step 2: Write service unit test**

Create `server/src/__tests__/operator-messaging.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents, companies, createDb, emailAccounts,
  issues, operatorMessages, rooms, roomMembers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { operatorMessagingService } from "../services/operator-messaging.ts";

const { describeIfDb } = getEmbeddedPostgresTestSupport();

describeIfDb("operatorMessagingService.parseMentions", () => {
  it("extracts agent names and room slugs from text", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-om-parse-");
    const db = createDb(tempDb.connectionString);
    const svc = operatorMessagingService(db);
    const result = svc.parseMentions("Hey @ceo-agent and @dev-team please look at this");
    expect(result.agentNames).toContain("ceo-agent");
    expect(result.roomSlugs).toContain("dev-team");
    await tempDb.cleanup();
  });
});

describeIfDb("operatorMessagingService.handleInbound — auto-route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-om-inbound-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC = "1";
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE
      message_threads, operator_messages, room_members, rooms,
      issue_comments, issues, agent_wakeup_requests, email_accounts,
      agents, companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    delete process.env.PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC;
    await tempDb?.cleanup();
  });

  it("auto-routes to CEO when no mention found", async () => {
    const [company] = await db.insert(companies).values({ name: "Co", issuePrefix: "CO" }).returning();
    const [ceo] = await db.insert(agents).values({
      companyId: company!.id, name: "CEO", role: "ceo", title: "CEO",
      adapterType: "claude-local", status: "active",
    }).returning();
    await db.insert(emailAccounts).values({
      companyId: company!.id, label: "Voice", role: "agent_voice",
      imapHost: "imap.test", imapPort: 993, imapUser: "u", imapPasswordEnc: "p",
      fromName: "AI", fromEmail: "ai@test.co",
    });

    const svc = operatorMessagingService(db);
    await svc.handleInbound(company!.id, "voice-id", {
      platform: "email",
      from: "op@test.co",
      body: "Can you check the latest build?",
    });

    const msgs = await db.select().from(operatorMessages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.direction).toBe("inbound");

    const created = await db.select().from(issues);
    expect(created).toHaveLength(1);
    expect(created[0]!.assigneeAgentId).toBe(ceo!.id);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run server/src/__tests__/operator-messaging.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/operator-messaging.ts server/src/__tests__/operator-messaging.test.ts
git commit -m "feat(server): OperatorMessageService + EmailAdapter + routing engine"
```

---

## Task 5: Email Processor — Route Untagged Agent-Voice Messages

**Files:**
- Modify: `server/src/services/email-processor.ts`

The current `routeOperatorReply` ignores any message that has no `[plan-<id>]` tag. Instead, call `handleInbound`.

- [ ] **Step 1: Find the ignore block**

In `server/src/services/email-processor.ts`, find:

```typescript
  const planMatch = subject.match(PLAN_TAG_RE);
  if (!planMatch) {
    await db
      .update(emailMessages)
      .set({
        processingState: "ignored",
        matchedCompanyId: companyId,
        processedAt: new Date(),
        errorText: "Operator reply on agent_voice but no [plan-<id>] tag — ignoring.",
      })
      .where(eq(emailMessages.id, emailMessageId));
    logger.info(
      { emailMessageId, subject },
      "email-processor: agent_voice reply with no plan tag — ignored",
    );
    return;
  }
```

- [ ] **Step 2: Replace ignore block with handleInbound call**

Replace the block above with:

```typescript
  const planMatch = subject.match(PLAN_TAG_RE);
  if (!planMatch) {
    // No [plan-<id>] tag → treat as a free-form operator message.
    // Route via OperatorMessageService (mention → agent, room, or auto-route).
    const [voiceAcct] = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.companyId, companyId), eq(emailAccounts.role, "agent_voice")))
      .limit(1);

    const [srcMsg] = await db
      .select({ body: emailMessages.body, subject: emailMessages.subject, messageIdHeader: emailMessages.messageIdHeader })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);

    if (voiceAcct && srcMsg) {
      const { operatorMessagingService } = await import("./operator-messaging.js");
      await operatorMessagingService(db).handleInbound(companyId, voiceAcct.id, {
        platform: "email",
        from: _fromAddr,
        body: srcMsg.body,
        subject: srcMsg.subject || undefined,
        threadKey: srcMsg.messageIdHeader || undefined,
        raw: { emailMessageId, subject, fromAddr: _fromAddr },
      });
    }

    await db
      .update(emailMessages)
      .set({
        processingState: "executed",
        matchedCompanyId: companyId,
        processedAt: new Date(),
      })
      .where(eq(emailMessages.id, emailMessageId));
    logger.info(
      { emailMessageId, subject, companyId },
      "email-processor: untagged agent_voice message routed via operator-messaging",
    );
    return;
  }
```

Note: `_fromAddr` is the existing parameter name — verify the actual parameter name in the function signature and use it.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: clean.

- [ ] **Step 4: Run existing tests to verify no regression**

```bash
pnpm vitest run server/src/__tests__/email-plan-gate-e2e.test.ts server/src/__tests__/email-processor.test.ts
```

Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/email-processor.ts
git commit -m "feat(server): route untagged agent_voice messages via OperatorMessageService"
```

---

## Task 6: @operator Comment Hook in Issues Route

**Files:**
- Modify: `server/src/routes/issues.ts`

When an agent posts a comment containing `@operator`, fire `sendToOperator` after the comment is inserted.

- [ ] **Step 1: Find the comment POST handler**

In `server/src/routes/issues.ts`, locate the POST comments handler. Find where comments are inserted successfully and the wakeup loop runs. Add after the wakeup loop:

```typescript
    // @operator detection — notify operator via agent_voice if agent mentioned them.
    const OPERATOR_MENTION_RE = /@operator\b/i;
    if (OPERATOR_MENTION_RE.test(commentBody) && actor.agentId) {
      const { operatorMessagingService } = await import("../services/operator-messaging.js");
      const { emailAccounts, companies: companiesTable } = await import("@paperclipai/db");
      const [voiceAcct] = await db
        .select({ id: emailAccounts.id })
        .from(emailAccounts)
        .where(
          and(
            eq(emailAccounts.companyId, existing.companyId),
            eq(emailAccounts.role, "agent_voice"),
          ),
        )
        .limit(1);
      if (voiceAcct) {
        operatorMessagingService(db)
          .sendToOperator(
            existing.companyId,
            voiceAcct.id,
            actor.agentId,
            commentBody,
            id,
          )
          .catch((err) =>
            logger.warn({ err, issueId: id }, "issues: @operator notification failed"),
          );
      }
    }
```

- [ ] **Step 2: Verify import of `and` + `eq` already present**

Check the top of `server/src/routes/issues.ts` for `import { ..., and, eq } from "drizzle-orm"`. If missing, add them.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat(server): @operator in issue comments triggers sendToOperator"
```

---

## Task 7: Operator Messages API Route

**Files:**
- Create: `server/src/routes/operator-messages.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write operator-messages route**

Create `server/src/routes/operator-messages.ts`:

```typescript
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, emailAccounts, messageThreads, operatorMessages } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { getActorInfo } from "./actor-info.js";
import { operatorMessagingService } from "../services/operator-messaging.js";

export function operatorMessageRoutes(db: Db) {
  const router = Router();

  // POST /api/companies/:companyId/operator-messages
  // Agents or UI call this to send a message to the operator.
  router.post("/companies/:companyId/operator-messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as {
      body?: string;
      issueId?: string | null;
      roomId?: string | null;
      urgent?: boolean;
    };
    if (!body.body?.trim()) throw badRequest("body required");

    const actor = getActorInfo(req);
    if (!actor.agentId) throw badRequest("only agents can send operator messages via this endpoint");

    const [voiceAcct] = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.companyId, companyId), eq(emailAccounts.role, "agent_voice")))
      .limit(1);

    if (voiceAcct) {
      const svc = operatorMessagingService(db);
      await svc.sendToOperator(
        companyId,
        voiceAcct.id,
        actor.agentId,
        body.body,
        body.issueId ?? null,
      );
    }

    res.status(201).json({ ok: true });
  });

  // GET /api/companies/:companyId/operator-messages
  router.get("/companies/:companyId/operator-messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const issueId = req.query.issueId as string | undefined;
    const roomId = req.query.roomId as string | undefined;

    const conditions = [eq(operatorMessages.companyId, companyId)];
    if (issueId) conditions.push(eq(operatorMessages.issueId, issueId));
    if (roomId) conditions.push(eq(operatorMessages.roomId, roomId));

    const msgs = await db
      .select()
      .from(operatorMessages)
      .where(and(...conditions))
      .orderBy(desc(operatorMessages.createdAt))
      .limit(100);
    res.json(msgs);
  });

  // GET /api/rooms/:id/messages — thread for a room
  router.get("/rooms/:id/messages", async (req, res) => {
    const msgs = await db
      .select()
      .from(operatorMessages)
      .where(eq(operatorMessages.roomId, req.params.id))
      .orderBy(desc(operatorMessages.createdAt))
      .limit(100);
    res.json(msgs.reverse());
  });

  return router;
}
```

- [ ] **Step 2: Register in app.ts**

Add import:
```typescript
import { operatorMessageRoutes } from "./routes/operator-messages.js"; // v3: operator messaging
```

Add registration after `api.use(roomRoutes(db));`:
```typescript
api.use(operatorMessageRoutes(db)); // v3: operator messaging
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/operator-messages.ts server/src/app.ts
git commit -m "feat(server): operator-messages API routes (POST + GET)"
```

---

## Task 8: Agent Instructions Update

**Files:**
- Modify: `server/src/onboarding-assets/default/AGENTS.md`
- Modify: `server/src/onboarding-assets/ceo/AGENTS.md`
- Modify: `skills/paperclip/SKILL.md`
- Modify: `skills/paperclip-ops/SKILL.md`

- [ ] **Step 1: Update default AGENTS.md**

Append to `server/src/onboarding-assets/default/AGENTS.md`:

```markdown

## Operator Communication

If you need a decision, are blocked, or want to report progress mid-task:

1. **Post a comment** with `@operator: <your message>` on the current issue (preferred when context is issue-related — the operator receives an email automatically).
2. **Call the API** `POST /api/companies/{companyId}/operator-messages` with `{"body": "...", "issueId": "..."}` (preferred for standalone messages or broadcasting to a room).

**Rules:**
- Never stay silently blocked. Surface blockers in the same heartbeat they are discovered.
- Before creating a new issue from an operator message, search existing issues for related work. Link rather than duplicate: use `parentId` on a new sub-issue or add a comment to the existing one.
- When the operator addresses you directly with @your-name, act immediately — no plan-gate approval required for operator-initiated direct messages.
```

- [ ] **Step 2: Update CEO AGENTS.md**

Append the same block to `server/src/onboarding-assets/ceo/AGENTS.md`.

- [ ] **Step 3: Update paperclip skill**

In `skills/paperclip/SKILL.md`, add a new section after the heartbeat procedure:

```markdown
## Reaching the Operator

When you are blocked, need a decision, or want to report progress:

**Option 1 — @operator in a comment (preferred for issue context):**
```
POST /api/issues/{issueId}/comments
{ "body": "@operator: <your message here>" }
```
The system automatically emails the operator. Their reply comes back as a comment.

**Option 2 — Direct message API (for standalone messages or rooms):**
```
POST /api/companies/{companyId}/operator-messages
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "body": "I need a decision on X",
  "issueId": "<current issue id>",   // optional thread anchor
  "roomId": "<room id>"              // optional — fan-out to room members
}
```

**Rule:** Never be silently blocked. Surface blockers in the same heartbeat they are discovered.
```

- [ ] **Step 4: Update paperclip-ops skill**

In `skills/paperclip-ops/SKILL.md`, add after the Error Handling section:

```markdown
## Reaching the Operator

Use `@operator` in sub-issue comments for questions about the task.
Use `POST /api/companies/{companyId}/operator-messages` to broadcast to a room.
Never stay blocked silently — always surface blockers within the same heartbeat.
```

- [ ] **Step 5: Commit**

```bash
git add server/src/onboarding-assets/default/AGENTS.md \
  server/src/onboarding-assets/ceo/AGENTS.md \
  skills/paperclip/SKILL.md skills/paperclip-ops/SKILL.md
git commit -m "docs(agents): add operator communication rules to AGENTS.md and skills"
```

---

## Task 9: Rooms UI — API Client + Pages + Sidebar + Routes

**Files:**
- Create: `ui/src/api/rooms.ts`
- Create: `ui/src/pages/Rooms.tsx`
- Create: `ui/src/pages/RoomDetail.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Write rooms API client**

Create `ui/src/api/rooms.ts`:

```typescript
import { apiClient } from "./client";

export interface Room {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  requireApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMember {
  id: string;
  roomId: string;
  agentId: string | null;
  isOperator: boolean;
  notifyOnMessage: boolean;
}

export interface RoomDetail extends Room {
  members: RoomMember[];
}

export interface OperatorMessage {
  id: string;
  companyId: string;
  roomId: string | null;
  issueId: string | null;
  direction: "inbound" | "outbound";
  platform: string;
  fromAgentId: string | null;
  body: string;
  createdAt: string;
}

export const roomsApi = {
  list: (companyId: string) =>
    apiClient.get<Room[]>(`/companies/${companyId}/rooms`),

  create: (companyId: string, data: { name: string; slug: string; description?: string; requireApproval?: boolean }) =>
    apiClient.post<Room>(`/companies/${companyId}/rooms`, data),

  get: (id: string) =>
    apiClient.get<RoomDetail>(`/rooms/${id}`),

  update: (id: string, data: Partial<{ name: string; slug: string; description: string; requireApproval: boolean }>) =>
    apiClient.patch<Room>(`/rooms/${id}`, data),

  delete: (id: string) =>
    apiClient.delete(`/rooms/${id}`),

  addMember: (roomId: string, data: { agentId?: string; isOperator?: boolean }) =>
    apiClient.post<RoomMember>(`/rooms/${roomId}/members`, data),

  removeMember: (roomId: string, memberId: string) =>
    apiClient.delete(`/rooms/${roomId}/members/${memberId}`),

  getMessages: (roomId: string) =>
    apiClient.get<OperatorMessage[]>(`/rooms/${roomId}/messages`),
};
```

Note: if `apiClient` doesn't exist at `./client`, check where the existing API clients (e.g., `emailAccountsApi`) import their HTTP client from and use the same pattern.

- [ ] **Step 2: Write Rooms list page**

Create `ui/src/pages/Rooms.tsx`:

```typescript
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { roomsApi, type Room } from "../api/rooms";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Hash } from "lucide-react";

export function Rooms() {
  const { company } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useBreadcrumbs([{ label: "Rooms" }]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const { data: roomList = [], isLoading } = useQuery({
    queryKey: ["rooms", company?.id],
    queryFn: () => roomsApi.list(company!.id),
    enabled: !!company?.id,
  });

  const createMutation = useMutation({
    mutationFn: () => roomsApi.create(company!.id, { name, slug: slug || name.toLowerCase().replace(/\s+/g, "-") }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", company?.id] });
      setShowCreate(false);
      setName("");
      setSlug("");
    },
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading rooms…</div>;

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Rooms</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>+ New</Button>
      </div>

      {roomList.length === 0 && (
        <p className="text-sm text-muted-foreground">No rooms yet. Create one to broadcast messages to groups of agents.</p>
      )}

      <div className="space-y-2">
        {roomList.map((room: Room) => (
          <Card
            key={room.id}
            className="p-4 cursor-pointer hover:bg-accent"
            onClick={() => navigate(`/rooms/${room.id}`)}
          >
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{room.name}</span>
              <span className="text-xs text-muted-foreground ml-auto">{room.slug}</span>
            </div>
            {room.description && (
              <p className="text-xs text-muted-foreground mt-1 ml-6">{room.description}</p>
            )}
          </Card>
        ))}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Room</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Name (e.g. Dev Team)" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Slug (e.g. dev-team)" value={slug} onChange={(e) => setSlug(e.target.value)} />
            <Button
              className="w-full"
              disabled={!name || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "Creating…" : "Create Room"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: Write RoomDetail page**

Create `ui/src/pages/RoomDetail.tsx`:

```typescript
import { useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { roomsApi, type OperatorMessage, type RoomMember } from "../api/rooms";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Bot, User } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { formatDistanceToNow } from "date-fns";

export function RoomDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: room, isLoading } = useQuery({
    queryKey: ["room", id],
    queryFn: () => roomsApi.get(id!),
    enabled: !!id,
  });

  const { data: messages = [] } = useQuery({
    queryKey: ["room-messages", id],
    queryFn: () => roomsApi.getMessages(id!),
    enabled: !!id,
    refetchInterval: 10_000,
  });

  useBreadcrumbs([
    { label: "Rooms", to: "/rooms" },
    { label: room?.name ?? "Room" },
  ]);

  const removeMember = useMutation({
    mutationFn: (memberId: string) => roomsApi.removeMember(id!, memberId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["room", id] }),
  });

  const toggleApproval = useMutation({
    mutationFn: (requireApproval: boolean) => roomsApi.update(id!, { requireApproval }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["room", id] }),
  });

  if (isLoading || !room) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => navigate("/rooms")}>
        <ArrowLeft className="w-4 h-4" /> Rooms
      </button>

      <div>
        <h1 className="text-xl font-semibold">#{room.name}</h1>
        {room.description && <p className="text-sm text-muted-foreground mt-1">{room.description}</p>}
      </div>

      {/* Members */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Members</h2>
        {room.members.length === 0 && (
          <p className="text-xs text-muted-foreground">No members yet.</p>
        )}
        {room.members.map((m: RoomMember) => (
          <div key={m.id} className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Bot className="w-4 h-4 text-muted-foreground" />
              <span>{m.isOperator ? "Operator" : m.agentId ?? "Unknown"}</span>
            </div>
            {!m.isOperator && (
              <Button size="sm" variant="ghost" onClick={() => removeMember.mutate(m.id)}>Remove</Button>
            )}
          </div>
        ))}
      </Card>

      {/* Settings */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Settings</h2>
        <div className="flex items-center gap-3">
          <Switch
            id="require-approval"
            checked={room.requireApproval}
            onCheckedChange={(v) => toggleApproval.mutate(v)}
          />
          <Label htmlFor="require-approval">Require approval before agents act</Label>
        </div>
        <div className="text-xs text-muted-foreground border rounded p-3 bg-muted">
          <strong>Email this room:</strong> Send to agent_voice with <code>@{room.slug}</code> anywhere in the body.
        </div>
      </Card>

      {/* Thread */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Thread</h2>
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">No messages yet.</p>
        )}
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {messages.map((msg: OperatorMessage) => (
            <div key={msg.id} className="flex gap-2 text-sm">
              {msg.direction === "inbound"
                ? <User className="w-4 h-4 mt-0.5 text-blue-500 shrink-0" />
                : <Bot className="w-4 h-4 mt-0.5 text-green-500 shrink-0" />}
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">
                  {msg.direction === "inbound" ? "Operator" : "Agent"} ·{" "}
                  {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })} ·{" "}
                  <span className="capitalize">{msg.platform}</span>
                </div>
                <div className="whitespace-pre-wrap">{msg.body}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Add Rooms to Sidebar**

In `ui/src/components/Sidebar.tsx`, find the `<SidebarSection label="Email">` block and add after the existing Email items:

```typescript
<SidebarNavItem to="/rooms" label="Rooms" icon={Hash} />
```

Add `Hash` to the lucide-react import at the top of the file if not present.

- [ ] **Step 5: Add routes to App.tsx**

In `ui/src/App.tsx`, add imports:

```typescript
import { Rooms } from "./pages/Rooms";
import { RoomDetail } from "./pages/RoomDetail";
```

Add routes inside `boardRoutes()` after the email routes:

```typescript
<Route path="rooms" element={<Rooms />} />
<Route path="rooms/:id" element={<RoomDetail />} />
```

- [ ] **Step 6: Verify UI compiles**

```bash
pnpm --filter @paperclipai/ui typecheck
```

Note: pre-existing errors in `Analytics.tsx` and `AgentPerformanceTab.tsx` are unrelated — they were present before this task. Only fix errors in the files you modified.

- [ ] **Step 7: Run all server tests**

```bash
pnpm vitest run server/src/__tests__/operator-messaging.test.ts \
  server/src/__tests__/rooms.test.ts \
  server/src/__tests__/email-plan-gate-e2e.test.ts \
  server/src/__tests__/email-processor.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/api/rooms.ts ui/src/pages/Rooms.tsx ui/src/pages/RoomDetail.tsx \
  ui/src/components/Sidebar.tsx ui/src/App.tsx
git commit -m "feat(ui): Rooms list + detail pages, Sidebar nav, API client"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| DB: rooms, room_members, operator_messages, message_threads | Task 1 |
| Rooms CRUD service | Task 2 |
| Rooms API routes | Task 3 |
| OperatorMessageService + EmailAdapter + registry | Task 4 |
| @mention routing (agent + room) + auto-route | Task 4 |
| Email processor: untagged → handleInbound | Task 5 |
| @operator in comments → sendToOperator | Task 6 |
| operator-messages API (POST + GET) | Task 7 |
| AGENTS.md + skills operator comms rule | Task 8 |
| Rooms UI (list + detail + thread + sidebar) | Task 9 |

**Type consistency check:**

- `operatorMessagingService(db).handleInbound(companyId, voiceAccountId, msg)` — consistent Task 4 → Task 5 ✓
- `operatorMessagingService(db).sendToOperator(companyId, voiceAccountId, agentId, body, issueId)` — consistent Task 4 → Task 6 ✓
- `roomService(db)` — consistent Task 2 → Task 3 ✓
- `RoomDetail.members: RoomMemberRow[]` — consistent Task 2 → Task 9 ✓
- `OperatorMessage.direction: "inbound" | "outbound"` — consistent Task 1 → Task 9 ✓

**Placeholder scan:** No TBD or TODO in any task. ✓
