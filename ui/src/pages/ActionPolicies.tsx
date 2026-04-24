// v3: plan-gate policy editor — per-company rules for which actions need approval.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  actionPoliciesApi,
  type ActionPolicy,
  type PolicyScope,
} from "../api/actionPolicies";
import { clientsApi, type Client } from "../api/clients";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShieldCheck, Plus, Trash2, RefreshCw, BellRing, LockKeyhole } from "lucide-react";

const ACTION_TYPE_HELP: Record<string, string> = {
  send_email: "Agent composes and sends an outbound email.",
  deploy: "Agent triggers a deployment or infra change.",
  delete_data: "Agent removes rows, files, or external resources.",
  create_issue_external: "Agent creates an issue in an external tracker (GitHub, Linear, etc).",
  spend_over_cents: "Agent action projected to spend above paramsJson.thresholdCents.",
  reply_to_sender: "Agent replies to the inbound email sender.",
  create_issue: "Agent creates an issue in this instance.",
  request_clarification: "Agent emails the sender asking for more info.",
};

export function ActionPolicies() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId!;

  const [addOpen, setAddOpen] = useState(false);
  const [newActionType, setNewActionType] = useState("");
  const [newScope, setNewScope] = useState<PolicyScope>("company");
  const [newScopeRefId, setNewScopeRefId] = useState<string>("");
  const [scopeFilter, setScopeFilter] = useState<PolicyScope | "all">("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Governance" }, { label: "Action Policies" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: queryKeys.actionPolicies.list(companyId),
    queryFn: () => actionPoliciesApi.list(companyId),
    enabled: !!companyId,
  });

  const clientsQuery = useQuery({
    queryKey: queryKeys.clients.list(companyId),
    queryFn: () => clientsApi.list(companyId),
    enabled: !!companyId,
  });
  const clientsById: Record<string, Client> = Object.fromEntries(
    (clientsQuery.data ?? []).map((c) => [c.id, c]),
  );

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.actionPolicies.list(companyId) });
  }

  const updateMutation = useMutation({
    mutationFn: (args: { id: string; patch: Partial<Pick<ActionPolicy, "requiresApproval" | "immediateEmail" | "paramsJson">> }) =>
      actionPoliciesApi.update(args.id, args.patch),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Update failed", body: err.message }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      actionPoliciesApi.create(companyId, {
        actionType: newActionType,
        scope: newScope,
        scopeRefId: newScope === "company" ? companyId : newScopeRefId,
        requiresApproval: true,
        immediateEmail: false,
      }),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      setNewActionType("");
      setNewScope("company");
      setNewScopeRefId("");
      pushToast({ title: "Policy added" });
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Create failed", body: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => actionPoliciesApi.delete(id),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Policy removed" });
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Delete failed", body: err.message }),
  });

  const seedMutation = useMutation({
    mutationFn: () => actionPoliciesApi.seedDefaults(companyId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Defaults seeded" });
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Seed failed", body: err.message }),
  });

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (listQuery.isLoading) return <PageSkeleton />;
  const allPolicies = listQuery.data ?? [];
  const policies =
    scopeFilter === "all" ? allPolicies : allPolicies.filter((p) => p.scope === scopeFilter);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ShieldCheck className="h-6 w-6" /> Action Policies
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">
            Per-action rules the plan-gate uses before any agent in this company can act.
            Toggle whether an action requires your approval and whether approval requests
            should email you immediately.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => seedMutation.mutate()} disabled={seedMutation.isPending}>
            <RefreshCw className="h-4 w-4 mr-1" /> Seed defaults
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add policy
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "company", "client", "project", "agent"] as const).map((scope) => (
          <button
            key={scope}
            onClick={() => setScopeFilter(scope)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${
              scopeFilter === scope
                ? "border-foreground/40 bg-foreground/10"
                : "border-border hover:border-foreground/30"
            }`}
          >
            {scope}
          </button>
        ))}
      </div>

      {policies.length === 0 ? (
        <Card className="p-8 text-center">
          <ShieldCheck className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No policies yet. Click "Seed defaults" to add the standard set.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-4 py-2">Action</th>
                <th className="text-left font-medium px-2 py-2">Scope</th>
                <th className="text-center font-medium px-2 py-2" title="Plan-gate blocks action until approved">
                  <div className="inline-flex items-center gap-1"><LockKeyhole className="h-3 w-3" /> Approval</div>
                </th>
                <th className="text-center font-medium px-2 py-2" title="Email you immediately when approval is needed">
                  <div className="inline-flex items-center gap-1"><BellRing className="h-3 w-3" /> Immediate email</div>
                </th>
                <th className="text-left font-medium px-4 py-2">Params</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {policies.map((p) => (
                <PolicyRow
                  key={p.id}
                  policy={p}
                  scopeLabel={scopeLabel(p, clientsById, companyId)}
                  onToggleApproval={(value) =>
                    updateMutation.mutate({ id: p.id, patch: { requiresApproval: value } })
                  }
                  onToggleImmediate={(value) =>
                    updateMutation.mutate({ id: p.id, patch: { immediateEmail: value } })
                  }
                  onParamsCommit={(next) =>
                    updateMutation.mutate({ id: p.id, patch: { paramsJson: next } })
                  }
                  onDelete={() => deleteMutation.mutate(p.id)}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add policy</DialogTitle>
            <DialogDescription>
              Provide the action type string the agent will use (e.g. <code>reply_to_sender</code>).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Action type</span>
              <Input
                value={newActionType}
                placeholder="e.g. reply_to_sender"
                onChange={(e) => setNewActionType(e.target.value.trim())}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Scope</span>
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={newScope}
                onChange={(e) => {
                  setNewScope(e.target.value as PolicyScope);
                  setNewScopeRefId("");
                }}
              >
                <option value="company">Company (whole company)</option>
                <option value="client">Client</option>
                <option value="project">Project</option>
                <option value="agent">Agent</option>
              </select>
            </label>
            {newScope === "client" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Client</span>
                <select
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  value={newScopeRefId}
                  onChange={(e) => setNewScopeRefId(e.target.value)}
                >
                  <option value="">Select a client…</option>
                  {(clientsQuery.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            )}
            {(newScope === "project" || newScope === "agent") && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{newScope} id (uuid)</span>
                <Input
                  value={newScopeRefId}
                  placeholder="paste the id"
                  onChange={(e) => setNewScopeRefId(e.target.value.trim())}
                />
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              disabled={
                !newActionType ||
                createMutation.isPending ||
                (newScope !== "company" && !newScopeRefId)
              }
              onClick={() => createMutation.mutate()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function scopeLabel(p: ActionPolicy, clientsById: Record<string, Client>, companyId: string): string {
  if (p.scope === "company") return "company";
  if (p.scope === "client") {
    const name = clientsById[p.scopeRefId]?.name;
    return name ? `client: ${name}` : `client: ${p.scopeRefId.slice(0, 8)}…`;
  }
  if (p.scopeRefId === companyId) return p.scope;
  return `${p.scope}: ${p.scopeRefId.slice(0, 8)}…`;
}

function PolicyRow({
  policy,
  scopeLabel: scopeText,
  onToggleApproval,
  onToggleImmediate,
  onParamsCommit,
  onDelete,
}: {
  policy: ActionPolicy;
  scopeLabel: string;
  onToggleApproval: (value: boolean) => void;
  onToggleImmediate: (value: boolean) => void;
  onParamsCommit: (next: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [paramsText, setParamsText] = useState(() => JSON.stringify(policy.paramsJson ?? {}, null, 0));
  const [paramsError, setParamsError] = useState<string | null>(null);

  useEffect(() => {
    setParamsText(JSON.stringify(policy.paramsJson ?? {}, null, 0));
  }, [policy.paramsJson]);

  function commitParams() {
    try {
      const parsed = paramsText.trim() === "" ? {} : JSON.parse(paramsText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Must be a JSON object");
      }
      setParamsError(null);
      onParamsCommit(parsed as Record<string, unknown>);
    } catch (err) {
      setParamsError((err as Error).message);
    }
  }

  const help = ACTION_TYPE_HELP[policy.actionType];

  return (
    <tr className="hover:bg-accent/20">
      <td className="px-4 py-3 align-top">
        <div className="font-mono text-sm">{policy.actionType}</div>
        {help && <div className="text-xs text-muted-foreground mt-0.5 max-w-md">{help}</div>}
      </td>
      <td className="px-2 py-3 align-top">
        <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground">
          {scopeText}
        </span>
      </td>
      <td className="px-2 py-3 text-center align-top">
        <input
          type="checkbox"
          checked={policy.requiresApproval}
          onChange={(e) => onToggleApproval(e.target.checked)}
          className="h-4 w-4 accent-foreground"
        />
      </td>
      <td className="px-2 py-3 text-center align-top">
        <input
          type="checkbox"
          checked={policy.immediateEmail}
          onChange={(e) => onToggleImmediate(e.target.checked)}
          className="h-4 w-4 accent-foreground"
          disabled={!policy.requiresApproval}
          title={!policy.requiresApproval ? "Enable approval first" : undefined}
        />
      </td>
      <td className="px-4 py-3 align-top">
        <Input
          value={paramsText}
          onChange={(e) => setParamsText(e.target.value)}
          onBlur={commitParams}
          className="h-8 text-xs font-mono"
          placeholder="{}"
        />
        {paramsError && <div className="text-xs text-destructive mt-1">{paramsError}</div>}
      </td>
      <td className="px-2 py-3 text-right align-top">
        <Button variant="ghost" size="icon-sm" onClick={onDelete} title="Remove policy">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </td>
    </tr>
  );
}
