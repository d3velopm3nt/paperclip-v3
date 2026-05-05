# Client Document Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every client and project their own document folder (Google Drive or local), auto-created when the client/project is created, with email attachments automatically filed into the matching client folder.

**Architecture:** Three new columns on `clients` + `projects` (storage path fields), a new `clientStorageService` that creates folder hierarchies in Drive or local FS, hooks into existing `clientService.create` + `projectService.create`, and a post-routing hook in `email-processor` that moves attachments into the matched client folder. Drive scope upgraded from `drive.readonly` → `drive` to allow folder creation. Company-level storage root stored in `instanceSettings.general`.

**Tech Stack:** Drizzle ORM migrations, googleapis Drive v3, Node.js `fs/promises`, React 19 + TanStack Query, existing `getAuthenticatedDriveClient`, existing `upsertGeneral` pattern from `gdrive-auth.ts`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `packages/db/src/schema/clients.ts` | Add `localPath`, `driveFolderId` columns |
| Modify | `packages/db/src/schema/projects.ts` | Add `localPath`, `driveFolderId` columns |
| Modify | `packages/db/src/schema/document_sources.ts` | Add `clientId`, `projectId` FK columns |
| Run | `pnpm db:generate && pnpm db:migrate` | Apply all schema changes |
| Modify | `packages/shared/src/types/document-storage.ts` | Extend `DocumentSource` with `clientId`, `projectId` |
| Modify | `packages/shared/src/types/index.ts` | Export new `ClientStorage`, `ProjectStorage` types |
| Modify | `server/src/services/gdrive-auth.ts` | Upgrade OAuth scope, add `createDriveFolder` export |
| Create | `server/src/services/client-storage.ts` | `ensureClientFolder`, `ensureProjectFolder`, `getCompanyStorageRoot` |
| Modify | `server/src/services/clients.ts` | Call `ensureClientFolder` after create (fire-and-forget) |
| Modify | `server/src/services/projects.ts` | Call `ensureProjectFolder` after create (fire-and-forget) |
| Modify | `server/src/services/email-processor.ts` | File attachments to client folder after `matchedClientId` resolves |
| Modify | `server/src/routes/clients.ts` | Add `GET/PUT /clients/:id/storage` endpoints |
| Modify | `server/src/routes/instance-storage.ts` | Add `GET/PUT /instance/storage/root` endpoints |
| Modify | `ui/src/api/clients.ts` | Add `getStorage`, `setStorage` methods |
| Modify | `ui/src/pages/ClientDetail.tsx` | Add "Storage" tab |
| Modify | `ui/src/pages/ProjectDetail.tsx` | Add "Storage" tab (or hook into config tab) |
| Modify | `ui/src/pages/InstanceStorageSettings.tsx` | Add company root picker section |

---

## Task 1: DB Schema — clients and projects storage fields

**Files:**
- Modify: `packages/db/src/schema/clients.ts`
- Modify: `packages/db/src/schema/projects.ts`
- Modify: `packages/db/src/schema/document_sources.ts`

- [ ] **Step 1: Add storage columns to clients schema**

Edit `packages/db/src/schema/clients.ts` — add two nullable text columns after `notes`:

```typescript
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    emailDomain: text("email_domain"),
    extraEmails: jsonb("extra_emails").$type<string[]>().notNull().default([]),
    trustLevel: text("trust_level").notNull().default("standard"),
    isMyCompany: boolean("is_my_company").notNull().default(false),
    notes: text("notes"),
    // v3: document storage
    localPath: text("local_path"),
    driveFolderId: text("drive_folder_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("clients_company_idx").on(table.companyId),
    domainIdx: uniqueIndex("clients_company_email_domain_idx").on(
      table.companyId,
      table.emailDomain,
    ),
  }),
);
```

- [ ] **Step 2: Add storage columns to projects schema**

Edit `packages/db/src/schema/projects.ts` — add after `archivedAt`:

```typescript
import { pgTable, uuid, text, timestamp, date, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    clientId: uuid("client_id"),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    executionWorkspacePolicy: jsonb("execution_workspace_policy").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // v3: document storage
    localPath: text("local_path"),
    driveFolderId: text("drive_folder_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 3: Add clientId + projectId to documentSources schema**

Edit `packages/db/src/schema/document_sources.ts`:

```typescript
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const documentSources = pgTable(
  "document_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // v3: optional scope — null = company-wide, set = scoped to client/project
    clientId: uuid("client_id"),
    projectId: uuid("project_id"),
    type: text("type").notNull(), // "local" | "gdrive"
    name: text("name").notNull(),
    localPath: text("local_path"),
    driveFolderId: text("drive_folder_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("document_sources_company_idx").on(table.companyId),
    clientIdx: index("document_sources_client_idx").on(table.clientId),
    projectIdx: index("document_sources_project_idx").on(table.projectId),
  }),
);
```

- [ ] **Step 4: Generate and apply migration**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm db:generate
pnpm db:migrate
```

