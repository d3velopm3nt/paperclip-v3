import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { repoApi, type CommitEntry, type TreeNode } from "@/api/repo";
import { Terminal } from "@/components/Terminal";
import { cn } from "@/lib/utils";

interface RepoTabProps {
  projectId: string;
  isBoard: boolean;
}

type SubView = "commits" | "files" | "terminal";

// ─── File tree node ────────────────────────────────────────────────────────

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

function FileTreeNode({ node, depth, selectedFile, onSelectFile }: FileTreeNodeProps) {
  const [open, setOpen] = useState(true);
  const indent = depth * 12;

  if (node.type === "file") {
    return (
      <button
        className={cn(
          "w-full text-left text-xs px-2 py-0.5 truncate rounded hover:bg-accent/50",
          selectedFile === node.path && "bg-accent"
        )}
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => onSelectFile(node.path)}
      >
        {node.name}
      </button>
    );
  }

  // dir
  return (
    <div>
      <button
        className="w-full text-left text-xs px-2 py-0.5 rounded hover:bg-accent/50 flex items-center gap-1"
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="shrink-0">{open ? "▾" : "▸"}</span>
        <span className="truncate">{node.name}</span>
      </button>
      {open &&
        node.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
          />
        ))}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function RepoTab({ projectId, isBoard }: RepoTabProps) {
  const [subView, setSubView] = useState<SubView>("commits");
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Commits query
  const {
    data: commits,
    isLoading: commitsLoading,
    error: commitsError,
  } = useQuery({
    queryKey: ["repo", projectId, "log"],
    queryFn: () => repoApi.log(projectId),
    enabled: subView === "commits",
  });

  // Diff query
  const { data: diffData, isLoading: diffLoading } = useQuery({
    queryKey: ["repo", projectId, "show", selectedSha],
    queryFn: () => repoApi.show(projectId, selectedSha!),
    enabled: subView === "commits" && selectedSha !== null,
  });

  // Tree query
  const { data: tree, isLoading: treeLoading, error: treeError } = useQuery({
    queryKey: ["repo", projectId, "tree"],
    queryFn: () => repoApi.tree(projectId),
    enabled: subView === "files",
  });

  // File content query
  const { data: fileData, isLoading: fileLoading, error: fileError } = useQuery({
    queryKey: ["repo", projectId, "file", selectedFile],
    queryFn: () => repoApi.file(projectId, selectedFile!),
    enabled: subView === "files" && selectedFile !== null,
  });

  // ── Sub-view switcher ──────────────────────────────────────────────────

  const switcherButtons: { key: SubView; label: string }[] = [
    { key: "commits", label: "Commits" },
    { key: "files", label: "Files" },
    ...(isBoard ? [{ key: "terminal" as SubView, label: "Terminal" }] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Sub-view switcher */}
      <div className="flex gap-1">
        {switcherButtons.map(({ key, label }) => (
          <button
            key={key}
            className={cn(
              "px-3 py-1.5 text-sm font-medium transition-colors",
              subView === key
                ? "bg-primary text-primary-foreground rounded-md"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md"
            )}
            onClick={() => setSubView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Commits view */}
      {subView === "commits" && (
        <div className="h-[600px] border border-border rounded-md overflow-hidden flex gap-0">
          {/* Left panel — commit list */}
          <div className="w-80 shrink-0 border-r border-border overflow-y-auto">
            {commitsError && (
              <p className="p-3 text-xs text-destructive">
                Failed to load git log. Is a local workspace configured?
              </p>
            )}
            {commitsLoading && (
              <p className="p-3 text-xs text-muted-foreground">Loading…</p>
            )}
            {commits?.map((commit: CommitEntry) => (
              <button
                key={commit.sha}
                className={cn(
                  "w-full text-left px-3 py-2 border-b border-border hover:bg-accent/50 transition-colors",
                  selectedSha === commit.sha && "bg-accent"
                )}
                onClick={() => setSelectedSha(commit.sha)}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs shrink-0">{commit.shortSha}</span>
                  <span className="text-xs truncate">{commit.message}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {commit.author} · {new Date(commit.date).toLocaleString()}
                </div>
              </button>
            ))}
          </div>

          {/* Right panel — diff viewer */}
          <div className="flex-1 overflow-y-auto p-3">
            {selectedSha === null ? (
              <p className="text-sm text-muted-foreground">Select a commit to view its diff.</p>
            ) : diffLoading ? (
              <p className="text-xs text-muted-foreground">Loading diff…</p>
            ) : diffData ? (
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">{diffData.diff}</pre>
            ) : null}
          </div>
        </div>
      )}

      {/* Files view */}
      {subView === "files" && (
        <div className="h-[600px] border border-border rounded-md overflow-hidden flex gap-0">
          {/* Left panel — file tree */}
          <div className="w-56 shrink-0 border-r border-border overflow-y-auto py-1">
            {treeError && (
              <p className="px-3 py-2 text-xs text-destructive">Failed to load file tree.</p>
            )}
            {treeLoading && (
              <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
            )}
            {tree?.map((node: TreeNode) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
              />
            ))}
          </div>

          {/* Right panel — file content */}
          <div className="flex-1 overflow-y-auto p-3">
            {fileError ? (
              <p className="text-xs text-destructive">Failed to load file.</p>
            ) : selectedFile === null ? (
              <p className="text-sm text-muted-foreground">Select a file to view its content.</p>
            ) : fileLoading ? (
              <p className="text-xs text-muted-foreground">Loading file…</p>
            ) : fileData ? (
              <pre className="text-xs font-mono whitespace-pre leading-relaxed">{fileData.content}</pre>
            ) : null}
          </div>
        </div>
      )}

      {/* Terminal view (board only) */}
      {subView === "terminal" && isBoard && (
        <div>
          <p className="text-sm text-muted-foreground mb-3">
            Run shell commands directly in the project workspace. Commands execute in the project's local directory.
          </p>
          <Terminal projectId={projectId} className="h-[500px]" />
        </div>
      )}
    </div>
  );
}
