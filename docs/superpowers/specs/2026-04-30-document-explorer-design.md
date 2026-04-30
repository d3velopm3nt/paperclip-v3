---
title: Document Explorer — Tree View Redesign
date: 2026-04-30
status: approved
---

# Document Explorer — Tree View Redesign

## Goal

Replace the flat document list on the Documents page with a split-panel file explorer. Root nodes are storage connections. Folders expand to show subfolders and files. Files are multi-selectable with a contextual action bar.

## Layout

**Split panel — tree left (220px fixed), file list right (flex).**

### Left panel — Explorer tree

Root nodes, always visible:
- **💻 My PC** — expands to show each configured local `DocumentSource` as a subfolder node, labelled by `localPath`
- **☁️ Google Drive** — expands to show each configured gdrive `DocumentSource` by name
- **📎 Uploads** — groups manually uploaded documents (no source)

Each root shows total file count. Clicking a root collapses/expands it.

Within a source, subfolders are derived from `ReferenceDocument.sourcePath` strings (e.g. `guides/getting-started.md` → folder `guides`). Built client-side by parsing paths. Folder nodes show child count. Clicking a folder selects it and loads its files into the right panel.

### Right panel — File list

Header: breadcrumb (e.g. `My PC / /home/docs / guides`) + search input.

Column header: checkbox (select all), Name, Type, Synced, Context toggle.

Each file row: checkbox, file icon, name, MIME type label, sync timestamp, in-context toggle (green pill when on). Clicking a row selects it (checkbox toggles). Rows highlight on selection (`bg-accent/20`).

### Action bar (bottom of right panel)

Hidden when no files selected. Appears when ≥1 file selected:

| Action | Behaviour |
|---|---|
| `N selected` | count label |
| Preview | opens document content in a slide-over drawer (extracted text) |
| In context | toggles `includeInContext` on all selected docs |
| Move to project | dropdown of company projects → sets `scope=project` + `projectId` |
| Download | triggers browser download of original file (if available) |
| Delete | deletes selected docs after confirm |

## Data flow

No new API endpoints needed for the tree. Data already fetched:
- `referenceDocumentsApi.list()` → all `ReferenceDocument[]` for the company
- `referenceDocumentsApi.listSources()` → all `DocumentSource[]`

Tree built client-side:

```
buildTree(sources, docs):
  for each source → root node
  for each doc belonging to source:
    split sourcePath by "/" → walk/create folder nodes
    attach doc as leaf
  Uploads root ← docs where sourceType === "upload"
```

Selected folder path stored in component state. Right panel filters docs to match that path prefix.

## Components

- `DocumentExplorer` — page root, owns fetched data + selection state
- `ExplorerTree` — left panel, renders root/folder nodes recursively
- `FileList` — right panel, renders file rows + action bar
- `FileActionBar` — shown when selection non-empty, all bulk actions
- `DocumentPreviewDrawer` — slide-over showing `extractedText` for a single doc

`DocumentLibrary.tsx` is replaced by `DocumentExplorer`. Keep the existing API client and mutations unchanged.

## Actions implementation

- **In context**: existing `toggleContextMutation` — call once per selected doc
- **Delete**: existing `deleteMutation` — call once per selected doc, confirm dialog first
- **Move to project**: new mutation calling `referenceDocumentsApi.update(id, { scope: "project", projectId })`; needs project list query (`projectsApi.list(companyId)`)
- **Preview**: open `DocumentPreviewDrawer` — calls `referenceDocumentsApi.getContent(companyId, docId)` on open
- **Download**: `window.open` or `<a download>` — only viable for uploaded files; Drive/local files show a "not available" toast

## State

```ts
selectedSourceId: string | null      // which source root is expanded
selectedFolderPath: string           // path within source, "" = root
selectedDocIds: Set<string>          // multi-select
previewDocId: string | null          // preview drawer
```

## Out of scope (future)

- Project folder nodes in the tree (discussed — separate spec)
- Drag-and-drop to move files
- Rename documents
