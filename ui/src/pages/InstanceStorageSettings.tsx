import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Globe, HardDrive, Pencil, Plus, RefreshCw, Trash2, X, XCircle } from "lucide-react";
import { referenceDocumentsApi } from "../api/referenceDocuments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

function GDriveSection() {
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ["gdrive-status"],
    queryFn: () => referenceDocumentsApi.getGDriveStatus(),
  });

  const connect = async () => {
    try {
      const { url } = await referenceDocumentsApi.getGDriveAuthUrl();
      const popup = window.open(url, "gdrive-auth", "width=600,height=700,noopener");
      if (!popup) { window.location.href = url; return; }
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          qc.invalidateQueries({ queryKey: ["gdrive-status"] });
        }
      }, 500);
    } catch {
      // ignore
    }
  };

  const disconnect = useMutation({
    mutationFn: () => referenceDocumentsApi.disconnectGDrive(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gdrive-status"] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-blue-400" />
        <h3 className="text-sm font-semibold">Google Drive</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Requires <code className="font-mono text-xs bg-muted px-1 rounded">GOOGLE_CLIENT_ID</code> and{" "}
        <code className="font-mono text-xs bg-muted px-1 rounded">GOOGLE_CLIENT_SECRET</code> environment variables.
      </p>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Checking status...</div>
      ) : status?.connected ? (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-400" />
            <span className="text-sm">
              Connected as <span className="font-medium">{status.email}</span>
            </span>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Not connected</span>
          </div>
          <Button variant="outline" size="sm" onClick={connect}>
            Connect Google Drive
          </Button>
        </div>
      )}
    </div>
  );
}

