# Document Storage & Agent Reference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync local folders and Google Drive into Paperclip's database so agents have a reference document library injected into their system prompt context.

**Architecture:** New `reference_documents` + `document_sources` DB tables store synced file metadata and extracted text. A sync service handles local filesystem and Google Drive ingestion. Agent `buildSystemPrompt` injects a lightweight index; agents fetch full content on demand via a tool intercept in the stream-json loop.

**Tech Stack:** Drizzle ORM, `pdf-parse`, `mammoth`, `googleapis` (Google Drive), React 19 + TanStack Query, Express 5, existing `chat-direct.ts` stream-json infrastructure.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/db/src/schema/reference_documents.ts` | Create | DB table for synced documents |
| `packages/db/src/schema/document_sources.ts` | Create | DB table for sync source configs |
| `packages/db/src/schema/index.ts` | Modify | Export new tables |
| `packages/shared/src/types/document-storage.ts` | Create | Shared types for docs + sources |
| `packages/shared/src/types/index.ts` | Modify | Export new types |
| `server/src/services/document-extractor.ts` | Create | PDF/DOCX/text extraction |
| `server/src/services/document-sync.ts` | Create | Local + Drive sync orchestration |
| `server/src/services/gdrive-auth.ts` | Create | Google Drive OAuth2 tokens |
| `server/src/services/reference-documents.ts` | Create | DB CRUD for reference docs |
| `server/src/routes/reference-documents.ts` | Create | REST API for docs + sources |
| `server/src/routes/instance-storage.ts` | Create | Google Drive OAuth routes |
| `server/src/app.ts` | Modify | Register new routes |
| `server/src/services/chat-direct.ts` | Modify | Document index injection + fetch tool |
| `ui/src/api/referenceDocuments.ts` | Create | API client for docs + sources |
| `ui/src/pages/DocumentLibrary.tsx` | Create | `/documents` page |
| `ui/src/pages/InstanceSettings/StorageTab.tsx` | Create | Drive auth + source config UI |
| `ui/src/components/chat/ChatComposer.tsx` | Modify | `*` document trigger |
| `ui/src/components/chat/ChatMessage.tsx` | Modify | Document context pill |
| `ui/src/api/chat.ts` | Modify | `"document"` contextRef type |

---

## Task 1: DB Schema — `reference_documents` and `document_sources`

**Files:**
- Create: `packages/db/src/schema/reference_documents.ts`
- Create: `packages/db/src/schema/document_sources.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create `reference_documents` schema**

```typescript
// packages/db/src/schema/reference_documents.ts
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const referenceDocuments = pgTable(
  "reference_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    mimeType: text("mime_type"),
    sourceType: text("source_type").notNull().default("upload"), // "local" | "gdrive" | "upload"
    sourcePath: text("source_path"),
    driveFileId: text("drive_file_id"),
    driveWebUrl: text("drive_web_url"),
    extractedText: text("extracted_text"),
    checksum: text("checksum"),
    scope: text("scope").notNull().default("company"), // "company" | "project"
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    includeInContext: boolean("include_in_context").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("reference_documents_company_idx").on(table.companyId, table.updatedAt),
    projectIdx: index("reference_documents_project_idx").on(table.projectId),
    driveFileIdx: index("reference_documents_drive_file_idx").on(table.driveFileId),
    sourcePathIdx: index("reference_documents_source_path_idx").on(table.sourcePath),
  }),
);
```

- [ ] **Step 2: Create `document_sources` schema**

```typescript
// packages/db/src/schema/document_sources.ts
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const documentSources = pgTable(
  "document_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
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
  }),
);
```

- [ ] **Step 3: Export from schema index**

In `packages/db/src/schema/index.ts`, add at the end of the existing exports:
```typescript
export { referenceDocuments } from "./reference_documents.js";
export { documentSources } from "./document_sources.js";
```

- [ ] **Step 4: Generate migration**

```bash
cd /path/to/paperclip-v3-phase-2
pnpm db:generate
```

Expected: new migration file created in `packages/db/src/migrations/`

- [ ] **Step 5: Apply migration**

```bash
pnpm db:migrate
```

Expected: migration applied successfully, no errors

- [ ] **Step 6: Typecheck**

```bash
pnpm -r typecheck
```

Expected: passes (only pre-existing AgentPerformanceTab/Analytics.tsx errors are acceptable)

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/reference_documents.ts packages/db/src/schema/document_sources.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add reference_documents and document_sources tables"
```

---

## Task 2: Shared Types

**Files:**
- Create: `packages/shared/src/types/document-storage.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Create shared types**

```typescript
// packages/shared/src/types/document-storage.ts

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
```

- [ ] **Step 2: Export from shared index**

In `packages/shared/src/types/index.ts`, add:
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
} from "./document-storage.js";
```

- [ ] **Step 3: Build shared**

```bash
pnpm --filter @paperclipai/shared build
```

Expected: builds without errors

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/document-storage.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add document storage types"
```

---

## Task 3: Install Server Dependencies

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install extraction and Drive libraries**

```bash
cd server
pnpm add pdf-parse mammoth googleapis
pnpm add -D @types/pdf-parse @types/mammoth
```

- [ ] **Step 2: Verify install**

```bash
pnpm -r typecheck
```

Expected: no new type errors

- [ ] **Step 3: Commit**

```bash
git add server/package.json pnpm-lock.yaml
git commit -m "chore(server): add pdf-parse, mammoth, googleapis dependencies"
```

---

## Task 4: Text Extraction Service

**Files:**
- Create: `server/src/services/document-extractor.ts`

- [ ] **Step 1: Write the extractor**

