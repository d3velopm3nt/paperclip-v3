import { useState } from "react";
import { ChevronDown, ChevronRight, Cloud, Folder, FolderOpen, HardDrive, Paperclip } from "lucide-react";
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
      <div className="px-3 py-2 border-b border-border flex items-center shrink-0">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Explorer</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
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
  label, icon, count, expanded, onToggle, children,
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
  node: SourceTreeNode;
  selection: Selection;
  onSelect: (sourceId: string | null, folderPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = node.source.localPath ?? node.source.name;
  const isSelected = selection.sourceId === node.sourceId && selection.folderPath === "";
  const localPath = node.source.localPath;
  const folders = getFolderNodes(node.docs, "", localPath);
  const hasFolders = folders.length > 0;

  return (
    <div>
      <div
        className={cn(
          "flex items-center text-xs hover:bg-accent/50 transition-colors cursor-pointer",
          isSelected && "bg-accent",
        )}
      >
        <button
          className="flex items-center justify-center w-5 h-full pl-3 shrink-0 text-muted-foreground"
          onClick={(e) => { e.stopPropagation(); if (hasFolders) setExpanded((v) => !v); }}
        >
          {hasFolders
            ? expanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />
            : <span className="w-3" />}
        </button>
        <button
          className="flex items-center gap-2 flex-1 min-w-0 pr-3 py-1.5"
          onClick={() => { onSelect(node.sourceId, ""); if (hasFolders && !expanded) setExpanded(true); }}
        >
          {expanded
            ? <FolderOpen className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            : <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
          <span className="flex-1 text-left truncate font-mono text-muted-foreground">{label}</span>
          <span className="text-[10px] text-muted-foreground">{node.docs.length}</span>
        </button>
      </div>
      {expanded && folders.map((folder) => (
        <FolderNode
          key={folder}
          folderPath={folder}
          sourceId={node.sourceId}
          localPath={localPath}
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
  folderPath, sourceId, localPath, docs, selection, onSelect, depth,
}: {
  folderPath: string;
  sourceId: string;
  localPath: string | null | undefined;
  docs: ReferenceDocument[];
  selection: Selection;
  onSelect: (sourceId: string | null, folderPath: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSelected = selection.sourceId === sourceId && selection.folderPath === folderPath;
  const subFolders = getFolderNodes(docs, folderPath, localPath);
  const hasSubs = subFolders.length > 0;
  const label = folderPath.split("/").at(-1) ?? folderPath;
  const count = docs.filter((d) => {
    const prefix = localPath ? (localPath.endsWith("/") ? localPath : localPath + "/") : "";
    const rel = prefix ? (d.sourcePath ?? "").slice(prefix.length) : (d.sourcePath ?? "");
    return rel.startsWith(folderPath + "/");
  }).length;

  return (
    <div style={{ paddingLeft: `${depth * 12}px` }}>
      <div
        className={cn(
          "flex items-center text-xs hover:bg-accent/50 transition-colors cursor-pointer",
          isSelected && "bg-accent",
        )}
      >
        {/* Chevron — toggle only */}
        <button
          className="flex items-center justify-center w-5 h-full pl-3 shrink-0 text-muted-foreground"
          onClick={(e) => { e.stopPropagation(); if (hasSubs) setExpanded((v) => !v); }}
        >
          {hasSubs
            ? expanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />
            : <span className="w-3" />}
        </button>
        {/* Folder row — select + expand */}
        <button
          className="flex items-center gap-2 flex-1 min-w-0 pr-3 py-1.5"
          onClick={() => { onSelect(sourceId, folderPath); if (hasSubs && !expanded) setExpanded(true); }}
        >
          {expanded
            ? <FolderOpen className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            : <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
          <span className="flex-1 text-left truncate">{label}</span>
          <span className="text-[10px] text-muted-foreground">{count}</span>
        </button>
      </div>
      {expanded && subFolders.map((sub) => (
        <FolderNode
          key={sub}
          folderPath={`${folderPath}/${sub}`}
          sourceId={sourceId}
          localPath={localPath}
          docs={docs}
          selection={selection}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