function LocalSourceRow({
  source,
  companyId,
  onDelete,
  onUpdated,
}: {
  source: import("@paperclipai/shared").DocumentSource;
  companyId: string;
  onDelete: () => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editPath, setEditPath] = useState(source.localPath ?? "");
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const updateMutation = useMutation({
    mutationFn: () =>
      referenceDocumentsApi.updateSource(companyId, source.id, {
        localPath: editPath.trim(),
        name: editPath.trim().split("/").filter(Boolean).pop() ?? source.name,
      }),
    onSuccess: () => { onUpdated(); setEditing(false); setTestResult(null); },
  });

  async function runTest(pathToTest: string) {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await referenceDocumentsApi.testLocalPath(pathToTest.trim());
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: "Request failed" });
    } finally {
      setTesting(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-border p-3 space-y-2">
        <div className="flex gap-2">
          <Input
            value={editPath}
            onChange={(e) => { setEditPath(e.target.value); setTestResult(null); }}
            className="text-sm h-8 font-mono"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setEditPath(source.localPath ?? ""); setTestResult(null); }}}
          />
          <Button size="sm" variant="outline" disabled={testing} onClick={() => runTest(editPath)}>
            {testing ? "Testing..." : "Test"}
          </Button>
          <Button size="sm" variant="default" disabled={!editPath.trim() || updateMutation.isPending} onClick={() => updateMutation.mutate()}>
            Save
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => { setEditing(false); setEditPath(source.localPath ?? ""); setTestResult(null); }}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {testResult && (
          <div className={cn(
            "rounded px-2.5 py-1.5 text-xs",
            testResult.ok ? "bg-green-950/50 border border-green-800 text-green-300" : "bg-red-950/50 border border-red-800 text-red-300",
          )}>
            {testResult.ok ? "✓ " : "✗ "}{testResult.message ?? testResult.error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{source.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{source.localPath}</p>
          {source.lastSyncError && <p className="text-xs text-red-400 mt-0.5">{source.lastSyncError}</p>}
          {source.lastSyncedAt && !source.lastSyncError && (
            <p className="text-xs text-muted-foreground mt-0.5">Last synced {new Date(source.lastSyncedAt).toLocaleString()}</p>
          )}
          {testResult && (
            <div className={cn(
              "rounded px-2 py-1 text-xs mt-1.5 inline-block",
              testResult.ok ? "bg-green-950/50 border border-green-800 text-green-300" : "bg-red-950/50 border border-red-800 text-red-300",
            )}>
              {testResult.ok ? "✓ " : "✗ "}{testResult.message ?? testResult.error}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" disabled={testing} onClick={() => runTest(source.localPath ?? "")}>
            {testing ? "..." : "Test"}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => { setEditing(true); setEditPath(source.localPath ?? ""); }}>
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function LocalSourcesSection({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [newPath, setNewPath] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const { data: sources = [] } = useQuery({
    queryKey: ["document-sources", companyId],
    queryFn: () => referenceDocumentsApi.listSources(companyId),
  });

  const localSources = sources.filter((s) => s.type === "local");

  const addSource = useMutation({
    mutationFn: () =>
      referenceDocumentsApi.createSource(companyId, {
        type: "local",
        name: newPath.split("/").filter(Boolean).pop() ?? "Local Folder",
        localPath: newPath.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["document-sources"] });
      setNewPath("");
    },
  });

  const deleteSource = useMutation({
    mutationFn: (sourceId: string) => referenceDocumentsApi.deleteSource(companyId, sourceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document-sources"] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-green-400" />
        <h3 className="text-sm font-semibold">Local Folders</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Add absolute folder paths to sync. Supported: .md, .txt, .pdf, .docx
      </p>

      {localSources.length > 0 && (
        <div className="space-y-2">
          {localSources.map((source) => (
            <LocalSourceRow
              key={source.id}
              source={source}
              companyId={companyId}
              onDelete={() => deleteSource.mutate(source.id)}
              onUpdated={() => qc.invalidateQueries({ queryKey: ["document-sources"] })}
            />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          placeholder="/absolute/path/to/folder"
          value={newPath}
          onChange={(e) => { setNewPath(e.target.value); setTestResult(null); }}
          className="text-sm h-8"
          onKeyDown={(e) => {
            if (e.key === "Enter" && newPath.trim()) addSource.mutate();
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!newPath.trim() || testing}
          onClick={async () => {
            setTesting(true);
            setTestResult(null);
            try {
              const result = await referenceDocumentsApi.testLocalPath(newPath.trim());
              setTestResult(result);
            } catch {
              setTestResult({ ok: false, error: "Request failed" });
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? "Testing..." : "Test"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!newPath.trim() || addSource.isPending}
          onClick={() => addSource.mutate()}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>

      {testResult && (
        <div className={cn(
          "rounded-md px-3 py-2 text-xs",
          testResult.ok
            ? "bg-green-950/50 border border-green-800 text-green-300"
            : "bg-red-950/50 border border-red-800 text-red-300",
        )}>
          {testResult.ok ? "✓ " : "✗ "}{testResult.message ?? testResult.error}
        </div>
      )}
    </div>
  );
}

export function InstanceStorageSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Storage" }]);
  }, [setBreadcrumbs]);

  const syncMutation = useMutation({
    mutationFn: () => referenceDocumentsApi.triggerSync(selectedCompanyId!),
    onSuccess: () =>
      setTimeout(() => qc.invalidateQueries({ queryKey: ["reference-docs"] }), 3000),
  });

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Storage</h1>
          <p className="text-sm text-muted-foreground">
            Configure document sources. Agents get a reference index in their context.
          </p>
        </div>
        {selectedCompanyId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !selectedCompanyId}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5 mr-1.5", syncMutation.isPending && "animate-spin")}
            />
            Sync all
          </Button>
        )}
      </div>

      <GDriveSection />

      <div className="border-t border-border pt-6">
        {selectedCompanyId ? (
          <LocalSourcesSection companyId={selectedCompanyId} />
        ) : (
          <p className="text-sm text-muted-foreground">Select a company to configure local folders.</p>
        )}
      </div>
    </div>
  );
}
