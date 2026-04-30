# Document Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat DocumentLibrary page with a split-panel file explorer — tree left, multi-select file list right, contextual action bar.

**Architecture:** All data comes from the two existing queries (`referenceDocumentsApi.list` + `listSources`). The folder hierarchy is built client-side by parsing `ReferenceDocument.sourcePath` strings. No new API endpoints. Five focused components in a new `DocumentExplorer/` directory replace `DocumentLibrary.tsx`.

**Tech Stack:** React 19, TanStack Query, Tailwind 4, shadcn/ui (`Sheet`, `Select`, `DropdownMenu`), lucide-react, existing API clients (`referenceDocumentsApi`, `projectsApi`), `useToast` from `ToastContext`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `ui/src/pages/DocumentExplorer/tree-utils.ts` | Pure functions: `buildTree`, `getDocsForPath`, `getFolderNodes` |
| Create | `ui/src/pages/DocumentExplorer/ExplorerTree.tsx` | Left panel — renders source roots + folder nodes |
| Create | `ui/src/pages/DocumentExplorer/FileList.tsx` | Right panel — file rows + column header |
| Create | `ui/src/pages/DocumentExplorer/FileActionBar.tsx` | Bottom action bar (shown when ≥1 selected) |
| Create | `ui/src/pages/DocumentExplorer/DocumentPreviewDrawer.tsx` | Slide-over sheet showing extracted text |
| Create | `ui/src/pages/DocumentExplorer/index.tsx` | Root component — owns all state + queries |
| Modify | `ui/src/pages/DocumentLibrary.tsx` | Replace body with `<DocumentExplorer />` re-export |
| Modify | `ui/src/App.tsx` | Update import (path change only) |

---

## Task 1: Tree utility functions (pure, testable)

**Files:**
- Create: `ui/src/pages/DocumentExplorer/tree-utils.ts`
- Test: `ui/src/__tests__/document-explorer-tree-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/__tests__/document-explorer-tree-utils.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildTree,
  getDocsForPath,
  getFolderNodes,
  type TreeNode,
} from "../pages/DocumentExplorer/tree-utils";
import type { ReferenceDocument, DocumentSource } from "@paperclipai/shared";

const makeDoc = (overrides: Partial<ReferenceDocument>): ReferenceDocument => ({
  id: "d1",
  companyId: "c1",
  title: "Test Doc",
  description: null,
  mimeType: "text/plain",
  sourceType: "local",
  sourcePath: "file.md",
  driveFileId: null,
  driveWebUrl: null,
  scope: "company",
  projectId: null,
  includeInContext: false,
  syncedAt: null,
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
  ...overrides,
});

const makeSource = (overrides: Partial<DocumentSource>): DocumentSource => ({
  id: "s1",
  companyId: "c1",
  type: "local",
  name: "My Docs",
  localPath: "/home/docs",
  driveFolderId: null,
  lastSyncedAt: null,
  lastSyncError: null,
  createdAt: "2024-01-01",
  ...overrides,
});

describe("buildTree", () => {
  it("groups docs under their source", () => {
    const sources = [makeSource({ id: "s1" })];
    const docs = [makeDoc({ id: "d1", sourcePath: "file.md", sourceType: "local" })];
    // docs with no sourceId link via sourceType match — see tree-utils for approach
    const tree = buildTree(sources, docs);
    expect(tree.local).toHaveLength(1);
    expect(tree.local[0].sourceId).toBe("s1");
  });

  it("puts upload docs in uploads bucket", () => {
    const tree = buildTree(
      [],
      [makeDoc({ id: "d2", sourceType: "upload", sourcePath: null })],
    );
    expect(tree.uploads).toHaveLength(1);
  });
});

describe("getFolderNodes", () => {
  it("extracts unique top-level folders from docs", () => {
    const docs = [
      makeDoc({ sourcePath: "guides/a.md" }),
      makeDoc({ sourcePath: "guides/b.md" }),
      makeDoc({ sourcePath: "specs/c.md" }),
      makeDoc({ sourcePath: "root.md" }),
    ];
    const folders = getFolderNodes(docs, "");
    expect(folders).toContain("guides");
    expect(folders).toContain("specs");
    expect(folders).not.toContain("root.md");
  });

  it("extracts nested folders relative to a path prefix", () => {
    const docs = [
      makeDoc({ sourcePath: "guides/advanced/deep.md" }),
      makeDoc({ sourcePath: "guides/basic.md" }),
    ];
    const folders = getFolderNodes(docs, "guides");
    expect(folders).toContain("advanced");
    expect(folders).not.toContain("guides");
  });
});

describe("getDocsForPath", () => {
  it("returns docs directly at the given path (not in subfolders)", () => {
    const docs = [
      makeDoc({ id: "d1", sourcePath: "file.md" }),
      makeDoc({ id: "d2", sourcePath: "guides/file.md" }),
      makeDoc({ id: "d3", sourcePath: "guides/sub/deep.md" }),
    ];
    expect(getDocsForPath(docs, "").map((d) => d.id)).toEqual(["d1"]);
    expect(getDocsForPath(docs, "guides").map((d) => d.id)).toEqual(["d2"]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm vitest run ui/src/__tests__/document-explorer-tree-utils.test.ts
```
Expected: `Cannot find module '../pages/DocumentExplorer/tree-utils'`

