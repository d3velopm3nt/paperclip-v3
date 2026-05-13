# Storage & Agent File Access Design

**Date:** 2026-05-13  
**Status:** Draft

## Overview

Two related problems:

1. Inbound files (email/WhatsApp/Telegram attachments) need to be filed into a configured storage location (local path or Google Drive) so agents and operators can find them. Currently filing is silently skipped if no root is configured, and WhatsApp/Telegram attachments are not filed at all.

2. Unknown email senders are incorrectly routed as operator messages rather than being classified and handled as potential clients, vendors, or spam.

## Background

The system already has:
- `companies.storageLocalPath` + `companies.storageDriveFolderId` columns
- `client-storage.ts` with `ensureClientFolder`, `ensureProjectFolder`, `fileAttachmentToClientFolder`
- Drive API integration via `gdrive-auth.ts`
- `FolderSelector` UI component with Drive browser + local path input
- `document-sync.ts` for syncing local paths and Drive folders into reference documents
- `blocked_sender_domains` does NOT exist yet — needs new table
- `create_client` MCP tool does NOT exist — needs adding

## Section 1: Storage Root — Soft Gate

**Current behavior:** `client-storage.ts` silently skips folder creation and attachment filing if no storage root is set. No operator notification.

**New behavior:**

- Inbound processors (email, WhatsApp, Telegram) call `hasStorageRoot(db, companyId)` on first message arrival.
- If no root: log warning + fire `notify_operator` Telegram message: *"No storage root configured. Reply to set one up, or configure at Settings → Storage."*
- Attachments skip filing (already the case), but operator is now notified once per day maximum (check `operatorMessages` for a recent storage-warning message before sending).
- UI: `StorageSetupBanner` component shown on company dashboard when `storageLocalPath` and `storageDriveFolderId` are both null. Uses existing `FolderSelector`. Not a hard block — operator can dismiss.

No schema changes needed for this section.

## Section 2: Agent-Controlled Storage Setup via MCP Tools

Operators configure storage and create client folders by messaging the EA agent via Telegram/WhatsApp. The agent calls new MCP tools.

### New MCP tools

| Tool | Backend | Description |
|------|---------|-------------|
| `set_storage_root` | `setCompanyStorageRoot` in `client-storage.ts` | Sets `storageLocalPath` or `storageDriveFolderId` on the company. Accepts `localPath` (string) or `driveFolderId` (string). Returns current root after update. |
| `ensure_client_folder` | `ensureClientFolder` in `client-storage.ts` + new `backfillClientAttachments` | Creates `<root>/Clients/<Name>/_shared/` in Drive or local FS. Immediately backfills all unfiled attachments for that client. |
| `ensure_project_folder` | `ensureProjectFolder` in `client-storage.ts` | Creates project subfolder under client folder. |

### Backfill on folder creation

New function `backfillClientAttachments(db, clientId)` in `client-storage.ts`:
- Queries `emailAttachments` where `filedAt IS NULL` for all emails linked to that client
- Calls `fileAttachmentToClientFolder` for each
- Also handles WhatsApp/Telegram attachments stored in `operatorMessages` linked to that client (new filing path)

### WhatsApp/Telegram attachment filing

Currently only email attachments are filed. Extend `fileAttachmentToClientFolder` (or add sibling function) to handle attachments from WhatsApp/Telegram messages. Filed to `_shared/whatsapp/` and `_shared/telegram/` subfolders respectively.

### Example operator flow

1. Operator: *"Set my storage to /home/user/Google Drive/Paperclip"*
   → EA calls `set_storage_root({ localPath: "/home/user/Google Drive/Paperclip" })`
2. Operator: *"Create a folder for Acme Corp"*
   → EA calls `ensure_client_folder({ clientId: "<uuid>" })`
   → Folder created + all past Acme email attachments filed immediately
3. Future inbound attachments auto-filed on arrival

## Section 3: Unknown Sender Classification

### Current bug

`resolveClientByEmail` in `inbound-router.ts` returns `undefined` for unknown domains. The router then sets `fromType = "operator"` → EA treats the message as an operator command rather than a client inquiry.