```typescript
// server/src/services/document-extractor.ts
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export async function extractTextFromFile(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  if (stat.size > MAX_BYTES) {
    logger.warn({ filePath, size: stat.size }, "document-extractor: file too large, skipping");
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".md" || ext === ".txt") {
      return await fs.readFile(filePath, "utf-8");
    }
    if (ext === ".pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const buffer = await fs.readFile(filePath);
      const data = await pdfParse(buffer);
      return data.text ?? null;
    }
    if (ext === ".docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value ?? null;
    }
    return null;
  } catch (err) {
    logger.warn({ err, filePath }, "document-extractor: extraction failed");
    return null;
  }
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    if (mimeType === "text/plain" || mimeType === "text/markdown") {
      return buffer.toString("utf-8");
    }
    if (mimeType === "application/pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const data = await pdfParse(buffer);
      return data.text ?? null;
    }
    if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value ?? null;
    }
    return null;
  } catch (err) {
    logger.warn({ err, mimeType }, "document-extractor: buffer extraction failed");
    return null;
  }
}

export function computeChecksum(content: string | Buffer): string {
  const { createHash } = require("node:crypto");
  const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return createHash("md5").update(data).digest("hex");
}

export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx"]);
export const SUPPORTED_DRIVE_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document", // Google Doc — exported as text/plain
]);
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: passes

- [ ] **Step 3: Commit**

```bash
git add server/src/services/document-extractor.ts
git commit -m "feat(server): add document text extraction service"
```

---

## Task 5: Google Drive Auth Service

**Files:**
- Create: `server/src/services/gdrive-auth.ts`

- [ ] **Step 1: Write the auth service**

```typescript
// server/src/services/gdrive-auth.ts
import { google } from "googleapis";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const SINGLETON_KEY = "default";
const GDRIVE_SETTINGS_KEY = "gdriveOAuth";

interface GDriveTokens {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: number;
}

function getOAuthClient(redirectUri: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(redirectUri: string): string {
  const oauth2 = getOAuthClient(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    prompt: "consent",
  });
}

async function getSettings(db: Db) {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  return rows[0] ?? null;
}

async function setGDriveTokens(db: Db, tokens: GDriveTokens): Promise<void> {
  const existing = await getSettings(db);
  const general = (existing?.general ?? {}) as Record<string, unknown>;
  const updated = { ...general, [GDRIVE_SETTINGS_KEY]: tokens };
  if (existing) {
    await db
      .update(instanceSettings)
      .set({ general: updated, updatedAt: new Date() })
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  } else {
    await db.insert(instanceSettings).values({
      singletonKey: SINGLETON_KEY,
      general: updated,
      experimental: {},
    });
  }
}

export async function exchangeCodeForTokens(
  db: Db,
  code: string,
  redirectUri: string,
): Promise<void> {
  const oauth2 = getOAuthClient(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
  const userInfo = await oauth2Api.userinfo.get();
  const email = userInfo.data.email ?? "";

  await setGDriveTokens(db, {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? "",
    email,
    expiresAt: tokens.expiry_date ?? 0,
  });
  logger.info({ email }, "gdrive-auth: tokens stored");
}

export async function getAuthenticatedDriveClient(db: Db) {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GDRIVE_SETTINGS_KEY] as GDriveTokens | undefined;
  if (!tokens?.refreshToken) return null;

  const oauth2 = getOAuthClient("");
  oauth2.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt,
  });
  return google.drive({ version: "v3", auth: oauth2 });
}

export async function getGDriveStatus(db: Db): Promise<{ connected: boolean; email: string | null }> {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GDRIVE_SETTINGS_KEY] as GDriveTokens | undefined;
  return { connected: !!tokens?.refreshToken, email: tokens?.email ?? null };
}