- [ ] **Step 3: Implement tree-utils.ts**

Create `ui/src/pages/DocumentExplorer/tree-utils.ts`:

```ts
import type { ReferenceDocument, DocumentSource } from "@paperclipai/shared";

export interface SourceTreeNode {
  sourceId: string;
  source: DocumentSource;
  docs: ReferenceDocument[];
}

export interface TreeNode {
  local: SourceTreeNode[];
  gdrive: SourceTreeNode[];
  uploads: ReferenceDocument[];
}

export function buildTree(
  sources: DocumentSource[],
  docs: ReferenceDocument[],
): TreeNode {
  const localSources = sources.filter((s) => s.type === "local");
  const gdriveSources = sources.filter((s) => s.type === "gdrive");

  const assignDocToSource = (
    sourcesOfType: DocumentSource[],
    sourceType: "local" | "gdrive",
  ): SourceTreeNode[] => {
    return sourcesOfType.map((source) => ({
      sourceId: source.id,
      source,
      docs: docs.filter(
        (d) => d.sourceType === sourceType && matchesSource(d, source),
      ),
    }));
  };

  return {
    local: assignDocToSource(localSources, "local"),
    gdrive: assignDocToSource(gdriveSources, "gdrive"),
    uploads: docs.filter((d) => d.sourceType === "upload"),
  };
}

function matchesSource(doc: ReferenceDocument, source: DocumentSource): boolean {
  // Local docs: sourcePath is relative to the source's localPath
  // Drive docs: driveFileId is scoped to the source's driveFolderId
  // Since there is no explicit sourceId on ReferenceDocument, we assign docs
  // to the first matching source of the same type. In practice most installs
  // have one source per type.
  return true; // naive: all local docs → first local source, etc.
  // TODO for multi-source: add sourceId foreign key to ReferenceDocument
}

export function getFolderNodes(
  docs: ReferenceDocument[],
  pathPrefix: string,
): string[] {
  const folders = new Set<string>();
  for (const doc of docs) {
    const p = doc.sourcePath ?? "";
    const relative = pathPrefix ? (p.startsWith(pathPrefix + "/") ? p.slice(pathPrefix.length + 1) : null) : p;
    if (!relative) continue;
    const parts = relative.split("/");
    if (parts.length > 1) {
      folders.add(parts[0]!);
    }
  }
  return Array.from(folders).sort();
}

export function getDocsForPath(
  docs: ReferenceDocument[],
  pathPrefix: string,
): ReferenceDocument[] {
  return docs.filter((doc) => {
    const p = doc.sourcePath ?? "";
    if (pathPrefix === "") {
      return !p.includes("/");
    }
    const prefix = pathPrefix + "/";
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return !rest.includes("/");
  });
}

export function mimeTypeLabel(mimeType: string | null): string {
  if (!mimeType) return "File";
  if (mimeType.includes("pdf")) return "PDF";
  if (mimeType.includes("markdown") || mimeType === "text/x-markdown") return "Markdown";
  if (mimeType.includes("word") || mimeType.includes("docx")) return "Word";
  if (mimeType === "text/plain") return "Text";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "Sheet";
  return "File";
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
pnpm vitest run ui/src/__tests__/document-explorer-tree-utils.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/DocumentExplorer/tree-utils.ts ui/src/__tests__/document-explorer-tree-utils.test.ts
git commit -m "feat(docs): add document explorer tree utility functions"
```

