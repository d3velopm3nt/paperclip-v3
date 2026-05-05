// Reusable folder selector — choose from existing document sources,
// browse Google Drive, or enter a local path.
// Used for filing email attachments, setting storage roots, etc.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cloud, HardDrive, ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { referenceDocumentsApi } from "../api/referenceDocuments";
import type { DocumentSource } from "@paperclipai/shared";

export type FolderSelection =
  | { type: "source"; source: DocumentSource }
  | { type: "drive"; folderId: string; folderName: string }
  | { type: "local"; path: string };

interface FolderSelectorProps {
  companyId: string;
  onSelect: (selection: FolderSelection) => void;
  /** If set, only show sources linked to this client */
  clientId?: string;
}

type Tab = "sources" | "drive" | "local";

export function FolderSelector({ companyId, onSelect, clientId }: FolderSelectorProps) {
  const [tab, setTab] = useState<Tab>("sources");
  const [localPath, setLocalPath] = useState("");

  const { data: sources = [] } = useQuery({
    queryKey: ["document-sources", companyId],
    queryFn: () => referenceDocumentsApi.listSources(companyId),
  });

  const filteredSources = clientId
    ? sources.filter((s) => s.clientId === clientId || !s.clientId)
    : sources;

  return (
    <div className="space-y-3">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border pb-2">
        {(["sources", "drive", "local"] as const).map((t) => (
          <button
            key={t}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors",
              tab === t ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(t)}
          >
            {t === "sources" && <FolderOpen className="h-3.5 w-3.5" />}
            {t === "drive" && <Cloud className="h-3.5 w-3.5" />}
            {t === "local" && <HardDrive className="h-3.5 w-3.5" />}
            {t === "sources" ? "My Folders" : t === "drive" ? "Google Drive" : "Local Path"}
          </button>
        ))}
      </div>

      {/* Existing sources */}
      {tab === "sources" && (
        <div className="space-y-1.5">
          {filteredSources.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No folders configured yet.{" "}
              <button className="text-primary hover:underline" onClick={() => setTab("drive")}>Browse Drive</button>
              {" "}or{" "}
              <button className="text-primary hover:underline" onClick={() => setTab("local")}>enter a local path</button>.
            </p>
          ) : (
            filteredSources.map((s) => (
              <SourceRow key={s.id} source={s} onSelect={() => onSelect({ type: "source", source: s })} />
            ))
          )}
        </div>
      )}

      {/* Drive browser */}
      {tab === "drive" && (
        <DriveBrowser onSelect={(folderId, folderName) => onSelect({ type: "drive", folderId, folderName })} />
      )}

      {/* Local path */}
      {tab === "local" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Enter absolute folder path. Will be created if it doesn't exist.</p>
          <div className="flex gap-2">
            <Input
              placeholder="/home/user/documents/folder"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              className="text-xs h-8 font-mono"
              onKeyDown={(e) => { if (e.key === "Enter" && localPath.trim()) onSelect({ type: "local", path: localPath.trim() }); }}
            />
            <Button
              size="sm"
              disabled={!localPath.trim()}
              onClick={() => onSelect({ type: "local", path: localPath.trim() })}
            >
              Select
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceRow({ source, onSelect }: { source: DocumentSource; onSelect: () => void }) {
  const icon = source.type === "gdrive"
    ? <Cloud className="h-3.5 w-3.5 text-blue-400 shrink-0" />
    : <HardDrive className="h-3.5 w-3.5 text-green-400 shrink-0" />;

  const label = source.name;
  const sub = source.localPath ?? source.driveFolderId ?? "";
  const syncedAt = source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleDateString() : null;

  return (
    <button
      className="w-full flex items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-accent/50 transition-colors text-left"
      onClick={onSelect}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{label}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">{sub}</p>
      </div>
      {syncedAt && <span className="text-[11px] text-muted-foreground shrink-0">{syncedAt}</span>}
    </button>
  );
}

function DriveBrowser({ onSelect }: { onSelect: (folderId: string, name: string) => void }) {
  const [parentId, setParentId] = useState<string>("root");
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["drive-folders", parentId],
    queryFn: () => referenceDocumentsApi.listDriveFolders(parentId === "root" ? undefined : parentId),
  });

  function drillInto(folder: { id: string; name: string }) {
    setBreadcrumb((prev) => [...prev, { id: parentId, name: parentId === "root" ? "My Drive" : prev.at(-1)?.name ?? "…" }]);
    setParentId(folder.id);
  }

  function goBack(index: number) {
    const crumb = breadcrumb[index]!;
    setBreadcrumb((prev) => prev.slice(0, index));
    setParentId(crumb.id);
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border text-xs text-muted-foreground flex-wrap">
        <button className="hover:text-foreground" onClick={() => { setBreadcrumb([]); setParentId("root"); }}>
          My Drive
        </button>
        {breadcrumb.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <span>/</span>
            <button className="hover:text-foreground" onClick={() => goBack(i + 1)}>{crumb.name}</button>
          </span>
        ))}
      </div>
      {/* Folder list */}
      <div className="max-h-52 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">Loading...</div>
        ) : (data?.folders.length ?? 0) === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">No subfolders here</div>
        ) : (
          data!.folders.map((folder) => (
            <div key={folder.id} className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 group">
              <Cloud className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span className="flex-1 text-xs cursor-pointer" onClick={() => drillInto(folder)}>
                {folder.name}
              </span>
              <button
                className="text-[10px] text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0 px-2 py-0.5 rounded border border-border hover:bg-accent"
                onClick={() => onSelect(folder.id, folder.name)}
              >
                Select
              </button>
              <button
                className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={() => drillInto(folder)}
                title="Open folder"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
      {/* Select current folder */}
      <div className="border-t border-border px-3 py-2 flex justify-end">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => {
            const name = breadcrumb.at(-1)?.name ?? "My Drive";
            onSelect(parentId === "root" ? "root" : parentId, name);
          }}
        >
          <ChevronDown className="h-3.5 w-3.5 mr-1" />
          Use this folder
        </Button>
      </div>
    </div>
  );
}