export async function disconnectGDrive(db: Db): Promise<void> {
  const row = await getSettings(db);
  if (!row) return;
  const general = { ...(row.general as Record<string, unknown>) };
  delete general[GDRIVE_SETTINGS_KEY];
  await db
    .update(instanceSettings)
    .set({ general, updatedAt: new Date() })
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: passes

- [ ] **Step 3: Commit**

```bash
git add server/src/services/gdrive-auth.ts
git commit -m "feat(server): add Google Drive OAuth2 auth service"
```

---

## Task 6: Reference Documents DB Service

**Files:**
- Create: `server/src/services/reference-documents.ts`

- [ ] **Step 1: Write the DB service**

```typescript
// server/src/services/reference-documents.ts
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentSources, referenceDocuments } from "@paperclipai/db";
import type {
  ReferenceDocument,
  ReferenceDocumentWithContent,
  DocumentSource,
  UpdateReferenceDocumentInput,
  CreateDocumentSourceInput,
} from "@paperclipai/shared";

function toDocument(row: typeof referenceDocuments.$inferSelect): ReferenceDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    description: row.description,
    mimeType: row.mimeType,
    sourceType: row.sourceType as ReferenceDocument["sourceType"],
    sourcePath: row.sourcePath,
    driveFileId: row.driveFileId,
    driveWebUrl: row.driveWebUrl,
    scope: row.scope as ReferenceDocument["scope"],
    projectId: row.projectId,
    includeInContext: row.includeInContext,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocumentWithContent(row: typeof referenceDocuments.$inferSelect): ReferenceDocumentWithContent {
  return { ...toDocument(row), extractedText: row.extractedText };
}

function toSource(row: typeof documentSources.$inferSelect): DocumentSource {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as DocumentSource["type"],
    name: row.name,
    localPath: row.localPath,
    driveFolderId: row.driveFolderId,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    createdAt: row.createdAt.toISOString(),
  };
}

export function referenceDocumentsService(db: Db) {
  return {
    listDocuments: async (
      companyId: string,
      filters?: { projectId?: string; scope?: string; sourceType?: string },
    ): Promise<ReferenceDocument[]> => {
      const conditions = [eq(referenceDocuments.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(referenceDocuments.projectId, filters.projectId));
      if (filters?.scope) conditions.push(eq(referenceDocuments.scope, filters.scope));
      if (filters?.sourceType) conditions.push(eq(referenceDocuments.sourceType, filters.sourceType));
      const rows = await db
        .select()
        .from(referenceDocuments)
        .where(and(...conditions))
        .orderBy(desc(referenceDocuments.updatedAt));
      return rows.map(toDocument);
    },

    getDocument: async (companyId: string, docId: string): Promise<ReferenceDocument | null> => {
      const [row] = await db
        .select()
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)))
        .limit(1);
      return row ? toDocument(row) : null;
    },

    getDocumentContent: async (companyId: string, docId: string): Promise<ReferenceDocumentWithContent | null> => {
      const [row] = await db
        .select()
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)))
        .limit(1);
      return row ? toDocumentWithContent(row) : null;
    },

    updateDocument: async (
      companyId: string,
      docId: string,
      input: UpdateReferenceDocumentInput,
    ): Promise<ReferenceDocument | null> => {
      const [row] = await db
        .update(referenceDocuments)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)))
        .returning();
      return row ? toDocument(row) : null;
    },

    deleteDocument: async (companyId: string, docId: string): Promise<void> => {
      await db
        .delete(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)));
    },

    upsertBySourcePath: async (
      companyId: string,
      sourcePath: string,
      data: Partial<typeof referenceDocuments.$inferInsert>,
    ): Promise<void> => {
      const [existing] = await db
        .select({ id: referenceDocuments.id, checksum: referenceDocuments.checksum })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourcePath, sourcePath)))
        .limit(1);
      if (existing) {
        if (existing.checksum === data.checksum) return; // unchanged
        await db
          .update(referenceDocuments)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(referenceDocuments.id, existing.id));
      } else {
        await db.insert(referenceDocuments).values({
          companyId,
          title: data.title ?? sourcePath.split("/").pop() ?? "Untitled",
          sourceType: "local",
          sourcePath,
          scope: "company",
          includeInContext: true,
          ...data,
        });
      }
    },

    upsertByDriveFileId: async (
      companyId: string,
      driveFileId: string,
      data: Partial<typeof referenceDocuments.$inferInsert>,
    ): Promise<void> => {
      const [existing] = await db
        .select({ id: referenceDocuments.id, checksum: referenceDocuments.checksum })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.driveFileId, driveFileId)))
        .limit(1);
      if (existing) {
        if (existing.checksum === data.checksum) return;
        await db
          .update(referenceDocuments)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(referenceDocuments.id, existing.id));
      } else {
        await db.insert(referenceDocuments).values({
          companyId,
          title: data.title ?? "Untitled",
          sourceType: "gdrive",
          driveFileId,
          scope: "company",
          includeInContext: true,
          ...data,
        });
      }
    },

    deleteBySourcePathsNotIn: async (companyId: string, keepPaths: string[]): Promise<void> => {
      if (keepPaths.length === 0) {
        await db
          .delete(referenceDocuments)
          .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourceType, "local")));
        return;
      }
      // Delete local docs whose paths are not in keepPaths
      const rows = await db
        .select({ id: referenceDocuments.id, sourcePath: referenceDocuments.sourcePath })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourceType, "local")));
      const toDelete = rows
        .filter((r) => r.sourcePath && !keepPaths.includes(r.sourcePath))
        .map((r) => r.id);
      if (toDelete.length > 0) {
        await db.delete(referenceDocuments).where(inArray(referenceDocuments.id, toDelete));
      }
    },

    deleteByDriveFileIdsNotIn: async (companyId: string, keepIds: string[]): Promise<void> => {
      const rows = await db
        .select({ id: referenceDocuments.id, driveFileId: referenceDocuments.driveFileId })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourceType, "gdrive")));
      const toDelete = rows
        .filter((r) => r.driveFileId && !keepIds.includes(r.driveFileId))
        .map((r) => r.id);
      if (toDelete.length > 0) {
        await db.delete(referenceDocuments).where(inArray(referenceDocuments.id, toDelete));
      }
    },

    getContextIndex: async (companyId: string, projectId?: string): Promise<ReferenceDocument[]> => {
      const conditions = [
        eq(referenceDocuments.companyId, companyId),
        eq(referenceDocuments.includeInContext, true),
      ];
      if (projectId) {
        conditions.push(
          or(
            eq(referenceDocuments.scope, "company"),
            and(eq(referenceDocuments.scope, "project"), eq(referenceDocuments.projectId, projectId)),
          )!,
        );
      } else {
        conditions.push(eq(referenceDocuments.scope, "company"));
      }
      return (
        await db
          .select()
          .from(referenceDocuments)
          .where(and(...conditions))
          .orderBy(referenceDocuments.title)
          .limit(50)
      ).map(toDocument);
    },

    // Document sources
    listSources: async (companyId: string): Promise<DocumentSource[]> => {
      const rows = await db
        .select()
        .from(documentSources)
        .where(eq(documentSources.companyId, companyId))
        .orderBy(documentSources.createdAt);
      return rows.map(toSource);
    },

    createSource: async (companyId: string, input: CreateDocumentSourceInput): Promise<DocumentSource> => {
      const [row] = await db
        .insert(documentSources)
        .values({ companyId, ...input })
        .returning();
      return toSource(row!);
    },

    deleteSource: async (companyId: string, sourceId: string): Promise<void> => {
      await db
        .delete(documentSources)
        .where(and(eq(documentSources.companyId, companyId), eq(documentSources.id, sourceId)));
    },

    updateSourceSyncResult: async (
      sourceId: string,
      error: string | null,
    ): Promise<void> => {
      await db
        .update(documentSources)
        .set({ lastSyncedAt: new Date(), lastSyncError: error })
        .where(eq(documentSources.id, sourceId));
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:
```typescript
export { referenceDocumentsService } from "./reference-documents.js";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

- [ ] **Step 4: Commit**

```bash
git add server/src/services/reference-documents.ts server/src/services/index.ts
git commit -m "feat(server): add reference documents DB service"
```

---

## Task 7: Document Sync Service

**Files:**
- Create: `server/src/services/document-sync.ts`

- [ ] **Step 1: Write the sync service**

```typescript
// server/src/services/document-sync.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { documentSources } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  extractTextFromFile,
  extractTextFromBuffer,
  computeChecksum,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_DRIVE_MIME_TYPES,
} from "./document-extractor.js";
import { referenceDocumentsService } from "./reference-documents.js";
import { getAuthenticatedDriveClient } from "./gdrive-auth.js";
import { logger } from "../middleware/logger.js";

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walkDir(full)));
      } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  } catch {
    // unreadable directory
  }
  return results;
}

async function syncLocalSource(
  db: Db,
  companyId: string,
  sourceId: string,
  localPath: string,
): Promise<void> {
  const svc = referenceDocumentsService(db);
  const files = await walkDir(localPath);
  const processedPaths: string[] = [];

  for (const filePath of files) {
    try {
      const raw = await fs.readFile(filePath);
      const checksum = computeChecksum(raw);
      const text = await extractTextFromFile(filePath);
      if (text === null) continue;
      const title = path.basename(filePath, path.extname(filePath));
      await svc.upsertBySourcePath(companyId, filePath, {
        title,
        sourceType: "local",
        mimeType: `text/${path.extname(filePath).slice(1)}`,
        extractedText: text.slice(0, 50_000),
        checksum,
        syncedAt: new Date(),
      });
      processedPaths.push(filePath);
    } catch (err) {
      logger.warn({ err, filePath }, "document-sync: local file error");
    }
  }

  await svc.deleteBySourcePathsNotIn(companyId, processedPaths);
  await svc.updateSourceSyncResult(sourceId, null);
}

async function syncDriveSource(
  db: Db,
  companyId: string,
  sourceId: string,
  folderId: string,
): Promise<void> {
  const drive = await getAuthenticatedDriveClient(db);
  if (!drive) {
    await referenceDocumentsService(db).updateSourceSyncResult(sourceId, "Google Drive not authenticated");
    return;
  }

  const svc = referenceDocumentsService(db);
  const processedIds: string[] = [];

  // List all files in the folder (non-recursive for simplicity; add recursive via parents query if needed)
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)",
      pageToken,
      pageSize: 100,
    });
    const files = res.data.files ?? [];
    pageToken = res.data.nextPageToken ?? undefined;

    for (const file of files) {
      if (!file.id || !file.mimeType) continue;
      if (!SUPPORTED_DRIVE_MIME_TYPES.has(file.mimeType)) continue;
      if (Number(file.size ?? 0) > 10 * 1024 * 1024) continue;

      try {
        let buffer: Buffer;
        let mimeType = file.mimeType;

        if (file.mimeType === "application/vnd.google-apps.document") {
          const exportRes = await drive.files.export(
            { fileId: file.id, mimeType: "text/plain" },
            { responseType: "arraybuffer" },
          );
          buffer = Buffer.from(exportRes.data as ArrayBuffer);
          mimeType = "text/plain";
        } else {
          const dlRes = await drive.files.get(
            { fileId: file.id, alt: "media" },
            { responseType: "arraybuffer" },
          );
          buffer = Buffer.from(dlRes.data as ArrayBuffer);
        }

        const checksum = computeChecksum(buffer);
        const text = await extractTextFromBuffer(buffer, mimeType);
        if (!text) continue;

        await svc.upsertByDriveFileId(companyId, file.id, {
          title: file.name ?? "Untitled",
          sourceType: "gdrive",
          mimeType,
          driveWebUrl: file.webViewLink ?? null,
          extractedText: text.slice(0, 50_000),
          checksum,
          syncedAt: new Date(),
        });
        processedIds.push(file.id);
      } catch (err) {
        logger.warn({ err, fileId: file.id }, "document-sync: drive file error");
      }
    }
  } while (pageToken);

  await svc.deleteByDriveFileIdsNotIn(companyId, processedIds);
  await svc.updateSourceSyncResult(sourceId, null);
}

export async function syncCompanyDocuments(db: Db, companyId: string): Promise<void> {
  logger.info({ companyId }, "document-sync: starting sync");
  const sources = await db
    .select()
    .from(documentSources)
    .where(eq(documentSources.companyId, companyId));

  for (const source of sources) {
    try {
      if (source.type === "local" && source.localPath) {
        await syncLocalSource(db, companyId, source.id, source.localPath);
      } else if (source.type === "gdrive" && source.driveFolderId) {
        await syncDriveSource(db, companyId, source.id, source.driveFolderId);
      }
    } catch (err) {
      logger.warn({ err, sourceId: source.id }, "document-sync: source sync failed");
      await referenceDocumentsService(db).updateSourceSyncResult(
        source.id,
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }
  logger.info({ companyId }, "document-sync: sync complete");
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/document-sync.ts
git commit -m "feat(server): add local and Google Drive document sync service"
```

---

## Task 8: API Routes

**Files:**
- Create: `server/src/routes/reference-documents.ts`
- Create: `server/src/routes/instance-storage.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Write document + source routes**

```typescript
// server/src/routes/reference-documents.ts
import { Router } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { referenceDocumentsService } from "../services/reference-documents.js";
import { syncCompanyDocuments } from "../services/document-sync.js";
import { extractTextFromBuffer, computeChecksum } from "../services/document-extractor.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function referenceDocumentsRoutes(db: Db): Router {
  const router = Router();
  const svc = referenceDocumentsService(db);

  // Documents
  router.get("/companies/:companyId/documents", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { projectId, scope, sourceType } = req.query as Record<string, string | undefined>;
    res.json(await svc.listDocuments(req.params.companyId, { projectId, scope, sourceType }));
  });

  router.get("/companies/:companyId/documents/:docId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const doc = await svc.getDocument(req.params.companyId, req.params.docId);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  router.get("/companies/:companyId/documents/:docId/content", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const doc = await svc.getDocumentContent(req.params.companyId, req.params.docId);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  router.post("/companies/:companyId/documents", upload.single("file"), async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const file = req.file;
    if (!file) { res.status(400).json({ error: "file required" }); return; }
    const text = await extractTextFromBuffer(file.buffer, file.mimetype);
    const checksum = computeChecksum(file.buffer);
    const { scope, projectId } = req.body as { scope?: string; projectId?: string };
    const [row] = await import("@paperclipai/db").then(({ referenceDocuments: t }) =>
      db.insert(t).values({
        companyId: req.params.companyId,
        title: file.originalname,
        mimeType: file.mimetype,
        sourceType: "upload",
        extractedText: text?.slice(0, 50_000) ?? null,
        checksum,
        scope: (scope as "company" | "project") ?? "company",
        projectId: projectId ?? null,
        includeInContext: true,
        syncedAt: new Date(),
      }).returning()
    );
    res.status(201).json(row);
  });

  router.patch("/companies/:companyId/documents/:docId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const doc = await svc.updateDocument(req.params.companyId, req.params.docId, req.body);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  router.delete("/companies/:companyId/documents/:docId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    await svc.deleteDocument(req.params.companyId, req.params.docId);
    res.status(204).end();
  });

  // Sources
  router.get("/companies/:companyId/document-sources", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json(await svc.listSources(req.params.companyId));
  });

  router.post("/companies/:companyId/document-sources", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const source = await svc.createSource(req.params.companyId, req.body);
    res.status(201).json(source);
  });

  router.delete("/companies/:companyId/document-sources/:sourceId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    await svc.deleteSource(req.params.companyId, req.params.sourceId);
    res.status(204).end();
  });

  router.post("/companies/:companyId/document-sources/sync", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
    syncCompanyDocuments(db, req.params.companyId).catch(() => {});
  });

  return router;
}
```

- [ ] **Step 2: Write instance storage routes (Google Drive OAuth)**

```typescript
// server/src/routes/instance-storage.ts
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { getAuthUrl, exchangeCodeForTokens, getGDriveStatus, disconnectGDrive } from "../services/gdrive-auth.js";
import { forbidden } from "../errors.js";