Expected: new migration file in `packages/db/drizzle/` and applied successfully.

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck 2>&1 | grep -v "AgentPerformanceTab\|Analytics" | grep "error TS" | head -10
```
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/clients.ts packages/db/src/schema/projects.ts packages/db/src/schema/document_sources.ts packages/db/drizzle/
git commit -m "feat(storage): add localPath+driveFolderId to clients/projects, clientId/projectId to documentSources"
```

---

## Task 2: Shared types — extend DocumentSource, add ClientStorage

**Files:**
- Modify: `packages/shared/src/types/document-storage.ts`

- [ ] **Step 1: Extend DocumentSource type and add new types**

Replace the contents of `packages/shared/src/types/document-storage.ts`:

```typescript
export type DocumentSourceType = "local" | "gdrive" | "upload";
export type DocumentScope = "company" | "project";

export interface ReferenceDocument {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  mimeType: string | null;
  sourceType: DocumentSourceType;
  sourcePath: string | null;
  driveFileId: string | null;
  driveWebUrl: string | null;
  scope: DocumentScope;
  projectId: string | null;
  includeInContext: boolean;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceDocumentWithContent extends ReferenceDocument {
  extractedText: string | null;
}

export interface DocumentSource {
  id: string;
  companyId: string;
  clientId: string | null;
  projectId: string | null;
  type: "local" | "gdrive";
  name: string;
  localPath: string | null;
  driveFolderId: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface CreateDocumentSourceInput {
  type: "local" | "gdrive";
  name: string;
  localPath?: string;
  driveFolderId?: string;
  clientId?: string;
  projectId?: string;
}

export interface UpdateReferenceDocumentInput {
  title?: string;
  description?: string;
  scope?: DocumentScope;
  projectId?: string | null;
  includeInContext?: boolean;
}

export interface GoogleDriveStatus {
  connected: boolean;
  email: string | null;
}

/** Storage location for a client or project. */
export interface ClientStorageInfo {
  localPath: string | null;
  driveFolderId: string | null;
  driveWebUrl: string | null;
}

/** Company-level storage root stored in instanceSettings. */
export interface CompanyStorageRoot {
  localPath: string | null;
  driveFolderId: string | null;
}
```

- [ ] **Step 2: Export new types from shared index**

In `packages/shared/src/types/index.ts`, ensure these are exported (add if missing):

```typescript
export type {
  ReferenceDocument,
  ReferenceDocumentWithContent,
  DocumentSource,
  DocumentSourceType,
  DocumentScope,
  CreateDocumentSourceInput,
  UpdateReferenceDocumentInput,
  GoogleDriveStatus,
  ClientStorageInfo,
  CompanyStorageRoot,
} from "./document-storage.js";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck 2>&1 | grep -v "AgentPerformanceTab\|Analytics" | grep "error TS" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/document-storage.ts packages/shared/src/types/index.ts
git commit -m "feat(storage): extend DocumentSource type, add ClientStorageInfo + CompanyStorageRoot types"
```

---

## Task 3: Drive scope upgrade + createDriveFolder utility

**Files:**
- Modify: `server/src/services/gdrive-auth.ts`

- [ ] **Step 1: Upgrade OAuth scope and add folder creation**

In `server/src/services/gdrive-auth.ts`, change the `getAuthUrl` function scope AND add `createDriveFolder` and `getDriveFolderWebUrl` exports:

Change the existing `getAuthUrl` function:

```typescript
export async function getAuthUrl(db: Db, redirectUri: string): Promise<string> {
  const oauth2 = await getOAuthClient(db, redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive",   // full access — needed for folder creation
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    prompt: "consent",
  });
}
```

Add these two new exports at the end of the file (before the last closing brace of the module):

```typescript
/**
 * Creates a folder in Google Drive and returns its ID.
 * parentId defaults to "root" (My Drive root).
 */
export async function createDriveFolder(
  db: Db,
  name: string,
  parentId = "root",
): Promise<string> {
  const drive = await getAuthenticatedDriveClient(db);
  if (!drive) throw new Error("Google Drive not authenticated");
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });
  const id = res.data.id;
  if (!id) throw new Error("Drive folder creation returned no ID");
  return id;
}

/** Returns the web URL for a Drive folder by ID. */
export function driveFolderWebUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "gdrive-auth" | head -5
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/gdrive-auth.ts
git commit -m "feat(storage): upgrade Drive OAuth scope to drive (full), add createDriveFolder utility"
```

> **Note:** Existing connected Drive accounts will need to re-authenticate after this change because the scope expanded. The next time users visit Instance Settings → Storage and reconnect, they'll get the new scope. Existing tokens still work for read operations.