### Fix: routing change

Same-domain matching (`resolveClientByEmail`) already works today — no router change needed for known-domain emails. The EA automatically calls `create_contact` for the specific email address without operator confirmation.

For truly unknown domains (no client match at all), change `inbound-router.ts`:
- Set `fromType = "client"`, `clientId = undefined` (not `"operator"`)
- Pass `isNewSender: true` flag to orchestrator context

### Spam domain blocking

**New DB table: `blocked_sender_domains`**

```sql
id          uuid primary key
company_id  uuid not null references companies(id)
domain      text not null
reason      text
created_at  timestamptz not null default now()
unique(company_id, domain)
```

Inbound router checks this table before routing. Match → silent discard, no issue created, no operator notification.

### Classification flow for unknown senders

1. Email arrives from unknown domain
2. Router checks `blocked_sender_domains` → if match: silent discard
3. Router checks existing clients by domain → if match: auto-add contact as `partner`, route to that client (no operator confirmation needed)
4. No match → route as `fromType: "client"`, `clientId: undefined`, `isNewSender: true`
5. EA reads email body, infers likely type, proposes to operator:
   > *"New email from john@newco.com — Subject: 'Partnership inquiry'. What is this?*
   > *A) New client*
   > *B) Vendor/supplier*
   > *C) Partner of [existing client name]*
   > *D) Block domain (spam)*
   > *E) Discard once"*
6. Operator replies → EA calls appropriate tool

### New MCP tools for classification

| Tool | Description |
|------|-------------|
| `create_client(name, emailDomain, extraEmails[])` | Creates client row. Returns `clientId`. |
| `create_contact(name, email, role, clientId?)` | Creates contact. `role`: `partner`, `vendor`, `referral`, `internal`. Links to client if `clientId` provided. |
| `block_sender_domain(domain, reason?)` | Inserts into `blocked_sender_domains`. Future emails from this domain silently discarded. |
| `discard_message(messageId, reason?)` | Sets `discardedAt` timestamp on the `operatorMessages` row. One-off, does not block domain. Requires new `discardedAt timestamptz` column on `operatorMessages` (schema migration). |

### Contact roles

`contacts.role` column already exists (text). Values used: `client`, `partner`, `vendor`, `referral`, `internal`. No schema change needed.

### Classification decision matrix

| Signal | Auto-action | Requires confirmation |
|--------|------------|----------------------|
| Domain matches existing client | Add as `partner` contact, route to client | No |
| Domain in `blocked_sender_domains` | Silent discard | No |
| Everything else | EA proposes A/B/C/D/E options | Yes — operator must reply |

## Section 4: Client Folder Path in Agent Context

Agents need to know WHERE the client folder is to read files natively via their adapter tools (Claude Code Read, Cursor file access, etc.).

### Enriched MCP responses

Add `clientFolderPath` to MCP tool responses where a client with a configured folder is involved:

- `list_issues` response: each issue with a `clientId` includes `clientFolderPath` (local path or `drive:<folderId>`)
- `create_issue` response: include `clientFolderPath` if client has folder configured
- `get_client` response: include `localPath` and `driveFolderId` fields

Agents receive the path in-context and use their native file tools directly — no additional Paperclip tool call required.

For locally-mounted Google Drive (e.g. `/home/user/Google Drive/`), the path is a regular filesystem path and agents read it like any local folder.

## What Is NOT in Scope

- Google Drive API sync of arbitrary Drive folders into reference documents (user has Drive mounted locally; not needed)
- OAuth flow for Drive (already handled by existing `gdrive-auth.ts`)
- Re-filing already-discarded messages
- Retroactive spam detection on historical emails

## Implementation Notes

- `backfillClientAttachments` should be fire-and-forget (async, non-blocking) to keep `ensure_client_folder` MCP response fast
- `blocked_sender_domains` check should be the very first step in `routeInboundMessage` before any other processing
- `create_client` MCP tool must also call `ensureClientFolder` internally so folder is always created alongside client record
- EA agent AGENTS.md / TOOLS.md needs updating to document new tools and the new sender classification flow