function assertAdmin(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
}

export function instanceStorageRoutes(db: Db): Router {
  const router = Router();

  router.get("/instance/storage/gdrive/status", async (req, res) => {
    assertAdmin(req);
    res.json(await getGDriveStatus(db));
  });

  router.get("/instance/storage/gdrive/auth", async (req, res) => {
    assertAdmin(req);
    const redirectUri = `${req.protocol}://${req.get("host")}/api/instance/storage/gdrive/callback`;
    res.json({ url: getAuthUrl(redirectUri) });
  });

  router.get("/instance/storage/gdrive/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) { res.status(400).send("Missing code"); return; }
    const redirectUri = `${req.protocol}://${req.get("host")}/api/instance/storage/gdrive/callback`;
    await exchangeCodeForTokens(db, code, redirectUri);
    res.send("<script>window.close();</script>Connected! You can close this window.");
  });

  router.delete("/instance/storage/gdrive/auth", async (req, res) => {
    assertAdmin(req);
    await disconnectGDrive(db);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 3: Register routes in app.ts**

In `server/src/app.ts`, add imports:
```typescript
import { referenceDocumentsRoutes } from "./routes/reference-documents.js";
import { instanceStorageRoutes } from "./routes/instance-storage.js";
```

And register after existing routes (near the bottom of the `api.use(...)` block):
```typescript
api.use(referenceDocumentsRoutes(db));
api.use(instanceStorageRoutes(db));
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/reference-documents.ts server/src/routes/instance-storage.ts server/src/app.ts
git commit -m "feat(server): add document library and Google Drive auth API routes"
```

---

## Task 9: Agent Context Injection

**Files:**
- Modify: `server/src/services/chat-direct.ts`

- [ ] **Step 1: Import and inject document index in buildSystemPrompt**

In `server/src/services/chat-direct.ts`, add import:
```typescript
import { referenceDocumentsService } from "./reference-documents.js";
```

In `buildSystemPrompt`, after the existing `snapshot` array is built (after agents + projects snapshot), add before `snapshot.push('--- END CONTEXT ---')`:

```typescript
  // Document index
  const projectId = contextRefs.find((r) => r.type === "project")?.id;
  const docs = await referenceDocumentsService(db).getContextIndex(companyId, projectId);
  if (docs.length > 0) {
    snapshot.push(`\n--- DOCUMENTS ---`);
    for (const doc of docs) {
      const scopeLabel = doc.scope === "project" ? `project` : "company";
      snapshot.push(`[${doc.id.slice(0, 8)}] ${doc.title} (${scopeLabel})${doc.description ? ` — ${doc.description}` : ""}`);
    }
    snapshot.push(`To read full content: call fetch_document(id) with the doc ID above.`);
    snapshot.push(`--- END DOCUMENTS ---`);
  }

  // Inject full text for explicitly selected document context refs
  const docRefs = contextRefs.filter((r) => r.type === "document");
  if (docRefs.length > 0) {
    snapshot.push(`\n--- SELECTED DOCUMENTS (full content) ---`);
    for (const ref of docRefs) {
      const content = await referenceDocumentsService(db).getDocumentContent(companyId, ref.id);
      if (content?.extractedText) {
        snapshot.push(`\n## ${content.title}\n${content.extractedText.slice(0, 10_000)}`);
      }
    }
    snapshot.push(`--- END SELECTED DOCUMENTS ---`);
  }