---

## Task 4: clientStorageService — folder creation orchestration

**Files:**
- Create: `server/src/services/client-storage.ts`

- [ ] **Step 1: Create the service**

Create `server/src/services/client-storage.ts`:

```typescript
// v3: manages per-client and per-project document folder creation in Drive or local FS.
// Each client gets: <companyRoot>/Clients/<ClientName>/_shared/
// Each project gets: <companyRoot>/Clients/<ClientName>/Projects/<ProjectName>/
// Then a documentSource is auto-created pointing to the folder.

import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { clients, projects, documentSources, instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createDriveFolder } from "./gdrive-auth.js";
import { logger } from "../middleware/logger.js";

const SINGLETON_KEY = "default";

// ── Company storage root ──────────────────────────────────────────────────────

export interface StorageRoot {
  localPath: string | null;
  driveFolderId: string | null;
}

export async function getCompanyStorageRoot(db: Db): Promise<StorageRoot> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  const g = (row?.general ?? {}) as Record<string, unknown>;
  return {
    localPath: (g.storageRootLocalPath as string | null) ?? null,
    driveFolderId: (g.storageRootDriveFolderId as string | null) ?? null,
  };
}

export async function setCompanyStorageRoot(db: Db, root: StorageRoot): Promise<void> {
  const [existing] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  const general = {
    ...((existing?.general ?? {}) as Record<string, unknown>),
    storageRootLocalPath: root.localPath ?? null,
    storageRootDriveFolderId: root.driveFolderId ?? null,
  };
  if (existing) {
    await db
      .update(instanceSettings)
      .set({ general, updatedAt: new Date() })
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  } else {
    await db.insert(instanceSettings).values({ singletonKey: SINGLETON_KEY, general, experimental: {} });
  }
}

// ── Folder helpers ────────────────────────────────────────────────────────────

async function ensureLocalDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "unnamed";
}

// ── Client folder ─────────────────────────────────────────────────────────────

/**
 * Creates <root>/Clients/<ClientName>/ and <root>/Clients/<ClientName>/_shared/
 * in whichever storage backend is configured. Stores the resulting path/ID on
 * the client row and creates a documentSource so docs sync automatically.
 * Safe to call multiple times — skips if already configured.
 */
export async function ensureClientFolder(db: Db, clientId: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;
  if (client.localPath || client.driveFolderId) return; // already set

  const root = await getCompanyStorageRoot(db);
  const folderName = safeName(client.name);

  try {
    if (root.driveFolderId) {
      // Drive path
      const clientsParentId = await getOrCreateDriveSubfolder(db, root.driveFolderId, "Clients");
      const clientFolderId = await createDriveFolder(db, folderName, clientsParentId);
      await createDriveFolder(db, "_shared", clientFolderId);

      await db.update(clients).set({ driveFolderId: clientFolderId, updatedAt: new Date() }).where(eq(clients.id, clientId));
      await db.insert(documentSources).values({
        companyId: client.companyId,
        clientId: client.id,
        type: "gdrive",
        name: `${client.name} (client)`,
        driveFolderId: clientFolderId,
      });
      logger.info({ clientId, driveFolderId: clientFolderId }, "client-storage: Drive folder created");

    } else if (root.localPath) {
      // Local path
      const clientDir = path.join(root.localPath, "Clients", folderName);
      await ensureLocalDir(path.join(clientDir, "_shared"));

      await db.update(clients).set({ localPath: clientDir, updatedAt: new Date() }).where(eq(clients.id, clientId));
      await db.insert(documentSources).values({
        companyId: client.companyId,
        clientId: client.id,
        type: "local",
        name: `${client.name} (client)`,
        localPath: clientDir,
      });
      logger.info({ clientId, localPath: clientDir }, "client-storage: local folder created");
    }
    // No root configured — silently skip; operator can set root later and re-run
  } catch (err) {
    logger.warn({ err, clientId }, "client-storage: folder creation failed");
  }
}

// ── Project folder ────────────────────────────────────────────────────────────

/**
 * Creates <clientFolder>/Projects/<ProjectName>/ under the client's folder.
 * Falls back to company root if client has no folder.
 * Safe to call multiple times.
 */
export async function ensureProjectFolder(db: Db, projectId: string): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return;
  if (project.localPath || project.driveFolderId) return; // already set

  const folderName = safeName(project.name);
  let parentDriveId: string | null = null;
  let parentLocalPath: string | null = null;

  // Try client folder first
  if (project.clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, project.clientId)).limit(1);
    if (client?.driveFolderId) {
      parentDriveId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "Projects");
    } else if (client?.localPath) {
      parentLocalPath = path.join(client.localPath, "Projects");
    }
  }

  // Fallback to company root
  if (!parentDriveId && !parentLocalPath) {
    const root = await getCompanyStorageRoot(db);
    if (root.driveFolderId) parentDriveId = root.driveFolderId;
    else if (root.localPath) parentLocalPath = path.join(root.localPath, "Projects");
  }

  try {
    if (parentDriveId) {
      const projectFolderId = await createDriveFolder(db, folderName, parentDriveId);
      await db.update(projects).set({ driveFolderId: projectFolderId, updatedAt: new Date() }).where(eq(projects.id, projectId));
      await db.insert(documentSources).values({
        companyId: project.companyId,
        clientId: project.clientId ?? null,
        projectId: project.id,
        type: "gdrive",
        name: `${project.name} (project)`,
        driveFolderId: projectFolderId,
      });
      logger.info({ projectId, driveFolderId: projectFolderId }, "client-storage: Drive project folder created");

    } else if (parentLocalPath) {
      const projectDir = path.join(parentLocalPath, folderName);
      await ensureLocalDir(projectDir);
      await db.update(projects).set({ localPath: projectDir, updatedAt: new Date() }).where(eq(projects.id, projectId));
      await db.insert(documentSources).values({
        companyId: project.companyId,
        clientId: project.clientId ?? null,
        projectId: project.id,
        type: "local",
        name: `${project.name} (project)`,
        localPath: projectDir,
      });
      logger.info({ projectId, localPath: projectDir }, "client-storage: local project folder created");
    }
  } catch (err) {
    logger.warn({ err, projectId }, "client-storage: project folder creation failed");
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Gets the ID of a named subfolder, creating it if it doesn't exist. */
async function getOrCreateDriveSubfolder(db: Db, parentId: string, name: string): Promise<string> {
  const { getAuthenticatedDriveClient } = await import("./gdrive-auth.js");
  const drive = await getAuthenticatedDriveClient(db);
  if (!drive) throw new Error("Google Drive not authenticated");

  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  const existing = res.data.files?.[0]?.id;
  if (existing) return existing;
  return createDriveFolder(db, name, parentId);
}

/** Copies an attachment from its current path into a client/project folder. */
export async function fileAttachmentToClientFolder(
  db: Db,
  storagePath: string,
  filename: string,
  clientId: string,
  subdir = "emails",
): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;

  try {
    if (client.localPath) {
      const destDir = path.join(client.localPath, "_shared", subdir);
      await ensureLocalDir(destDir);
      const dest = path.join(destDir, filename);
      await fs.copyFile(storagePath, dest);
      logger.info({ clientId, dest }, "client-storage: attachment filed locally");

    } else if (client.driveFolderId) {
      const { getAuthenticatedDriveClient } = await import("./gdrive-auth.js");
      const drive = await getAuthenticatedDriveClient(db);
      if (!drive) return;

      const sharedId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "_shared");
      const emailsId = await getOrCreateDriveSubfolder(db, sharedId, subdir);

      const content = await fs.readFile(storagePath);
      await drive.files.create({
        requestBody: { name: filename, parents: [emailsId] },
        media: { body: Buffer.from(content) },
        fields: "id",
      });
      logger.info({ clientId, filename }, "client-storage: attachment uploaded to Drive");
    }
  } catch (err) {
    logger.warn({ err, clientId, filename }, "client-storage: attachment filing failed");
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "client-storage" | head -10
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/client-storage.ts
git commit -m "feat(storage): add clientStorageService with Drive+local folder creation"
```

