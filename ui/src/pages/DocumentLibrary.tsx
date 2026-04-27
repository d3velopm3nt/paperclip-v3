import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Globe, HardDrive, RefreshCw, Trash2, Upload } from "lucide-react";
import { referenceDocumentsApi } from "../api/referenceDocuments";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";
import type { ReferenceDocument } from "@paperclipai/shared";

function SourceBadge({ sourceType }: { sourceType: string }) {
  if (sourceType === "gdrive") {
    return (
      <Badge variant="outline" className="text-blue-400 border-blue-800 text-[10px] gap-1">
        <Globe className="h-2.5 w-2.5" />Drive
      </Badge>
    );
  }
  if (sourceType === "local") {
    return (
      <Badge variant="outline" className="text-green-400 border-green-800 text-[10px] gap-1">
        <HardDrive className="h-2.5 w-2.5" />Local
      </Badge>
    );
  }
  return <Badge variant="outline" className="text-[10px]">Upload</Badge>;
}

export function DocumentLibrary() {
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "company" | "project">("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["reference-docs", selectedCompanyId, scopeFilter],
    queryFn: () =>
      referenceDocumentsApi.list(
        selectedCompanyId!,
        scopeFilter !== "all" ? { scope: scopeFilter } : undefined,
      ),
    enabled: !!selectedCompanyId,
  });

  const syncMutation = useMutation({
    mutationFn: () => referenceDocumentsApi.triggerSync(selectedCompanyId!),
    onSuccess: () =>
      setTimeout(() => qc.invalidateQueries({ queryKey: ["reference-docs"] }), 3000),
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

  const filtered = docs.filter(
    (d: ReferenceDocument) =>
      d.title.toLowerCase().includes(search.toLowerCase()) ||
      (d.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Documents</h1>
          <p className="text-sm text-muted-foreground">Reference library for agents — use *doc in chat to attach</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !selectedCompanyId}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", syncMutation.isPending && "animate-spin")} />
            Sync now
          </Button>
          <Button variant="default" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.md,.txt,.docx"
            className="hidden"
            onChange={handleUpload}
          />
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
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm text-center max-w-sm">
            No documents yet. Upload a file or configure a sync source in{" "}
            <strong>Instance Settings → Storage</strong>.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border">
          {filtered.map((doc: ReferenceDocument) => (
            <div
              key={doc.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
            >
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{doc.title}</span>
                  <SourceBadge sourceType={doc.sourceType} />
                  <Badge variant="outline" className="text-[10px]">{doc.scope}</Badge>
                </div>
                {doc.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{doc.description}</p>
                )}
                {doc.syncedAt && (
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                    Synced {new Date(doc.syncedAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={doc.includeInContext}
                    onChange={(e) =>
                      toggleContextMutation.mutate({ docId: doc.id, value: e.target.checked })
                    }
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
