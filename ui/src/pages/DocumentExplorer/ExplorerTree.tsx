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
        <span className="w-3 shrink-0" />
        <span className="flex-1 text-left truncate text-muted-foreground font-mono">{label}</span>
        <span className="text-[10px] text-muted-foreground">{node.docs.length}</span>
      </button>
      {folders.map((folder) => (
        <FolderNode
          key={folder}
          folderPath={folder}
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
  folderPath, sourceId, docs, selection, onSelect, depth,
}: {
  folderPath: string;
  sourceId: string;
  docs: ReferenceDocument[];
  selection: Selection;
  onSelect: (sourceId: string | null, folderPath: string) => void;
  depth: number;
}) {
  const isSelected = selection.sourceId === sourceId && selection.folderPath === folderPath;
  const subFolders = getFolderNodes(docs, folderPath);
  const label = folderPath.split("/").at(-1) ?? folderPath;
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
        <span className="flex-1 text-left truncate">📁 {label}</span>
        <span className="text-[10px] text-muted-foreground">{count}</span>
      </button>
      {subFolders.map((sub) => (
        <FolderNode
          key={sub}
          folderPath={`${folderPath}/${sub}`}
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