---

## Task 5: Hook folder creation into client and project create

**Files:**
- Modify: `server/src/services/clients.ts`
- Modify: `server/src/services/projects.ts`

- [ ] **Step 1: Hook into clientService.create**

In `server/src/services/clients.ts`, add import at top:

```typescript
import { ensureClientFolder } from "./client-storage.js";
```

Change the `create` function to fire-and-forget folder creation:

```typescript
  async function create(companyId: string, input: CreateClientInput): Promise<ClientRow> {
    const [row] = await db
      .insert(clients)
      .values({
        companyId,
        name: input.name,
        emailDomain: normaliseDomain(input.emailDomain),
        extraEmails: input.extraEmails ?? [],
        trustLevel: input.trustLevel ?? "standard",
        isMyCompany: input.isMyCompany ?? false,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .returning();
    // Fire-and-forget — folder creation is async and non-blocking
    ensureClientFolder(db, row!.id).catch(() => {});
    return row!;
  }
```

- [ ] **Step 2: Find projectService.create in projects.ts**

```bash
grep -n "async.*create\|create.*async\|insert.*projects\|projects.*insert" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/services/projects.ts | head -10
```

Read the create function signature and return type to understand where to add the hook.

- [ ] **Step 3: Hook into projectService.create**

In `server/src/services/projects.ts`, add import at top:

```typescript
import { ensureProjectFolder } from "./client-storage.js";
```

