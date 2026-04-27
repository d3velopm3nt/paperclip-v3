# Document Storage & Agent Reference — Design Spec

**Date:** 2026-04-27
**Status:** Approved

---

## Overview

Integrate local folders and Google Drive as document sources so agents have a reference library. Agents get a lightweight index in their system prompt and can fetch full document content on demand. Documents are scoped to company-wide or project-specific.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Sources                │  Paperclip               │
│  ─────────              │  ─────────               │
│  Local folder(s)  ──→   │  Sync Service            │
│  Google Drive     ──→   │    ↓ extract text        │
│  Manual upload    ──→   │  documents table (DB)    │
│                         │    ↓                     │
│                         │  Document Index API      │
│                         │    ↓           ↓         │
│                         │  System     Fetch        │
│                         │  Prompt     Endpoint     │
│                         │  (index)    (content)    │
└─────────────────────────────────────────────────────┘
```

---

## Data Model

### Extend `documents` table

Add columns to the existing `documents` table:

| Column | Type | Description |
|--------|------|-------------|
| `sourceType` | `"local" \| "gdrive" \| "upload"` | Origin of the document |
| `sourcePath` | text, nullable | Absolute local file path |
| `driveFileId` | text, nullable | Google Drive file ID |
| `driveWebUrl` | text, nullable | Link back to Drive UI |
| `extractedText` | text, nullable | Plain text content, max ~50k chars |
| `mimeType` | text | File MIME type |
| `scope` | `"company" \| "project"` | Access scope |
| `projectId` | uuid, nullable | Set when scope = "project" |
| `syncedAt` | timestamp | Last successful sync |
| `checksum` | text | MD5 of source content, skip re-extract if unchanged |
| `includeInContext` | boolean, default true | Whether to appear in agent index |

### New `document_sources` table

Stores configured sync sources per company:

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `companyId` | uuid | FK companies |
| `type` | `"local" \| "gdrive"` | Source type |
| `localPath` | text, nullable | Root folder to sync |
| `driveFolderId` | text, nullable | Google Drive folder ID |
| `name` | text | Display name for this source |
| `lastSyncedAt` | timestamp | Last sync attempt |
| `lastSyncError` | text, nullable | Last error message if any |
| `createdAt` | timestamp | |

---

## Sync Service

### Trigger
- Scheduled: every 15 minutes per company (uses existing heartbeat/cron infrastructure)
- On-demand: "Sync now" button in UI triggers immediate sync

### Local sync flow
1. `fs.readdir` recursively from configured `localPath`
2. Filter: `.pdf`, `.md`, `.txt`, `.docx` only
3. For each file: compute MD5 checksum, skip if matches stored checksum
4. Extract text by type (see extraction below)
5. Upsert `documents` row: `{ sourcePath, checksum, extractedText, syncedAt }`
6. Delete DB rows whose `sourcePath` no longer exists on disk

### Google Drive sync flow
1. OAuth2 token per Paperclip instance (stored in instance secrets, not per-user)
2. List files in configured Drive folder (recursive)
3. Filter by MIME type: Docs, PDF, plain text, Markdown
4. For each file: check `modifiedTime` against `syncedAt`, skip if unchanged
5. Download and extract text
6. Upsert `documents` row: `{ driveFileId, driveWebUrl, extractedText, syncedAt }`
7. Delete DB rows whose `driveFileId` no longer appears in folder listing

### Text extraction
| Format | Library | Notes |
|--------|---------|-------|
| `.md`, `.txt` | As-is | Direct string read |
| `.pdf` | `pdf-parse` | Extract text content |
| `.docx` | `mammoth` | Convert to plain text |
| Google Doc | Drive API export | Export as `text/plain` |

### Error handling
- Extraction failure: log error to `document_sources.lastSyncError`, skip file, continue sync
- Auth failure (Drive): mark source as errored, surface in UI, do not retry until user re-authenticates
- File too large (>10MB): skip with warning logged

---

## Google Drive Authentication

- OAuth2 flow initiated from Instance Settings → Storage
- One Drive connection per Paperclip instance (not per company/user)
- Refresh token stored in instance secrets (encrypted at rest)
- Auth button → Google OAuth consent → callback stores tokens → UI shows "Connected as user@gmail.com"
- Disconnect button revokes and deletes stored tokens

---

## UI

### A. Instance Settings → Storage (new tab)

- **Google Drive section**: Connect button → OAuth flow; shows connected account + disconnect; status of Drive sync
- **Local folders section**: Add local folder path (text input + browse); list of configured paths with last sync status and file count; remove button per path
- **Sync log**: Last 10 sync events with timestamp, files added/updated/removed, errors

### B. Document Library (`/:companyPrefix/documents`)

- Grid/list of all documents with source badge (local / drive / upload)
- Filter by: scope (company/project), source type, project
- Per-doc actions: rename, retag, change scope, toggle "include in context", delete
- Manual upload: drag-and-drop or file picker, assign scope on upload
- "Sync now" button triggers immediate sync for all configured sources
- Search by title/description

### C. Project detail → Documents tab

- Shows docs scoped to that project
- "Add from library" — pull any company-wide doc into project scope
- "Upload to project" — upload directly scoped to this project

### D. Chat composer `*` trigger

- Type `*` in chat input → dropdown searches document index by title
- Select a doc → adds `{ type: "document", id, label }` contextRef pill (purple)
- Server resolves full `extractedText` and injects it directly into the system prompt
- No separate fetch needed — content included upfront since user explicitly requested it

---

## Agent Integration

### System prompt injection (`buildSystemPrompt`)

Always appended after company/project snapshot:

```
--- DOCUMENTS ---
[doc-001] Brand Guide (company) — Innotrack brand colors, fonts, tone of voice
[doc-002] Homepage Spec (project: Innotrack Website) — v2 redesign requirements  
[doc-003] RFID API Reference (company) — hardware integration endpoints
To read a document's full content, call fetch_document with its ID.
--- END DOCUMENTS ---
```

Only documents with `includeInContext = true` appear. Index entry = `[id] title (scope) — description`.

### Scoping rules

| Context | Documents included in index |
|---------|---------------------------|
| Chat, no project selected | Company-wide docs only |
| Chat, project selected via `/` | Company docs + that project's docs |
| Issue agent execution | Company docs + issue's project docs |

### Fetch mechanism — Chat (lean subprocess)

The claude subprocess runs with `--output-format stream-json`. When the LLM emits a `tool_use` event with `name: "fetch_document"` and `input: { id: "doc-001" }`:

1. Server intercepts the event in the stream-json parse loop (already exists in `chat-direct.ts`)
2. Queries `documents.extractedText` by ID
3. Injects a `tool_result` message back into the subprocess stdin
4. Claude continues with the content

The tool schema is injected via the system prompt description — claude knows the tool exists and its signature from the system prompt text.

### Fetch mechanism — Full agent pipeline (issues)

Add `fetch_document` as a Paperclip MCP tool available to agents during issue execution. Same DB query, same response format. Configured via the existing MCP server infrastructure.

### `*doc` contextRef in chat

When a user explicitly selects a document via `*` trigger:
- `contextRef: { type: "document", id: "doc-001", label: "Brand Guide" }`
- Server fetches `extractedText` in `buildSystemPrompt` alongside other context refs
- Full text injected directly into system prompt (no fetch needed at runtime)
- Pill shows in sent message with document icon, expandable to show title + source

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/companies/:id/documents` | List documents (with filters) |
| `GET` | `/api/companies/:id/documents/:docId` | Get document metadata |
| `GET` | `/api/companies/:id/documents/:docId/content` | Get extracted text content |
| `POST` | `/api/companies/:id/documents` | Manual upload |
| `PATCH` | `/api/companies/:id/documents/:docId` | Update metadata/scope |
| `DELETE` | `/api/companies/:id/documents/:docId` | Delete document |
| `GET` | `/api/companies/:id/document-sources` | List sync sources |
| `POST` | `/api/companies/:id/document-sources` | Add sync source |
| `DELETE` | `/api/companies/:id/document-sources/:sourceId` | Remove sync source |
| `POST` | `/api/companies/:id/document-sources/sync` | Trigger immediate sync |
| `POST` | `/api/instance/storage/gdrive/auth` | Initiate Google Drive OAuth |
| `GET` | `/api/instance/storage/gdrive/callback` | OAuth callback |
| `DELETE` | `/api/instance/storage/gdrive/auth` | Disconnect Drive |

---

## Out of Scope (this phase)

- Vector embeddings / semantic search
- Per-user Drive connections (instance-level only)
- Image/spreadsheet/design file support
- Version history / document revisions (existing `document_revisions` table can be wired up later)
- Full-text search across extracted content