```

- [ ] **Step 2: Handle fetch_document tool call in stream-json loop**

In the stream-json parse loop in `chatLeanReply` (inside `proc.stdout.on("data", ...)` where `tool_use` events are handled), add after the existing `tool_use` handler:

```typescript
            // Handle fetch_document tool call
            if (type === "tool_use" && event.name === "fetch_document") {
              const docId = (event.input as { id?: string } | undefined)?.id ?? "";
              const content = await referenceDocumentsService(db).getDocumentContent(companyId, docId);
              const resultText = content?.extractedText ?? "Document not found.";
              // Inject tool_result into stdin by writing to the process
              // Note: for stream-json --print mode, claude handles tool results automatically
              // via the conversation; we log the fetch for observability
              void logActivity(db, {
                companyId, actorType: "agent", actorId: agent.id,
                action: "chat.doc_fetch", entityType: "chat_thread", entityId: threadId,
                agentId: agent.id,
                details: { docId, title: content?.title ?? null, found: !!content },
              });
              emitStatus(`📄 ${agent.name} → fetch_document: \`${content?.title ?? docId}\``);
            }
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

- [ ] **Step 4: Commit**

```bash
git add server/src/services/chat-direct.ts
git commit -m "feat(server): inject document index into agent system prompt"
```

---