---

## Task 2: ExplorerTree component (left panel)

**Files:**
- Create: `ui/src/pages/DocumentExplorer/ExplorerTree.tsx`

- [ ] **Step 1: Create ExplorerTree.tsx**

```tsx
import { ChevronDown, ChevronRight, Cloud, HardDrive, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { getFolderNodes } from "./tree-utils";
import type { TreeNode, SourceTreeNode } from "./tree-utils";
import type { ReferenceDocument } from "@paperclipai/shared";

interface Selection {
  sourceId: string | null;
  folderPath: string;
}

interface ExplorerTreeProps {
  tree: TreeNode;
  selection: Selection;
  onSelect: (sourceId: string | null, folderPath: string) => void;
  expandedRoots: Set<string>;
  onToggleRoot: (root: string) => void;
}

export function ExplorerTree({
  tree,
  selection,
  onSelect,
  expandedRoots,
  onToggleRoot,
}: ExplorerTreeProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between shrink-0">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Explorer</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {/* My PC */}
        <RootNode
          id="local"
          label="My PC"
          icon={<HardDrive className="h-3.5 w-3.5 text-green-400" />}
          count={tree.local.reduce((n, s) => n + s.docs.length, 0)}
          expanded={expandedRoots.has("local")}
          onToggle={() => onToggleRoot("local")}
        >
          {tree.local.map((node) => (
            <SourceNode
              key={node.sourceId}
              node={node}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </RootNode>

        {/* Google Drive */}
        <RootNode
          id="gdrive"
          label="Google Drive"
          icon={<Cloud className="h-3.5 w-3.5 text-blue-400" />}
          count={tree.gdrive.reduce((n, s) => n + s.docs.length, 0)}
          expanded={expandedRoots.has("gdrive")}
          onToggle={() => onToggleRoot("gdrive")}
        >
          {tree.gdrive.map((node) => (
            <SourceNode
              key={node.sourceId}
              node={node}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </RootNode>

        {/* Uploads */}
        {tree.uploads.length > 0 && (
          <button
            className={cn(
              "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors",
              selection.sourceId === "uploads" && "bg-accent",
            )}
            onClick={() => onSelect("uploads", "")}
          >
            <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="flex-1 text-left font-medium">Uploads</span>
            <span className="text-[10px] text-muted-foreground">{tree.uploads.length}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function RootNode({
  id, label, icon, count, expanded, onToggle, children,
}: {
  id: string; label: string; icon: React.ReactNode; count: number;
  expanded: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div>
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
        {icon}
        <span className="flex-1 text-left font-medium">{label}</span>
        <span className="text-[10px] text-muted-foreground">{count}</span>
      </button>
      {expanded && <div className="ml-2">{children}</div>}
    </div>
  );
}

function SourceNode({
  node, selection, onSelect,
}: {
  node: SourceTreeNode; selection: Selection; onSelect: (sourceId: string | null, folderPath: string) => void;
}) {
  const label = node.source.localPath ?? node.source.name;
  const isSelected = selection.sourceId === node.sourceId && selection.folderPath === "";
  const folders = getFolderNodes(node.docs, "");

  return (
    <div>
      <button
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors",
          isSelected && "bg-accent",
        )}
        onClick={() => onSelect(node.sourceId, "")}
      >
        <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 opacity-0" />
        <span className="flex-1 text-left truncate text-muted-foreground font-mono">{label}</span>
        <span className="text-[10px] text-muted-foreground">{node.docs.length}</span>
      </button>
      {folders.map((folder) => (
        <FolderNode
          key={folder}
          folder={folder}
          sourceId={node.sourceId}
          docs={node.docs}
          selection={selection}
          onSelect={onSelect}
          depth={1}
        />
      ))}
    </div>
  );
}

function FolderNode({
  folder, sourceId, docs, selection, onSelect, depth,
}: {
  folder: string; sourceId: string; docs: ReferenceDocument[];
  selection: Selection; onSelect: (sourceId: string | null, folderPath: string) => void; depth: number;
}) {
  const folderPath = folder;
  const isSelected = selection.sourceId === sourceId && selection.folderPath === folderPath;
  const subFolders = getFolderNodes(docs, folderPath);
  const count = docs.filter((d) => (d.sourcePath ?? "").startsWith(folderPath + "/")).length;

  return (
    <div style={{ paddingLeft: `${depth * 12}px` }}>
      <button
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors",
          isSelected && "bg-accent",
        )}
        onClick={() => onSelect(sourceId, folderPath)}
      >
        <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="flex-1 text-left truncate">📁 {folder}</span>
        <span className="text-[10px] text-muted-foreground">{count}</span>
      </button>
      {subFolders.map((sub) => (
        <FolderNode
          key={sub}
          folder={`${folderPath}/${sub}`}
          sourceId={sourceId}
          docs={docs}
          selection={selection}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "DocumentExplorer"
```
Expected: no errors for DocumentExplorer files.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/DocumentExplorer/ExplorerTree.tsx
git commit -m "feat(docs): add ExplorerTree left panel component"
```

---

## Task 3: FileList component (right panel)

**Files:**
- Create: `ui/src/pages/DocumentExplorer/FileList.tsx`

- [ ] **Step 1: Create FileList.tsx**

```tsx
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { mimeTypeLabel } from "./tree-utils";
import type { ReferenceDocument } from "@paperclipai/shared";