After the `db.insert(projects)` call that returns the new project row (wherever it is), add the fire-and-forget hook immediately after:

```typescript
    ensureProjectFolder(db, newProject.id).catch(() => {});
```

The exact location depends on where the insert happens. Run the grep above first to find it.

- [ ] **Step 4: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "clients.ts\|projects.ts" | grep "error" | head -5
```

- [ ] **Step 5: Commit**

```bash
git add server/src/services/clients.ts server/src/services/projects.ts
git commit -m "feat(storage): auto-create client/project folders on entity create"
```

---

## Task 6: Email attachment filing

**Files:**
- Modify: `server/src/services/email-processor.ts`

- [ ] **Step 1: Find where matchedClientId is stamped**

```bash
grep -n "matchedClientId\|matchedClient" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/server/src/services/email-processor.ts | head -10
```

- [ ] **Step 2: Add import at top of email-processor.ts**

Add this import near the top of `server/src/services/email-processor.ts`:

```typescript
import { fileAttachmentToClientFolder } from "./client-storage.js";
```

- [ ] **Step 3: Find the attachments saved block and add filing**

After attachments are saved to filesystem (the loop that calls `saveAttachment` and inserts into `emailAttachments`), the email has a `inserted!.id`. The `matchedClientId` is set later in `routeInbound`. We need to file attachments AFTER routing resolves the client.

Find the `routeInbound` call site in `processRawMessage` (around line 163 area). After the `await routeInbound(...)` call succeeds, add the filing step:

```typescript
      await routeInbound(db, inserted!.id, input.emailAccountId, fromAddr, toAddrs, subject);

      // File attachments to client folder (fire-and-forget)
      if (attachmentCount > 0) {
        const [emailRow] = await db
          .select({ matchedClientId: emailMessages.matchedClientId, attachmentsPath: emailMessages.attachmentsPath })
          .from(emailMessages)
          .where(eq(emailMessages.id, inserted!.id))
          .limit(1);
        if (emailRow?.matchedClientId && emailRow?.attachmentsPath) {
          const { resolveEmailAttachmentsRoot } = await import("../home-paths.js");
          const attachRoot = resolveEmailAttachmentsRoot();
          const attachDir = path.join(attachRoot, emailRow.attachmentsPath);
          // List files in the attachment dir and file each one
          import("node:fs/promises").then(async (fsm) => {
            try {
              const files = await fsm.readdir(attachDir);
              for (const file of files) {
                const filePath = path.join(attachDir, file);
                await fileAttachmentToClientFolder(
                  db,
                  filePath,
                  file,
                  emailRow.matchedClientId!,
                  "emails",
                );
              }
            } catch { /* non-fatal */ }
          });
        }
      }
```

Also add `import path from "node:path";` to the top if not already present.

- [ ] **Step 4: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "email-processor" | head -5
```

- [ ] **Step 5: Commit**

```bash
git add server/src/services/email-processor.ts
git commit -m "feat(storage): file email attachments to matched client folder after routing"
```

---

## Task 7: API endpoints — company root + client storage

**Files:**
- Modify: `server/src/routes/instance-storage.ts`
- Modify: `server/src/routes/clients.ts`

- [ ] **Step 1: Add company storage root endpoints to instance-storage.ts**

In `server/src/routes/instance-storage.ts`, add import:

```typescript
import { getCompanyStorageRoot, setCompanyStorageRoot } from "../services/client-storage.js";
```

Add these two routes before `return router`:

```typescript
  router.get("/instance/storage/root", async (req, res) => {
    assertAdmin(req);
    res.json(await getCompanyStorageRoot(db));
  });

  router.put("/instance/storage/root", async (req, res) => {
    assertAdmin(req);
    const { localPath, driveFolderId } = req.body as { localPath?: string | null; driveFolderId?: string | null };
    await setCompanyStorageRoot(db, {
      localPath: localPath?.trim() || null,
      driveFolderId: driveFolderId?.trim() || null,
    });
    res.json({ ok: true });
  });
```

- [ ] **Step 2: Add client storage endpoints to clients.ts**

In `server/src/routes/clients.ts`, add import:

```typescript
import { ensureClientFolder, getCompanyStorageRoot } from "../services/client-storage.js";
import { clients, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
```

Add these routes (before the final `return router`):

