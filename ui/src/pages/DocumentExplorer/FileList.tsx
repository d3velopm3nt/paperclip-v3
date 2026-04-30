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
    <div className="flex flex-col flex-1 min-h-0">
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
            allSelected ? onSelectAll([]) : onSelectAll(filtered.map((d) => d.id))
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
            {!search && docs.length === 0 && (
              <p className="text-[11px] text-muted-foreground/60">Run Sync to pull files from this source</p>
            )}
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
  doc: ReferenceDocument;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
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
            "w-7 h-4 rounded-full transition-colors",
            doc.includeInContext ? "bg-green-500" : "bg-muted",
          )}
          title={doc.includeInContext ? "In agent context" : "Not in context"}
        />
      </div>
    </div>
  );
}