## Task 10: UI API Client

**Files:**
- Create: `ui/src/api/referenceDocuments.ts`
- Modify: `ui/src/api/chat.ts`

- [ ] **Step 1: Write the API client**

```typescript
// ui/src/api/referenceDocuments.ts
import type {
  ReferenceDocument,
  ReferenceDocumentWithContent,
  DocumentSource,
  CreateDocumentSourceInput,
  UpdateReferenceDocumentInput,
  GoogleDriveStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export const referenceDocumentsApi = {
  list: (companyId: string, params?: { projectId?: string; scope?: string; sourceType?: string }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set("projectId", params.projectId);
    if (params?.scope) qs.set("scope", params.scope);
    if (params?.sourceType) qs.set("sourceType", params.sourceType);
    const q = qs.toString();
    return api.get<ReferenceDocument[]>(`/companies/${companyId}/documents${q ? `?${q}` : ""}`);
  },

  get: (companyId: string, docId: string) =>
    api.get<ReferenceDocument>(`/companies/${companyId}/documents/${docId}`),

  getContent: (companyId: string, docId: string) =>
    api.get<ReferenceDocumentWithContent>(`/companies/${companyId}/documents/${docId}/content`),

  upload: (companyId: string, file: File, scope: "company" | "project", projectId?: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("scope", scope);
    if (projectId) form.append("projectId", projectId);
    return api.postForm<ReferenceDocument>(`/companies/${companyId}/documents`, form);
  },

  update: (companyId: string, docId: string, input: UpdateReferenceDocumentInput) =>
    api.patch<ReferenceDocument>(`/companies/${companyId}/documents/${docId}`, input),

  delete: (companyId: string, docId: string) =>
    api.delete<void>(`/companies/${companyId}/documents/${docId}`),

  listSources: (companyId: string) =>
    api.get<DocumentSource[]>(`/companies/${companyId}/document-sources`),

  createSource: (companyId: string, input: CreateDocumentSourceInput) =>
    api.post<DocumentSource>(`/companies/${companyId}/document-sources`, input),

  deleteSource: (companyId: string, sourceId: string) =>
    api.delete<void>(`/companies/${companyId}/document-sources/${sourceId}`),

  triggerSync: (companyId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/document-sources/sync`, {}),

  getGDriveStatus: () =>
    api.get<GoogleDriveStatus>("/instance/storage/gdrive/status"),

  getGDriveAuthUrl: () =>
    api.get<{ url: string }>("/instance/storage/gdrive/auth"),

  disconnectGDrive: () =>
    api.delete<{ ok: boolean }>("/instance/storage/gdrive/auth"),
};
```

- [ ] **Step 2: Add `"document"` to ContextRef type in `ui/src/api/chat.ts`**

```typescript
export interface ContextRef {
  type: "issue" | "project" | "client" | "agent" | "document";
  id: string;
  label: string;
  meta?: {
    cwd?: string;
    status?: string;
    role?: string;
    sourceType?: string;
    driveWebUrl?: string;
  };
}
```

- [ ] **Step 3: Typecheck UI**

```bash
pnpm --filter @paperclipai/ui typecheck
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/referenceDocuments.ts ui/src/api/chat.ts
git commit -m "feat(ui): add document storage API client and document contextRef type"
```

---

## Task 11: Chat Composer `*` Trigger

**Files:**
- Modify: `ui/src/components/chat/ChatComposer.tsx`

- [ ] **Step 1: Add document query and `*` trigger**

In `ChatComposer.tsx`, add import:
```typescript
import { referenceDocumentsApi } from "../../api/referenceDocuments";
```

Add to `MentionTrigger` type:
```typescript
type MentionTrigger = "@" | "#" | "$" | "/" | "%" | "*" | null;
```

Add document query (after the clientList query):
```typescript
  const { data: docList = [] } = useQuery({
    queryKey: ["reference-docs", companyId],
    queryFn: () => referenceDocumentsApi.list(companyId),
    enabled: mentionTrigger === "*",
  });
```

Add to `getMentionItems()`:
```typescript
    if (mentionTrigger === "*") {
      return docList
        .filter((d) => d.title.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q))
        .slice(0, 8)
        .map((d) => ({
          label: d.title,
          value: `*doc:${d.id}`,
          sublabel: d.description ?? d.sourceType,
        }));
    }
```

Add to `handleChange` (after pctMatch):
```typescript
    const starMatch = before.match(/(?:^|\s)\*([\w-]*)$/);
    // ... existing conditions ...
    } else if (starMatch) {
      setMentionTrigger("*");
      setMentionQuery(starMatch[1] ?? "");
    }
```

Add to `handleMentionSelect`:
```typescript
    } else if (mentionTrigger === "*") {
      setBody((prev) => prev.replace(/\*[\w-]*$/, "").trimEnd());
      const docId = item.value.replace("*doc:", "");
      addContextRef({ type: "document", id: docId, label: item.label });
    }
