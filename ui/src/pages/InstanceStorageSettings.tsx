import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Cloud, Globe, HardDrive, KeyRound, Pencil, Plus, RefreshCw, Shield, Trash2, X, XCircle } from "lucide-react";
import { referenceDocumentsApi } from "../api/referenceDocuments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

function CompanyStorageRootSection({ companyId }: { companyId: string | null }) {
  const qc = useQueryClient();
  const [localPath, setLocalPath] = useState("");
  const [editing, setEditing] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);

  const { data: root } = useQuery({
    queryKey: ["company-storage-root", companyId],
    queryFn: () => referenceDocumentsApi.getCompanyStorageRoot(companyId!),
    enabled: !!companyId,
  });

  const { data: otherCompanies = [] } = useQuery({
    queryKey: ["companies-with-storage"],
    queryFn: () => referenceDocumentsApi.listCompaniesWithStorage(),
    enabled: !!companyId,
  });

  const otherConfigured = otherCompanies.filter((c) => c.id !== companyId);

  const save = useMutation({
    mutationFn: (opts: { localPath?: string | null; driveFolderId?: string | null }) =>
      referenceDocumentsApi.setCompanyStorageRoot(companyId!, {
        localPath: opts.localPath ?? null,
        driveFolderId: opts.driveFolderId ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-storage-root", companyId] });
      qc.invalidateQueries({ queryKey: ["companies-with-storage"] });
      setEditing(false);
      setShowDrivePicker(false);
    },
  });

  const copyFrom = useMutation({
    mutationFn: (fromCompanyId: string) =>
      referenceDocumentsApi.setCompanyStorageRoot(companyId!, { localPath: null, driveFolderId: null, copyFromCompanyId: fromCompanyId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-storage-root", companyId] });
    },
  });

  if (!companyId) return null;

  const configured = !!(root?.localPath || root?.driveFolderId);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold">Company Storage Root</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Base folder for this company's client and project documents. Client folders auto-created as{" "}
        <span className="font-mono text-xs">root/Clients/ClientName/</span>.
        Set a local path OR a Google Drive folder ID.
      </p>

      {/* Copy from another company */}
      {otherConfigured.length > 0 && !configured && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0">Copy from:</span>
          {otherConfigured.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              disabled={copyFrom.isPending}
              onClick={() => copyFrom.mutate(c.id)}
            >
              {c.name}
            </Button>
          ))}
        </div>
      )}

      {configured && !editing ? (
        <div className="rounded-lg border border-border p-3 space-y-1.5">
          {root?.localPath && (
            <p className="text-xs font-mono text-muted-foreground">📁 {root.localPath}</p>
          )}
          {root?.driveFolderId && (
            <p className="text-xs font-mono text-muted-foreground">
              ☁️ Drive folder: {root.driveFolderId}
            </p>
          )}
          <div className="flex gap-2 mt-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => {
              setLocalPath(root?.localPath ?? "");
              setShowDrivePicker(false);
              setEditing(true);
            }}>Edit</Button>
            {otherConfigured.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">or copy from:</span>
                {otherConfigured.map((c) => (
                  <Button key={c.id} size="sm" variant="ghost" className="h-6 text-xs"
                    disabled={copyFrom.isPending} onClick={() => copyFrom.mutate(c.id)}>
                    {c.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Local path option */}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium">Local folder</p>
            <div className="flex gap-2">
              <Input
                placeholder="/home/user/company-docs"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                className="text-xs h-8 font-mono"
              />
              <Button
                size="sm"
                disabled={!localPath.trim() || save.isPending}
                onClick={() => save.mutate({ localPath: localPath.trim() })}
              >
                {save.isPending ? "Saving..." : "Set"}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-border" />
            <span className="text-[10px] text-muted-foreground uppercase">or</span>
            <div className="flex-1 border-t border-border" />
          </div>

          {/* Drive folder picker */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground font-medium">Google Drive folder</p>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={() => setShowDrivePicker((v) => !v)}
              >
                {showDrivePicker ? "Cancel" : "Browse Drive"}
              </Button>
            </div>
            {showDrivePicker && (
              <GDriveFolderPicker
                onSelect={(folder) => save.mutate({ driveFolderId: folder.id })}
              />
            )}
          </div>

          {editing && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditing(false); setShowDrivePicker(false); }}>
              Cancel
            </Button>
          )}
          {save.isError && (
            <p className="text-xs text-destructive">
              {save.error instanceof Error ? save.error.message : "Save failed"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function GoogleOAuthCredsSection() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const { data: credsStatus, isLoading } = useQuery({
    queryKey: ["google-app-creds"],
    queryFn: () => referenceDocumentsApi.getGoogleAppCreds(),
  });

  const save = useMutation({
    mutationFn: () => referenceDocumentsApi.saveGoogleAppCreds(clientId.trim(), clientSecret.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google-app-creds"] });
      setEditing(false);
      setClientId("");
      setClientSecret("");
    },
  });

  const remove = useMutation({
    mutationFn: () => referenceDocumentsApi.deleteGoogleAppCreds(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["google-app-creds"] }),
  });

  const configured = credsStatus?.configured ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-yellow-400" />
        <h3 className="text-sm font-semibold">Google OAuth App Credentials</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Required to connect Google Drive. Create an OAuth 2.0 Client ID in{" "}
        <span className="font-mono">Google Cloud Console → APIs &amp; Services → Credentials</span>.
        Set the authorised redirect URI to{" "}
        <span className="font-mono text-xs">[your-host]/api/instance/storage/gdrive/callback</span>.
      </p>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Checking...</div>
      ) : configured && !editing ? (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {credsStatus?.fromEnv ? "Configured via environment variables" : "Configured"}
                </p>
                {credsStatus?.clientId && (
                  <p className="text-xs text-muted-foreground font-mono truncate max-w-xs">
                    {credsStatus.clientId}
                  </p>
                )}
              </div>
            </div>
            {!credsStatus?.fromEnv && (
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-2">
            <Input
              placeholder="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="text-sm h-8 font-mono"
            />
            <Input
              placeholder="Client Secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              className="text-sm h-8 font-mono"
            />
          </div>
          {save.isError && (
            <p className="text-xs text-destructive">
              {save.error instanceof Error ? save.error.message : "Failed to save"}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!clientId.trim() || !clientSecret.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving..." : "Save"}
            </Button>
            {editing && (
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setClientId(""); setClientSecret(""); }}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GDriveFolderPicker({
  onSelect,
}: {
  onSelect: (folder: { id: string; name: string }) => void;
}) {
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
    <div className="rounded-lg border border-border bg-card">
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
          <div className="px-3 py-4 text-xs text-muted-foreground">No folders here</div>
        ) : (
          data!.folders.map((folder) => (
            <div key={folder.id} className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 group">
              <Cloud className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span
                className="flex-1 text-xs cursor-pointer"
                onClick={() => drillInto(folder)}
              >
                {folder.name}
              </span>
              <button
                className="text-[10px] text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0 px-2 py-0.5 rounded border border-border hover:bg-accent"
                onClick={() => onSelect(folder)}
              >
                Select
              </button>
              <button
                className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={() => drillInto(folder)}
                title="Open folder"
              >
                →
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function GDriveFoldersSection({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);

  const { data: sources = [] } = useQuery({
    queryKey: ["document-sources", companyId],
    queryFn: () => referenceDocumentsApi.listSources(companyId),
  });

  const gdriveSources = sources.filter((s) => s.type === "gdrive");

  const addSource = useMutation({
    mutationFn: (folder: { id: string; name: string }) =>
      referenceDocumentsApi.createSource(companyId, {
        type: "gdrive",
        name: folder.name,
        driveFolderId: folder.id,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["document-sources", companyId] });
      setPicking(false);
    },
  });

  const deleteSource = useMutation({
    mutationFn: (id: string) => referenceDocumentsApi.deleteSource(companyId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document-sources", companyId] }),
  });

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground font-medium">Synced folders</p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPicking((v) => !v)}>
          <Plus className="h-3.5 w-3.5 mr-1" />{picking ? "Cancel" : "Add folder"}
        </Button>
      </div>

      {picking && (
        <GDriveFolderPicker onSelect={(folder) => addSource.mutate(folder)} />
      )}

      {gdriveSources.length > 0 && (
        <div className="space-y-1.5">
          {gdriveSources.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
              <Cloud className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span className="flex-1 text-xs truncate font-medium">{s.name}</span>
              {s.lastSyncError ? (
                <span className="text-[10px] text-red-400 shrink-0">{s.lastSyncError.slice(0, 40)}</span>
              ) : s.lastSyncedAt ? (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  Synced {new Date(s.lastSyncedAt).toLocaleTimeString()}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground shrink-0">Never synced</span>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => deleteSource.mutate(s.id)}
                disabled={deleteSource.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {gdriveSources.length === 0 && !picking && (
        <p className="text-xs text-muted-foreground">No folders added yet.</p>
      )}
    </div>
  );
}

function GDriveSection({ companyId }: { companyId: string | null }) {
  const qc = useQueryClient();

  const { data: credsStatus } = useQuery({
    queryKey: ["google-app-creds"],
    queryFn: () => referenceDocumentsApi.getGoogleAppCreds(),
  });

  const { data: status, isLoading } = useQuery({
    queryKey: ["gdrive-status"],
    queryFn: () => referenceDocumentsApi.getGDriveStatus(),
  });

  const connect = async () => {
    try {
      const { url } = await referenceDocumentsApi.getGDriveAuthUrl();
      const popup = window.open(url, "gdrive-auth", "width=600,height=700,noopener");
      if (!popup) { window.location.href = url; return; }
      const onMessage = (e: MessageEvent) => {
        if (e.data === "gdrive-connected") {
          window.removeEventListener("message", onMessage);
          qc.invalidateQueries({ queryKey: ["gdrive-status"] });
        }
      };
      window.addEventListener("message", onMessage);
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          window.removeEventListener("message", onMessage);
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

  const credsConfigured = credsStatus?.configured ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-blue-400" />
        <h3 className="text-sm font-semibold">Google Drive</h3>
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Checking status...</div>
      ) : status?.connected ? (
        <>
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
          {companyId && <GDriveFoldersSection companyId={companyId} />}
        </>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {credsConfigured ? "Not connected" : "OAuth credentials required above"}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={connect} disabled={!credsConfigured}>
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

function ApprovalSettingsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["approval-settings"],
    queryFn: () => referenceDocumentsApi.getApprovalSettings(),
  });

  const save = useMutation({
    mutationFn: (settings: { requireClientReplyApproval: boolean; requirePlanApproval: boolean }) =>
      referenceDocumentsApi.setApprovalSettings(settings),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approval-settings"] }),
  });

  if (isLoading || !data) return null;

  function toggle(key: "requireClientReplyApproval" | "requirePlanApproval") {
    save.mutate({ ...data!, [key]: !data![key] });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold">Approval Gates</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Control which actions require operator approval before executing.
      </p>
      <div className="space-y-2">
        {([
          { key: "requireClientReplyApproval" as const, label: "Client replies", desc: "Approve before any message is sent to a client" },
          { key: "requirePlanApproval" as const, label: "Plans", desc: "Approve plans before agents execute them" },
        ]).map(({ key, label, desc }) => (
          <div key={key} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </div>
            <button
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${data[key] ? "bg-primary" : "bg-muted"}`}
              onClick={() => toggle(key)}
              disabled={save.isPending}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${data[key] ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>
        ))}
      </div>
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

      <CompanyStorageRootSection companyId={selectedCompanyId ?? null} />

      <div className="border-t border-border pt-6">
        <GoogleOAuthCredsSection />
      </div>

      <div className="border-t border-border pt-6">
        <GDriveSection companyId={selectedCompanyId ?? null} />
      </div>

      <div className="border-t border-border pt-6">
        {selectedCompanyId ? (
          <LocalSourcesSection companyId={selectedCompanyId} />
        ) : (
          <p className="text-sm text-muted-foreground">Select a company to configure local folders.</p>
        )}
      </div>

      <div className="border-t border-border pt-6">
        <ApprovalSettingsSection />
      </div>
    </div>
  );
}