```typescript
  // Get client storage info
  router.get("/clients/:id/storage", async (req, res) => {
    const row = await svc.getById(req.params.id);
    if (!row) throw notFound("Client not found");
    assertCompanyAccess(req, row.companyId);
    const driveWebUrl = row.driveFolderId
      ? `https://drive.google.com/drive/folders/${row.driveFolderId}`
      : null;
    res.json({
      localPath: row.localPath,
      driveFolderId: row.driveFolderId,
      driveWebUrl,
    });
  });

  // Manually set client storage path (or trigger auto-creation)
  router.put("/clients/:id/storage", async (req, res) => {
    const row = await svc.getById(req.params.id);
    if (!row) throw notFound("Client not found");
    assertCompanyAccess(req, row.companyId);
    const { localPath, driveFolderId, autoCreate } = req.body as {
      localPath?: string | null;
      driveFolderId?: string | null;
      autoCreate?: boolean;
    };
    if (autoCreate) {
      await ensureClientFolder(db, row.id);
      const updated = await svc.getById(row.id);
      const driveWebUrl = updated?.driveFolderId
        ? `https://drive.google.com/drive/folders/${updated.driveFolderId}`
        : null;
      res.json({ localPath: updated?.localPath ?? null, driveFolderId: updated?.driveFolderId ?? null, driveWebUrl });
      return;
    }
    // Manual path override
    await db
      .update(clients)
      .set({
        localPath: localPath?.trim() || null,
        driveFolderId: driveFolderId?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, row.id));
    const driveWebUrl = driveFolderId
      ? `https://drive.google.com/drive/folders/${driveFolderId}`
      : null;
    res.json({ localPath: localPath ?? null, driveFolderId: driveFolderId ?? null, driveWebUrl });
  });

  // Get project storage info under a client
  router.get("/clients/:clientId/projects/:projectId/storage", async (req, res) => {
    const client = await svc.getById(req.params.clientId);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    const [project] = await db
      .select({ id: projects.id, localPath: projects.localPath, driveFolderId: projects.driveFolderId })
      .from(projects)
      .where(eq(projects.id, req.params.projectId))
      .limit(1);
    if (!project) throw notFound("Project not found");
    const driveWebUrl = project.driveFolderId
      ? `https://drive.google.com/drive/folders/${project.driveFolderId}`
      : null;
    res.json({ localPath: project.localPath, driveFolderId: project.driveFolderId, driveWebUrl });
  });
```

- [ ] **Step 3: Register projects import in clients.ts**

Check if `projects` from `@paperclipai/db` and `eq` from `drizzle-orm` need to be added to the imports at the top of clients route. The `db` parameter is already available from the function signature.

- [ ] **Step 4: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "instance-storage\|clients.ts" | grep "error" | head -5
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/instance-storage.ts server/src/routes/clients.ts
git commit -m "feat(storage): add company root and client storage API endpoints"
```

---

## Task 8: UI API client updates

**Files:**
- Modify: `ui/src/api/clients.ts`
- Modify: `ui/src/api/referenceDocuments.ts`

- [ ] **Step 1: Check current clients API client**

```bash
cat /home/jayjay/Work/Develtech/paperclip-v3-phase-2/ui/src/api/clients.ts
```

- [ ] **Step 2: Add storage methods to clients API**

Add to `ui/src/api/clients.ts`:

```typescript
import type { ClientStorageInfo } from "@paperclipai/shared";

// ... existing code ...

// Add to the exported clientsApi object:
  getStorage: (id: string) =>
    api.get<ClientStorageInfo>(`/clients/${encodeURIComponent(id)}/storage`),

  setStorage: (id: string, body: { localPath?: string | null; driveFolderId?: string | null; autoCreate?: boolean }) =>
    api.put<ClientStorageInfo>(`/clients/${encodeURIComponent(id)}/storage`, body),
```

- [ ] **Step 3: Add company root methods to referenceDocuments API**

Add to `ui/src/api/referenceDocuments.ts`:

```typescript
import type { CompanyStorageRoot } from "@paperclipai/shared";

// Add to referenceDocumentsApi:
  getCompanyStorageRoot: () =>
    api.get<CompanyStorageRoot>("/instance/storage/root"),

  setCompanyStorageRoot: (root: CompanyStorageRoot) =>
    api.put<{ ok: boolean }>("/instance/storage/root", root),
```

