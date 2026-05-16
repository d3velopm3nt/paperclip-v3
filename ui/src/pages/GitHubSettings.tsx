import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Github, Key, KeyRound, Plus, Trash2 } from "lucide-react";
import { referenceDocumentsApi } from "../api/referenceDocuments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CreateDocumentSourceInput } from "@paperclipai/shared";

function GitHubOAuthCredsSection() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const { data: credsStatus, isLoading } = useQuery({
    queryKey: ["github-app-creds"],
    queryFn: () => referenceDocumentsApi.getGitHubAppCreds(),
  });

  const save = useMutation({
    mutationFn: () => referenceDocumentsApi.saveGitHubAppCreds(clientId.trim(), clientSecret.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github-app-creds"] });
      setEditing(false);
      setClientId("");
      setClientSecret("");
    },
  });

  const remove = useMutation({
    mutationFn: () => referenceDocumentsApi.deleteGitHubAppCreds(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-app-creds"] }),
  });

  const configured = credsStatus?.configured ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-yellow-400" />
        <h3 className="text-sm font-semibold">OAuth App Credentials</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Create an OAuth App in{" "}
        <span className="font-mono">GitHub → Settings → Developer settings → OAuth Apps</span>.
        Set the callback URL to{" "}
        <span className="font-mono text-xs">[your-host]/api/instance/storage/github/callback</span>.
        Requested scopes: <span className="font-mono">repo read:org</span>.
      </p>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Checking...</div>
      ) : configured && !editing ? (
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {credsStatus?.fromEnv ? "Configured via environment variables" : "Configured"}
                </p>
                {credsStatus?.clientId && (
                  <p className="text-xs text-muted-foreground font-mono truncate max-w-xs">{credsStatus.clientId}</p>
                )}
              </div>
            </div>
            {!credsStatus?.fromEnv && (
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
                <Button variant="destructive" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Input placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} className="text-sm h-8 font-mono" />
          <Input placeholder="Client Secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="text-sm h-8 font-mono" />
          {save.isError && <p className="text-xs text-destructive">{save.error instanceof Error ? save.error.message : "Failed to save"}</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={!clientId.trim() || !clientSecret.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving..." : "Save"}
            </Button>
            {editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setClientId(""); setClientSecret(""); }}>Cancel</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

function GitHubConnectionSection() {
  const qc = useQueryClient();
  const [patValue, setPatValue] = useState("");
  const [patMode, setPatMode] = useState(false);

  const { data: credsStatus } = useQuery({
    queryKey: ["github-app-creds"],
    queryFn: () => referenceDocumentsApi.getGitHubAppCreds(),
  });

  const { data: status, isLoading } = useQuery({
    queryKey: ["github-status"],
    queryFn: () => referenceDocumentsApi.getGitHubStatus(),
  });

  const savePAT = useMutation({
    mutationFn: () => referenceDocumentsApi.saveGitHubPAT(patValue.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github-status"] });
      setPatValue("");
      setPatMode(false);
    },
  });

  const connect = async () => {
    try {
      const { url } = await referenceDocumentsApi.getGitHubAuthUrl();
      const popup = window.open(url, "github-auth", "width=600,height=700,noopener");
      if (!popup) { window.location.href = url; return; }
      const onMessage = (e: MessageEvent) => {
        if (e.data === "github-connected") {
          window.removeEventListener("message", onMessage);
          qc.invalidateQueries({ queryKey: ["github-status"] });
        }
      };
      window.addEventListener("message", onMessage);
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          window.removeEventListener("message", onMessage);
          qc.invalidateQueries({ queryKey: ["github-status"] });
        }
      }, 500);
    } catch (err) {
      console.error("github connect error", err);
    }
  };

  const disconnect = useMutation({
    mutationFn: () => referenceDocumentsApi.disconnectGitHub(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-status"] }),
  });

  const credsConfigured = credsStatus?.configured ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Github className="h-4 w-4" />
        <h3 className="text-sm font-semibold">Account Connection</h3>
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Checking...</div>
      ) : status?.connected ? (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-400" />
            <div>
              <span className="text-sm">Connected as <span className="font-medium">{status.login}</span></span>
              {status.scope && status.scope !== "pat" && (
                <p className="text-[10px] text-muted-foreground">Scopes: {status.scope}</p>
              )}
              {status.scope === "pat" && (
                <p className="text-[10px] text-muted-foreground">via Personal Access Token</p>
              )}
            </div>
          </div>
          <Button variant="destructive" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      ) : patMode ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Create a token at <span className="font-mono">GitHub → Settings → Developer settings → Personal access tokens</span>.
            Required scopes: <span className="font-mono">repo read:org</span>.
          </p>
          <Input
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            type="password"
            value={patValue}
            onChange={(e) => setPatValue(e.target.value)}
            className="text-sm h-8 font-mono"
          />
          {savePAT.isError && (
            <p className="text-xs text-destructive">{savePAT.error instanceof Error ? savePAT.error.message : "Failed"}</p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={!patValue.trim() || savePAT.isPending} onClick={() => savePAT.mutate()}>
              {savePAT.isPending ? "Verifying..." : "Save Token"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPatMode(false); setPatValue(""); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setPatMode(true)}>
            <Key className="h-3.5 w-3.5 mr-1.5" />
            Use Personal Access Token
          </Button>
          {credsConfigured && (
            <Button variant="outline" size="sm" onClick={connect}>
              <Github className="h-3.5 w-3.5 mr-1.5" />
              Connect via OAuth
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function LinkedReposSection({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [showForm, setShowForm] = useState(false);

  const { data: sources = [] } = useQuery({
    queryKey: ["document-sources", companyId],
    queryFn: () => referenceDocumentsApi.listSources(companyId),
  });

  const githubSources = sources.filter((s) => s.type === "github");

  const addSource = useMutation({
    mutationFn: () => {
      const repoName = repoUrl.trim().split("/").slice(-2).join("/").replace(".git", "");
      const input: CreateDocumentSourceInput = {
        type: "github",
        name: repoName || repoUrl.trim(),
        githubRepoUrl: repoUrl.trim(),
        githubBranch: branch.trim() || "main",
      };
      return referenceDocumentsApi.createSource(companyId, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["document-sources", companyId] });
      setRepoUrl("");
      setBranch("main");
      setShowForm(false);
    },
  });

  const deleteSource = useMutation({
    mutationFn: (sourceId: string) => referenceDocumentsApi.deleteSource(companyId, sourceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document-sources", companyId] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Linked Repositories</h3>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-3.5 w-3.5 mr-1" />{showForm ? "Cancel" : "Add repo"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Repos are cloned and indexed every 30 min. Files become searchable by agents as document context.
      </p>

      {showForm && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <Input
            placeholder="https://github.com/owner/repo"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            className="text-sm h-8"
          />
          <Input
            placeholder="Branch (default: main)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="text-sm h-8"
          />
          <Button size="sm" disabled={!repoUrl.trim() || addSource.isPending} onClick={() => addSource.mutate()} className="w-full">
            {addSource.isPending ? "Linking..." : "Link Repository"}
          </Button>
          {addSource.isError && <p className="text-xs text-red-400">Failed to link repo.</p>}
        </div>
      )}

      {githubSources.length > 0 ? (
        <div className="space-y-1.5">
          {githubSources.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
              <Github className="h-3.5 w-3.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{s.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{s.githubRepoUrl} · {s.githubBranch ?? "main"}</p>
              </div>
              {s.lastSyncError ? (
                <span className="text-[10px] text-red-400 shrink-0">{s.lastSyncError.slice(0, 30)}</span>
              ) : s.lastSyncedAt ? (
                <span className="text-[10px] text-muted-foreground shrink-0">Synced {new Date(s.lastSyncedAt).toLocaleTimeString()}</span>
              ) : (
                <span className="text-[10px] text-muted-foreground shrink-0">Cloning...</span>
              )}
              <Button size="icon-sm" variant="ghost" onClick={() => deleteSource.mutate(s.id)} disabled={deleteSource.isPending}>
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      ) : !showForm && (
        <p className="text-xs text-muted-foreground">No repositories linked yet.</p>
      )}
    </div>
  );
}

export function GitHubSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "GitHub" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold">GitHub</h1>
        <p className="text-sm text-muted-foreground">
          Connect GitHub to clone and index repositories for agent context, and to set project codebases.
        </p>
      </div>

      <GitHubOAuthCredsSection />

      <div className="border-t border-border pt-6">
        <GitHubConnectionSection />
      </div>

      <div className="border-t border-border pt-6">
        {selectedCompanyId ? (
          <LinkedReposSection companyId={selectedCompanyId} />
        ) : (
          <p className="text-sm text-muted-foreground">Select a company to manage linked repositories.</p>
        )}
      </div>
    </div>
  );
}