```

Update placeholder text:
```typescript
placeholder={placeholder ?? "Message — @agent  $issue  /project  %client  *doc  #room"}
```

Add document color to `CONTEXT_REF_COLORS`:
```typescript
  document: "bg-purple-950 border-purple-800 text-purple-300",
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/ui typecheck
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/chat/ChatComposer.tsx
git commit -m "feat(ui): add * document trigger to chat composer"
```

---

## Task 12: Document Pill in ChatMessage

**Files:**
- Modify: `ui/src/components/chat/ChatMessage.tsx`

- [ ] **Step 1: Add document to pill colors and expanded view**

In `CONTEXT_REF_COLORS`, add:
```typescript
  document: "bg-purple-950 border-purple-800 text-purple-300",
```

In the expanded pill `ContextPills` component, update the expanded content for document refs:
```typescript
              {ref.type === "document" && (
                <>
                  <div className="font-medium text-foreground">{ref.label}</div>
                  <div className="opacity-60">document{ref.meta?.sourceType ? ` · ${ref.meta.sourceType}` : ""}</div>
                  {ref.meta?.driveWebUrl && (
                    <a
                      href={ref.meta.driveWebUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-blue-400 hover:underline mt-0.5 block"
                    >
                      Open in Drive →
                    </a>
                  )}
                </>
              )}
```

Replace the current generic `ContextPills` expanded div with a type-aware version:
```typescript
          {expanded === ref.id && (
            <div className="mt-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground max-w-[280px] space-y-0.5">
              {ref.type === "document" ? (
                <>
                  <div className="font-medium text-foreground">{ref.label}</div>
                  <div className="opacity-60">document{ref.meta?.sourceType ? ` · ${ref.meta.sourceType}` : ""}</div>
                  {ref.meta?.driveWebUrl && (
                    <a href={ref.meta.driveWebUrl} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-blue-400 hover:underline mt-0.5 block">
                      Open in Drive →
                    </a>
                  )}
                </>
              ) : (
                <>
                  <div className="font-medium text-foreground">{ref.label}</div>
                  <div className="opacity-60">{ref.type}{ref.meta?.status ? ` · ${ref.meta.status}` : ""}{ref.meta?.role ? ` · ${ref.meta.role}` : ""}</div>
                  {ref.meta?.cwd && (
                    <div className="flex items-center gap-1 mt-1 pt-1 border-t border-border">
                      <span className="text-green-400">📁</span>
                      <span className="font-mono text-[10px] text-green-300 break-all">{ref.meta.cwd}</span>
                    </div>
                  )}
                  {!ref.meta?.cwd && ref.type === "project" && (
                    <div className="text-orange-400/70 text-[10px] mt-1 pt-1 border-t border-border">
                      No local path set — agent cannot read files
                    </div>
                  )}
                </>
              )}
            </div>
          )}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/ui typecheck
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/chat/ChatMessage.tsx
git commit -m "feat(ui): add document context pill display in chat messages"
```

---

## Task 13: Document Library Page

**Files:**
- Create: `ui/src/pages/DocumentLibrary.tsx`
- Modify: router/nav to add the route

- [ ] **Step 1: Create the Document Library page**

```typescript
// ui/src/pages/DocumentLibrary.tsx
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, RefreshCw, Trash2, Upload, Globe, HardDrive } from "lucide-react";
import { referenceDocumentsApi } from "../api/referenceDocuments";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";
import type { ReferenceDocument } from "@paperclipai/shared";

function SourceBadge({ sourceType }: { sourceType: string }) {
  if (sourceType === "gdrive") return <Badge variant="outline" className="text-blue-400 border-blue-800 text-[10px]"><Globe className="h-2.5 w-2.5 mr-1" />Drive</Badge>;
  if (sourceType === "local") return <Badge variant="outline" className="text-green-400 border-green-800 text-[10px]"><HardDrive className="h-2.5 w-2.5 mr-1" />Local</Badge>;
  return <Badge variant="outline" className="text-[10px]">Upload</Badge>;
}