- [ ] **Step 4: Typecheck UI**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "clients.ts\|referenceDoc" | grep "error" | head -5
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/clients.ts ui/src/api/referenceDocuments.ts
git commit -m "feat(storage): add storage API client methods for clients and company root"
```

---

## Task 9: Instance Settings — company storage root UI

**Files:**
- Modify: `ui/src/pages/InstanceStorageSettings.tsx`

- [ ] **Step 1: Add CompanyStorageRootSection component**

In `ui/src/pages/InstanceStorageSettings.tsx`, add a new section ABOVE `GoogleOAuthCredsSection`. Add this component:

```tsx
function CompanyStorageRootSection() {
  const qc = useQueryClient();
  const [localPath, setLocalPath] = useState("");
  const [driveFolderId, setDriveFolderId] = useState("");
  const [editing, setEditing] = useState(false);

  const { data: root } = useQuery({
    queryKey: ["company-storage-root"],
    queryFn: () => referenceDocumentsApi.getCompanyStorageRoot(),
  });

  const save = useMutation({
    mutationFn: () =>
      referenceDocumentsApi.setCompanyStorageRoot({
        localPath: localPath.trim() || null,
        driveFolderId: driveFolderId.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-storage-root"] });
      setEditing(false);
    },
  });

  const configured = !!(root?.localPath || root?.driveFolderId);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold">Company Storage Root</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Base folder for all client and project documents. Client folders are created as{" "}
        <span className="font-mono text-xs">root/Clients/ClientName/</span> automatically.
        Set either a local path OR a Google Drive folder ID.
      </p>

      {configured && !editing ? (
        <div className="rounded-lg border border-border p-3 space-y-1.5">
          {root?.localPath && (
            <p className="text-xs font-mono text-muted-foreground">📁 {root.localPath}</p>
          )}
          {root?.driveFolderId && (
            <p className="text-xs font-mono text-muted-foreground">
              ☁️ Drive: {root.driveFolderId}
            </p>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs mt-1" onClick={() => {
            setLocalPath(root?.localPath ?? "");
            setDriveFolderId(root?.driveFolderId ?? "");
            setEditing(true);
          }}>Edit</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            placeholder="Local path (e.g. /home/user/company-docs)"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            className="text-xs h-8 font-mono"
          />
          <Input
            placeholder="OR Google Drive folder ID"
            value={driveFolderId}
            onChange={(e) => setDriveFolderId(e.target.value)}
            className="text-xs h-8 font-mono"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving..." : "Save"}
            </Button>
            {editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the section to the page render**

In `InstanceStorageSettings`, add `<CompanyStorageRootSection />` as the FIRST section in the return, before `<GoogleOAuthCredsSection />`:

```tsx
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center justify-between">
        {/* ... existing header ... */}
      </div>

      <CompanyStorageRootSection />

      <div className="border-t border-border pt-6">
        <GoogleOAuthCredsSection />
      </div>

      {/* ... rest of existing sections ... */}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "InstanceStorage" | head -5
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/InstanceStorageSettings.tsx
git commit -m "feat(storage): add company storage root section to Instance Settings"
```

---

## Task 10: ClientDetail — Storage tab

**Files:**
- Modify: `ui/src/pages/ClientDetail.tsx`

- [ ] **Step 1: Read the full ClientDetail tab structure**

```bash
grep -n "ClientTab\|tab\|Tab\|overview\|contacts" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/ui/src/pages/ClientDetail.tsx | head -20
```

- [ ] **Step 2: Add "storage" to the ClientTab type**

Find `type ClientTab = "overview" | "contacts"` and change to:

```typescript
type ClientTab = "overview" | "contacts" | "storage";
```

- [ ] **Step 3: Add StorageTab component**

Add this component in `ClientDetail.tsx` before the main `ClientDetail` export:

```tsx
import { clientsApi } from "../api/clients";
import { FolderOpen, ExternalLink } from "lucide-react";
import type { ClientStorageInfo } from "@paperclipai/shared";

function StorageTab({ client }: { client: Client }) {
  const qc = useQueryClient();

  const { data: storage, isLoading } = useQuery({
    queryKey: ["client-storage", client.id],
    queryFn: () => clientsApi.getStorage(client.id),
  });

  const autoCreate = useMutation({
    mutationFn: () => clientsApi.setStorage(client.id, { autoCreate: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["client-storage", client.id] }),
  });

  const configured = !!(storage?.localPath || storage?.driveFolderId);

  return (
    <div className="max-w-xl space-y-4">
      <Card className="p-5 space-y-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-amber-400" />
          Document Folder
        </h3>

        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : configured ? (
          <div className="space-y-2">
            {storage?.localPath && (
              <div className="rounded border border-border px-3 py-2 text-xs font-mono text-muted-foreground">
                📁 {storage.localPath}
              </div>
            )}
            {storage?.driveFolderId && (
              <div className="rounded border border-border px-3 py-2 text-xs flex items-center justify-between gap-2">
                <span className="font-mono text-muted-foreground truncate">
                  ☁️ {storage.driveFolderId}
                </span>
                {storage.driveWebUrl && (
                  <a
                    href={storage.driveWebUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-primary hover:underline flex items-center gap-1 text-xs"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Subfolders: <span className="font-mono">_shared/</span> (cross-project),{" "}
              <span className="font-mono">Projects/</span> (per-project)
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              No folder configured. Set a company storage root in Instance Settings → Storage,
              then create the folder automatically.
            </p>
            <Button
              size="sm"
              onClick={() => autoCreate.mutate()}
              disabled={autoCreate.isPending}
            >
              {autoCreate.isPending ? "Creating..." : "Create folder"}
            </Button>
            {autoCreate.isError && (
              <p className="text-xs text-destructive">
                {autoCreate.error instanceof Error ? autoCreate.error.message : "Failed"}
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Add Storage tab button and render**

Find where the tab buttons are rendered (look for `tab === "overview"` or `PageTabBar`) and add the Storage tab. Also add the storage tab render in the conditional section:

In the tab bar section add:
```tsx
{ id: "storage", label: "Storage", icon: FolderOpen }
```

In the tab content section add:
```tsx
{tab === "storage" && <StorageTab client={client} />}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "ClientDetail" | head -5
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ClientDetail.tsx
git commit -m "feat(storage): add Storage tab to ClientDetail page"
```

---

## Task 11: ProjectDetail — Storage tab

**Files:**
- Modify: `ui/src/pages/ProjectDetail.tsx`

- [ ] **Step 1: Check ProjectDetail tab structure**

```bash
grep -n "tab\|Tab\|overview\|issues\|configuration\|budget\|repo" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/ui/src/pages/ProjectDetail.tsx | head -20
```

- [ ] **Step 2: Add projectsApi storage method**

In `ui/src/api/projects.ts`, add:

```typescript
import type { ClientStorageInfo } from "@paperclipai/shared";

// Add to projectsApi:
  getStorage: (clientId: string, projectId: string) =>
    api.get<ClientStorageInfo>(`/clients/${encodeURIComponent(clientId)}/projects/${encodeURIComponent(projectId)}/storage`),
```

- [ ] **Step 3: Add ProjectStorageSection component**

In `ProjectDetail.tsx`, add a storage section visible in the configuration tab (or a dedicated tab). Find the configuration tab render location and add:

```tsx
function ProjectStorageSection({ project }: { project: Project }) {
  const { data: storage } = useQuery({
    queryKey: ["project-storage", project.clientId, project.id],
    queryFn: () => projectsApi.getStorage(project.clientId!, project.id),
    enabled: !!project.clientId,
  });

  if (!project.clientId) {
    return (
      <div className="rounded border border-border px-3 py-2 text-xs text-muted-foreground">
        Assign a client to this project to enable document storage.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium flex items-center gap-2">
        <FolderOpen className="h-4 w-4 text-amber-400" />
        Document Folder
      </h4>
      {storage?.localPath && (
        <div className="rounded border border-border px-3 py-2 text-xs font-mono text-muted-foreground">
          📁 {storage.localPath}
        </div>
      )}
      {storage?.driveFolderId && (
        <div className="rounded border border-border px-3 py-2 text-xs flex items-center justify-between gap-2">
          <span className="font-mono text-muted-foreground truncate">☁️ {storage.driveFolderId}</span>
          {storage.driveWebUrl && (
            <a href={storage.driveWebUrl} target="_blank" rel="noreferrer"
               className="shrink-0 text-primary hover:underline flex items-center gap-1 text-xs">
              Open <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
      {!storage?.localPath && !storage?.driveFolderId && (
        <p className="text-xs text-muted-foreground">
          Folder will be created automatically. Ensure a company storage root is set.
        </p>
      )}
    </div>
  );
}
```

Add `<ProjectStorageSection project={project} />` inside the existing configuration tab section.

- [ ] **Step 4: Add required imports**

Add to ProjectDetail.tsx imports:
```typescript
import { FolderOpen, ExternalLink } from "lucide-react";
import { projectsApi } from "../api/projects";
```

- [ ] **Step 5: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "ProjectDetail" | head -5
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ProjectDetail.tsx ui/src/api/projects.ts
git commit -m "feat(storage): add project storage section to ProjectDetail configuration tab"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm -r typecheck 2>&1 | grep -v "AgentPerformanceTab\|Analytics" | grep "error TS" | head -20
```
Expected: no new errors beyond pre-existing ones.

- [ ] **Step 2: Run tests**

```bash
pnpm test:run 2>&1 | tail -20
```
Expected: passing.

- [ ] **Step 3: End-to-end verification checklist**

Start dev server: `pnpm dev`

1. **Company root**: Go to Instance Settings → Storage → set a local path (e.g. `/tmp/paperclip-docs`). Verify saved.
2. **Client folder**: Create a new client. Check `/tmp/paperclip-docs/Clients/<ClientName>/` exists with `_shared/` subfolder.
3. **Project folder**: Create a project under that client. Check `Projects/<ProjectName>/` exists under client folder.
4. **Document source**: Check Instance Settings → Storage → Local Folders — new source for client appears.
5. **Email attachment filing**: Send a test email with attachment to configured inbox. After processing, verify attachment appears in `/tmp/paperclip-docs/Clients/<ClientName>/_shared/emails/`.
6. **ClientDetail Storage tab**: Open client → Storage tab → folder path shown with no errors.
7. **Drive**: If Drive connected, repeat steps 2-5 with a Drive folder ID as root. Verify folders created in Drive.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(storage): client document storage — complete implementation"
```
