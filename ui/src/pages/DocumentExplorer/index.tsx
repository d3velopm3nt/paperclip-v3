import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Upload } from "lucide-react";
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
    if (!selectedSourceId || selectedSourceId === "uploads") return null;
    return (
      tree.local.find((n) => n.sourceId === selectedSourceId) ??
      tree.gdrive.find((n) => n.sourceId === selectedSourceId) ??
      null
    );
  }, [tree, selectedSourceId]);

  const visibleDocs = useMemo(() => {
    if (selectedSourceId === "uploads") return tree.uploads;
    if (!activeSourceNode) return [];
    return getDocsForPath(
      activeSourceNode.docs,
      selectedFolderPath,
      activeSourceNode.source.localPath,
    );
  }, [activeSourceNode, selectedFolderPath, selectedSourceId, tree.uploads]);

  const breadcrumb = useMemo(() => {
    if (selectedSourceId === "uploads") return "Uploads";
    if (!activeSourceNode) return "";
    const root = activeSourceNode.source.localPath ?? activeSourceNode.source.name;
    return selectedFolderPath
      ? `${root} / ${selectedFolderPath.replace(/\//g, " / ")}`
      : root;
  }, [activeSourceNode, selectedFolderPath, selectedSourceId]);

  const syncMutation = useMutation({
    mutationFn: () => referenceDocumentsApi.triggerSync(selectedCompanyId!),
    onSuccess: () => {
      setSyncing(true);
      setTimeout(() => {
        setSyncing(false);
        void qc.invalidateQueries({ queryKey: ["reference-docs"] });
        void qc.invalidateQueries({ queryKey: ["document-sources"] });
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
      void qc.invalidateQueries({ queryKey: ["reference-docs"] });
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !selectedCompanyId}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", (syncMutation.isPending || syncing) && "animate-spin")} />
            {syncing ? "Syncing..." : "Sync"}
          </Button>
          <Button variant="default" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />Upload
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

      {/* Split panel */}
      <div className="flex flex-1 min-h-0">
        {/* Tree — fixed 220px */}
        <div className="w-[220px] shrink-0 border-r border-border overflow-hidden">
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