export function DocumentLibraryPage() {
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "company" | "project">("all");

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["reference-docs", selectedCompanyId, scopeFilter],
    queryFn: () => referenceDocumentsApi.list(selectedCompanyId!, scopeFilter !== "all" ? { scope: scopeFilter } : undefined),
    enabled: !!selectedCompanyId,
  });

  const syncMutation = useMutation({
    mutationFn: () => referenceDocumentsApi.triggerSync(selectedCompanyId!),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["reference-docs"] }), 3000),
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: string) => referenceDocumentsApi.delete(selectedCompanyId!, docId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-docs"] }),
  });

  const toggleContextMutation = useMutation({
    mutationFn: ({ docId, value }: { docId: string; value: boolean }) =>
      referenceDocumentsApi.update(selectedCompanyId!, docId, { includeInContext: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-docs"] }),
  });

  const filtered = docs.filter((d) =>
    d.title.toLowerCase().includes(search.toLowerCase()) ||
    (d.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedCompanyId) return;
    referenceDocumentsApi.upload(selectedCompanyId, file, "company")
      .then(() => qc.invalidateQueries({ queryKey: ["reference-docs"] }))
      .catch(() => {});
    e.target.value = "";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Documents</h1>
          <p className="text-sm text-muted-foreground">Reference library for agents</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", syncMutation.isPending && "animate-spin")} />
            Sync now
          </Button>
          <label>
            <Button variant="default" size="sm" asChild>
              <span><Upload className="h-3.5 w-3.5 mr-1.5" />Upload</span>
            </Button>
            <input type="file" accept=".pdf,.md,.txt,.docx" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="Search documents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs h-8 text-sm"
        />
        <div className="flex gap-1">
          {(["all", "company", "project"] as const).map((s) => (
            <Button
              key={s}
              variant={scopeFilter === s ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs capitalize"
              onClick={() => setScopeFilter(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm">No documents yet. Upload a file or configure a sync source in Instance Settings → Storage.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border">
          {filtered.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{doc.title}</span>
                  <SourceBadge sourceType={doc.sourceType} />
                  <Badge variant="outline" className="text-[10px]">{doc.scope}</Badge>
                </div>
                {doc.description && <p className="text-xs text-muted-foreground truncate">{doc.description}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={doc.includeInContext}
                    onChange={(e) => toggleContextMutation.mutate({ docId: doc.id, value: e.target.checked })}
                    className="rounded"
                  />
                  In context
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => deleteMutation.mutate(doc.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add route to router**

Find the router config file (likely `ui/src/lib/router.ts` or routes definition). Add:
```typescript
{ path: "/:companyPrefix/documents", element: <DocumentLibraryPage /> }
```

And add import:
```typescript
import { DocumentLibraryPage } from "../pages/DocumentLibrary";
```

- [ ] **Step 3: Add nav item to Sidebar**

In `ui/src/components/Sidebar.tsx`, add a Documents nav item alongside existing items:
```typescript
{ to: `/${companyPrefix}/documents`, icon: FileText, label: "Documents" }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @paperclipai/ui typecheck
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/DocumentLibrary.tsx
git commit -m "feat(ui): add Document Library page with upload, sync, and context toggle"
```

---

## Task 14: Instance Settings Storage Tab

**Files:**
- Create: `ui/src/pages/InstanceSettings/StorageTab.tsx`
- Modify: existing instance settings page to add Storage tab

- [ ] **Step 1: Create the Storage tab**

```typescript
// ui/src/pages/InstanceSettings/StorageTab.tsx
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, HardDrive, Plus, Trash2, RefreshCw, CheckCircle, XCircle } from "lucide-react";
import { referenceDocumentsApi } from "../../api/referenceDocuments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../../lib/utils";

function GDriveSection() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["gdrive-status"],
    queryFn: () => referenceDocumentsApi.getGDriveStatus(),
  });

  const connect = async () => {
    const { url } = await referenceDocumentsApi.getGDriveAuthUrl();
    const popup = window.open(url, "gdrive-auth", "width=600,height=700");
    const timer = setInterval(() => {
      if (popup?.closed) {
        clearInterval(timer);
        qc.invalidateQueries({ queryKey: ["gdrive-status"] });
      }
    }, 500);
  };

  const disconnect = useMutation({
    mutationFn: () => referenceDocumentsApi.disconnectGDrive(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gdrive-status"] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-blue-400" />
        <h3 className="text-sm font-semibold">Google Drive</h3>
      </div>
      {status?.connected ? (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-400" />
            <span className="text-sm">Connected as <span className="font-medium">{status.email}</span></span>
          </div>
          <Button variant="destructive" size="sm" onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Not connected</span>
          </div>
          <Button variant="outline" size="sm" onClick={connect}>
            Connect Google Drive
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.
      </p>
    </div>
  );
}

function LocalSourcesSection({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [newPath, setNewPath] = useState("");
  const { data: sources = [] } = useQuery({
    queryKey: ["document-sources", companyId],
    queryFn: () => referenceDocumentsApi.listSources(companyId),
  });
  const localSources = sources.filter((s) => s.type === "local");

  const addSource = useMutation({
    mutationFn: () =>
      referenceDocumentsApi.createSource(companyId, { type: "local", name: newPath.split("/").pop() ?? "Local", localPath: newPath }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["document-sources"] }); setNewPath(""); },
  });

  const deleteSource = useMutation({
    mutationFn: (sourceId: string) => referenceDocumentsApi.deleteSource(companyId, sourceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document-sources"] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-green-400" />
        <h3 className="text-sm font-semibold">Local Folders</h3>
      </div>
      <div className="space-y-2">
        {localSources.map((source) => (
          <div key={source.id} className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">{source.name}</p>
              <p className="text-xs text-muted-foreground font-mono">{source.localPath}</p>
              {source.lastSyncError && (
                <p className="text-xs text-red-400 mt-0.5">{source.lastSyncError}</p>
              )}
              {source.lastSyncedAt && !source.lastSyncError && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Last synced {new Date(source.lastSyncedAt).toLocaleString()}
                </p>
              )}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => deleteSource.mutate(source.id)}>
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="/absolute/path/to/folder"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          className="text-sm h-8"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!newPath.trim() || addSource.isPending}
          onClick={() => addSource.mutate()}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>
    </div>
  );
}

export function StorageTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const syncMutation = useMutation({
    mutationFn: () => referenceDocumentsApi.triggerSync(companyId),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["reference-docs"] }), 3000),
  });

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Storage</h2>
          <p className="text-sm text-muted-foreground">Configure document sources for agent reference</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", syncMutation.isPending && "animate-spin")} />
          Sync all
        </Button>
      </div>
      <GDriveSection />
      <div className="border-t border-border pt-6">
        <LocalSourcesSection companyId={companyId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add Storage tab to instance settings page**

Find the existing instance settings page (likely `ui/src/pages/InstanceSettings/` or `ui/src/pages/InstanceSettings.tsx`). Add a "Storage" tab entry and render `<StorageTab companyId={selectedCompanyId} />` when selected. Follow the existing tab pattern in that file.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @paperclipai/ui typecheck
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/InstanceSettings/StorageTab.tsx
git commit -m "feat(ui): add Storage tab to Instance Settings for Drive auth and local folder config"
```

---

## Task 15: Final Integration Verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm -r typecheck
```

Expected: only pre-existing AgentPerformanceTab/Analytics.tsx errors

- [ ] **Step 2: Run tests**

```bash
pnpm test:run
```

Expected: passes

- [ ] **Step 3: Manual smoke test**

1. Start dev server: `pnpm dev`
2. Navigate to Instance Settings → Storage
3. Add a local folder path containing a `.md` or `.pdf` file
4. Click "Sync all" — wait 3s — navigate to `/documents`
5. Verify document appears in the library
6. Open chat, type `*` — verify document appears in dropdown
7. Select document — send message — verify purple pill on message
8. Check LLM tab in LogsPanel — verify `--- DOCUMENTS ---` section in system prompt
9. Verify CEO agent responds referencing the document content

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete document storage and agent reference integration"
```