interface FileListProps {
  docs: ReferenceDocument[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  breadcrumb: string;
  search: string;
  onSearchChange: (v: string) => void;
  onPreview: (id: string) => void;
}

export function FileList({
  docs, selectedIds, onToggleSelect, onSelectAll,
  breadcrumb, search, onSearchChange, onPreview,
}: FileListProps) {
  const filtered = docs.filter((d) =>
    d.title.toLowerCase().includes(search.toLowerCase()),
  );
  const allSelected = filtered.length > 0 && filtered.every((d) => selectedIds.has(d.id));

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Breadcrumb + search */}
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground truncate flex-1">{breadcrumb || "Documents"}</span>
        <input
          placeholder="Search..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="bg-muted/30 border border-border rounded px-2 py-1 text-xs w-36 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
        />
      </div>

      {/* Column header */}
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-3 text-[10px] uppercase tracking-widest text-muted-foreground shrink-0">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded"
          checked={allSelected}
          onChange={() =>
            allSelected
              ? onSelectAll([])
              : onSelectAll(filtered.map((d) => d.id))
          }
        />
        <span className="flex-1">Name</span>
        <span className="w-20 hidden sm:block">Type</span>
        <span className="w-24 hidden md:block">Synced</span>
        <span className="w-14">Context</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground gap-2">
            <FileText className="h-6 w-6 opacity-30" />
            <p className="text-xs">{search ? "No matches" : "No files here"}</p>
          </div>
        ) : (
          filtered.map((doc) => (
            <FileRow
              key={doc.id}
              doc={doc}
              selected={selectedIds.has(doc.id)}
              onToggle={() => onToggleSelect(doc.id)}
              onPreview={() => onPreview(doc.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FileRow({
  doc, selected, onToggle, onPreview,
}: {
  doc: ReferenceDocument; selected: boolean;
  onToggle: () => void; onPreview: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 border-b border-border/50 cursor-pointer hover:bg-accent/20 transition-colors text-sm",
        selected && "bg-accent/20",
      )}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 rounded shrink-0"
        checked={selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span
        className="flex-1 truncate font-medium"
        onDoubleClick={(e) => { e.stopPropagation(); onPreview(); }}
        title="Double-click to preview"
      >
        {doc.title}
      </span>
      <span className="w-20 text-xs text-muted-foreground hidden sm:block">
        {mimeTypeLabel(doc.mimeType)}
      </span>
      <span className="w-24 text-xs text-muted-foreground hidden md:block">
        {doc.syncedAt ? new Date(doc.syncedAt).toLocaleDateString() : "—"}
      </span>
      <div className="w-14 flex justify-start" onClick={(e) => e.stopPropagation()}>
        <div
          className={cn(
            "w-7 h-4 rounded-full transition-colors cursor-default",
            doc.includeInContext ? "bg-green-500" : "bg-muted",
          )}
          title={doc.includeInContext ? "In agent context" : "Not in context"}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "DocumentExplorer"
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/DocumentExplorer/FileList.tsx
git commit -m "feat(docs): add FileList right panel component"
```

---

## Task 4: FileActionBar + DocumentPreviewDrawer

**Files:**
- Create: `ui/src/pages/DocumentExplorer/FileActionBar.tsx`
- Create: `ui/src/pages/DocumentExplorer/DocumentPreviewDrawer.tsx`

- [ ] **Step 1: Create FileActionBar.tsx**

```tsx
import { Download, Eye, FolderOpen, ToggleLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@paperclipai/shared";

interface FileActionBarProps {
  selectedCount: number;
  projects: Project[];
  onPreview: () => void;
  onToggleContext: () => void;
  onMoveToProject: (projectId: string) => void;
  onDownload: () => void;
  onDelete: () => void;
}

export function FileActionBar({
  selectedCount, projects, onPreview, onToggleContext,
  onMoveToProject, onDownload, onDelete,
}: FileActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="px-3 py-2 border-t border-border bg-muted/20 flex items-center gap-2 shrink-0 flex-wrap">
      <span className="text-xs text-muted-foreground mr-1">{selectedCount} selected</span>

      <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onPreview} disabled={selectedCount !== 1}>
        <Eye className="h-3.5 w-3.5" />Preview
      </Button>

      <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onToggleContext}>
        <ToggleLeft className="h-3.5 w-3.5" />In context
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
            <FolderOpen className="h-3.5 w-3.5" />Move to project
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>No projects</DropdownMenuItem>
          ) : (
            projects.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onMoveToProject(p.id)}>
                {p.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onDownload}>
        <Download className="h-3.5 w-3.5" />Download
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive ml-auto"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />Delete
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Create DocumentPreviewDrawer.tsx**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { referenceDocumentsApi } from "@/api/referenceDocuments";

interface DocumentPreviewDrawerProps {
  companyId: string;
  docId: string | null;
  onClose: () => void;
}

export function DocumentPreviewDrawer({ companyId, docId, onClose }: DocumentPreviewDrawerProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["doc-preview", companyId, docId],
    queryFn: () => referenceDocumentsApi.getContent(companyId, docId!),
    enabled: !!docId,
  });

  return (
    <Sheet open={!!docId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[520px] max-w-full flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-sm truncate">{data?.title ?? "Preview"}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto mt-4">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : data?.extractedText ? (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
              {data.extractedText}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">No extracted text available.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "DocumentExplorer"
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/DocumentExplorer/FileActionBar.tsx ui/src/pages/DocumentExplorer/DocumentPreviewDrawer.tsx
git commit -m "feat(docs): add FileActionBar and DocumentPreviewDrawer components"
```

---

## Task 5: DocumentExplorer root component

**Files:**
- Create: `ui/src/pages/DocumentExplorer/index.tsx`

- [ ] **Step 1: Create index.tsx**

```tsx
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Upload } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { referenceDocumentsApi } from "@/api/referenceDocuments";
import { projectsApi } from "@/api/projects";
import { buildTree, getDocsForPath } from "./tree-utils";
import { ExplorerTree } from "./ExplorerTree";
import { FileList } from "./FileList";
import { FileActionBar } from "./FileActionBar";
import { DocumentPreviewDrawer } from "./DocumentPreviewDrawer";

export function DocumentExplorer() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(new Set(["local"]));
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Documents" }]);
  }, [setBreadcrumbs]);

  const { data: docs = [] } = useQuery({
    queryKey: ["reference-docs", selectedCompanyId],
    queryFn: () => referenceDocumentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: syncing ? 2000 : false,
  });

  const { data: sources = [] } = useQuery({
    queryKey: ["document-sources", selectedCompanyId],
    queryFn: () => referenceDocumentsApi.listSources(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["projects", selectedCompanyId],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const tree = useMemo(() => buildTree(sources, docs), [sources, docs]);

  const activeSourceNode = useMemo(() => {
    if (!selectedSourceId) return null;
    return (
      tree.local.find((n) => n.sourceId === selectedSourceId) ??
      tree.gdrive.find((n) => n.sourceId === selectedSourceId) ??
      null
    );
  }, [tree, selectedSourceId]);

  const visibleDocs = useMemo(() => {
    if (selectedSourceId === "uploads") return tree.uploads;
    if (!activeSourceNode) return [];
    return getDocsForPath(activeSourceNode.docs, selectedFolderPath);
  }, [activeSourceNode, selectedFolderPath, selectedSourceId, tree.uploads]);

  const breadcrumb = useMemo(() => {
    if (selectedSourceId === "uploads") return "Uploads";
    if (!activeSourceNode) return "";
    const root = activeSourceNode.source.localPath ?? activeSourceNode.source.name;
    return selectedFolderPath ? `${root} / ${selectedFolderPath.replace(/\//g, " / ")}` : root;
  }, [activeSourceNode, selectedFolderPath, selectedSourceId]);

  const syncMutation = useMutation({
    mutationFn: () => referenceDocumentsApi.triggerSync(selectedCompanyId!),
    onSuccess: () => {
      setSyncing(true);
      setTimeout(() => {
        setSyncing(false);
        qc.invalidateQueries({ queryKey: ["reference-docs"] });
        qc.invalidateQueries({ queryKey: ["document-sources"] });
      }, 30_000);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => referenceDocumentsApi.delete(selectedCompanyId!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-docs"] }),
  });

  const toggleContextMutation = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      referenceDocumentsApi.update(selectedCompanyId!, id, { includeInContext: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-docs"] }),
  });

  const moveToProjectMutation = useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string }) =>
      referenceDocumentsApi.update(selectedCompanyId!, id, { scope: "project", projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reference-docs"] });
      pushToast({ title: "Moved to project" });
    },
  });

  function handleSelect(sourceId: string | null, folderPath: string) {
    setSelectedSourceId(sourceId);
    setSelectedFolderPath(folderPath);
    setSelectedDocIds(new Set());
    setSearch("");
  }

  function handleToggleRoot(root: string) {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      next.has(root) ? next.delete(root) : next.add(root);
      return next;
    });
  }

  function handleToggleSelect(id: string) {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleSelectAll(ids: string[]) {
    setSelectedDocIds(new Set(ids));
  }

  function handleToggleContext() {
    const selectedDocs = visibleDocs.filter((d) => selectedDocIds.has(d.id));
    // If any are off, turn all on; if all are on, turn all off
    const anyOff = selectedDocs.some((d) => !d.includeInContext);
    for (const doc of selectedDocs) {
      toggleContextMutation.mutate({ id: doc.id, value: anyOff });
    }
  }

  function handleMoveToProject(projectId: string) {
    for (const id of selectedDocIds) {
      moveToProjectMutation.mutate({ id, projectId });
    }
    setSelectedDocIds(new Set());
  }

  function handleDownload() {
    const selectedDocs = visibleDocs.filter((d) => selectedDocIds.has(d.id));
    const downloadable = selectedDocs.filter((d) => d.driveWebUrl);
    if (downloadable.length === 0) {
      pushToast({ tone: "warn", title: "Not available", body: "Download not available for local/synced files." });
      return;
    }
    for (const doc of downloadable) {
      window.open(doc.driveWebUrl!, "_blank", "noopener");
    }
  }

  function handleDelete() {
    if (!window.confirm(`Delete ${selectedDocIds.size} document(s)?`)) return;
    for (const id of selectedDocIds) {
      deleteMutation.mutate(id);
    }
    setSelectedDocIds(new Set());
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedCompanyId) return;
    referenceDocumentsApi
      .upload(selectedCompanyId, file, "company")
      .then(() => qc.invalidateQueries({ queryKey: ["reference-docs"] }))
      .catch(() => {});
    e.target.value = "";
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div>
          <h1 className="text-base font-semibold">Documents</h1>
          <p className="text-xs text-muted-foreground">Reference library for agents</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending || !selectedCompanyId}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", (syncMutation.isPending || syncing) && "animate-spin")} />
            {syncing ? "Syncing..." : "Sync"}
          </Button>
          <Button variant="default" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />Upload
          </Button>
          <input ref={fileInputRef} type="file" accept=".pdf,.md,.txt,.docx" className="hidden" onChange={handleUpload} />
        </div>
      </div>

      {/* Split panel */}
      <div className="flex flex-1 min-h-0">
        {/* Tree */}
        <div className="w-[220px] shrink-0 border-r border-border">
          <ExplorerTree
            tree={tree}
            selection={{ sourceId: selectedSourceId, folderPath: selectedFolderPath }}
            onSelect={handleSelect}
            expandedRoots={expandedRoots}
            onToggleRoot={handleToggleRoot}
          />
        </div>

        {/* File list + action bar */}
        <div className="flex-1 flex flex-col min-w-0">
          {selectedSourceId ? (
            <>
              <FileList
                docs={visibleDocs}
                selectedIds={selectedDocIds}
                onToggleSelect={handleToggleSelect}
                onSelectAll={handleSelectAll}
                breadcrumb={breadcrumb}
                search={search}
                onSearchChange={setSearch}
                onPreview={setPreviewDocId}
              />
              <FileActionBar
                selectedCount={selectedDocIds.size}
                projects={projects}
                onPreview={() => setPreviewDocId(Array.from(selectedDocIds)[0] ?? null)}
                onToggleContext={handleToggleContext}
                onMoveToProject={handleMoveToProject}
                onDownload={handleDownload}
                onDelete={handleDelete}
              />
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <p className="text-sm">Select a folder in the tree</p>
            </div>
          )}
        </div>
      </div>

      <DocumentPreviewDrawer
        companyId={selectedCompanyId ?? ""}
        docId={previewDocId}
        onClose={() => setPreviewDocId(null)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | grep "DocumentExplorer"
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/DocumentExplorer/index.tsx
git commit -m "feat(docs): add DocumentExplorer root component"
```

---

## Task 6: Wire into app — replace DocumentLibrary

**Files:**
- Modify: `ui/src/pages/DocumentLibrary.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Replace DocumentLibrary.tsx body**

Replace the entire content of `ui/src/pages/DocumentLibrary.tsx` with:

```tsx
export { DocumentExplorer as DocumentLibrary } from "./DocumentExplorer/index";
```

- [ ] **Step 2: Verify App.tsx import still works**

`App.tsx` imports `{ DocumentLibrary } from "./pages/DocumentLibrary"` — this re-export preserves that. No change needed to App.tsx.

- [ ] **Step 3: Typecheck full UI**

```bash
pnpm -w exec tsc --noEmit -p ui/tsconfig.json 2>&1 | head -30
```
Expected: only pre-existing errors (AgentPerformanceTab, Analytics) — none from DocumentExplorer or DocumentLibrary.

- [ ] **Step 4: Start dev server and verify in browser**

```bash
pnpm dev
```

Open `http://localhost:3100` → navigate to Documents page. Verify:
- Left panel shows My PC / Google Drive / Uploads roots
- Clicking a root expands it
- Clicking a folder populates the right panel
- Selecting files shows action bar
- Double-clicking a file opens preview drawer

- [ ] **Step 5: Final commit**

```bash
git add ui/src/pages/DocumentLibrary.tsx
git commit -m "feat(docs): replace DocumentLibrary with split-panel DocumentExplorer"
```
