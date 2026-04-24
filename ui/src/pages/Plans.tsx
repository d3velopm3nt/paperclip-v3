// v3: plan-gate approval queue — list + detail + approve/reject
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { plansApi, type Plan, type PlanDetail } from "../api/plans";
import { clientsApi } from "../api/clients";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  ShieldCheck,
  Check,
  X,
  RotateCcw,
  ArrowLeft,
  Mail,
  AlertCircle,
  Clock,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from "lucide-react";

const DECISION_FILTERS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "__all__", label: "All" },
] as const;

const DECISION_COLORS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  revision_requested: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
};

const EXEC_COLORS: Record<string, string> = {
  pending: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  failed: "text-rose-600 dark:text-rose-400",
};

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function Plans() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId!;
  const [decisionFilter, setDecisionFilter] = useState<string>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Governance" }, { label: "Plans" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: queryKeys.plans.list(companyId, decisionFilter),
    queryFn: () =>
      plansApi.list(companyId, decisionFilter === "__all__" ? undefined : decisionFilter),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });

  const clientsQuery = useQuery({
    queryKey: queryKeys.clients.list(companyId),
    queryFn: () => clientsApi.list(companyId),
    enabled: !!companyId,
  });
  const clientsById = Object.fromEntries((clientsQuery.data ?? []).map((c) => [c.id, c]));

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (listQuery.isLoading) return <PageSkeleton />;
  const plans = listQuery.data ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-6 pb-3 border-b border-border">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldCheck className="h-6 w-6" /> Plans
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Agent-proposed actions awaiting your approval.
        </p>
      </div>

      <div className="flex items-center gap-2 px-6 py-3 border-b border-border flex-wrap">
        {DECISION_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setDecisionFilter(f.key)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              decisionFilter === f.key
                ? "border-foreground/40 bg-foreground/10"
                : "border-border hover:border-foreground/30"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        <div className={`flex-1 min-h-0 overflow-y-auto ${selectedId ? "hidden sm:block sm:max-w-md sm:border-r sm:border-border" : ""}`}>
          {plans.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No {decisionFilter === "__all__" ? "" : decisionFilter} plans.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {plans.map((p) => (
                <PlanRow
                  key={p.id}
                  plan={p}
                  clientName={p.clientId ? clientsById[p.clientId]?.name : null}
                  selected={p.id === selectedId}
                  onClick={() => setSelectedId(p.id)}
                />
              ))}
            </ul>
          )}
        </div>
        {selectedId && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-muted/10">
            <PlanDetailPane planId={selectedId} onBack={() => setSelectedId(null)} clientsById={clientsById} />
          </div>
        )}
      </div>
    </div>
  );
}

function PlanRow({
  plan,
  clientName,
  selected,
  onClick,
}: {
  plan: Plan;
  clientName: string | null | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left p-4 hover:bg-accent/40 transition-colors ${selected ? "bg-accent/60" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{plan.actionType ?? plan.kind}</span>
          <span className="text-xs text-muted-foreground shrink-0">{relativeTime(plan.proposedAt)}</span>
        </div>
        <div className="text-sm text-muted-foreground truncate mt-0.5">{plan.proposalText}</div>
        <div className="flex items-center gap-2 mt-2">
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ${DECISION_COLORS[plan.decision] ?? "bg-muted text-muted-foreground"}`}
          >
            {plan.decision}
          </span>
          {clientName && (
            <span className="text-[11px] text-muted-foreground">for {clientName}</span>
          )}
          {plan.executionStatus !== "pending" && (
            <span className={`text-[11px] ${EXEC_COLORS[plan.executionStatus]}`}>
              {plan.executionStatus}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

function PlanDetailPane({
  planId,
  onBack,
  clientsById,
}: {
  planId: string;
  onBack: () => void;
  clientsById: Record<string, { name: string }>;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [note, setNote] = useState("");

  const detailQuery = useQuery({
    queryKey: queryKeys.plans.detail(planId),
    queryFn: () => plansApi.get(planId),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.plans.detail(planId) });
    queryClient.invalidateQueries({ queryKey: ["plans"] });
    queryClient.invalidateQueries({ queryKey: ["email-messages"] });
  }

  const decideMutation = useMutation({
    mutationFn: (decision: "approved" | "rejected" | "revision_requested") =>
      plansApi.decide(planId, decision, note || undefined),
    onSuccess: (res) => {
      invalidate();
      setNote("");
      if (res.executionError) {
        pushToast({ tone: "warn", title: "Approved but execution failed", body: res.executionError });
      } else if (res.createdIssueId) {
        pushToast({ title: `Approved — issue ${res.createdIssueId.slice(0, 8)}… created` });
      } else {
        pushToast({ title: `Plan ${res.decision}` });
      }
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Decision failed", body: err.message }),
  });

  if (detailQuery.isLoading || !detailQuery.data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  const plan: PlanDetail = detailQuery.data;
  const meta = (plan.proposalMeta ?? {}) as Record<string, unknown>;
  const sourceEmail = (meta.sourceEmail ?? null) as { subject?: string; from?: string } | null;
  const clientName = plan.clientId ? clientsById[plan.clientId]?.name : null;
  const pending = plan.decision === "pending";

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="sm:hidden">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex items-center gap-2 ml-auto">
          <span className={`text-xs px-2 py-0.5 rounded-full ${DECISION_COLORS[plan.decision] ?? "bg-muted"}`}>
            {plan.decision}
          </span>
          {plan.executionStatus !== "pending" && (
            <span className={`text-xs ${EXEC_COLORS[plan.executionStatus]}`}>
              {plan.executionStatus}
            </span>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold leading-tight">{plan.actionType ?? plan.kind}</h2>
        <p className="text-sm text-muted-foreground mt-1">{plan.proposalText}</p>
        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground mt-2">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" /> proposed {relativeTime(plan.proposedAt)}
          </span>
          {clientName && <span>for {clientName}</span>}
          <span>confidence: {plan.confidence}</span>
        </div>
      </div>

      {sourceEmail && (
        <Card className="p-3 bg-muted/40">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
            <Mail className="h-3 w-3" /> Source email
          </div>
          <div className="text-sm">
            <div className="truncate">{sourceEmail.subject || "(no subject)"}</div>
            <div className="text-xs text-muted-foreground font-mono">{sourceEmail.from}</div>
          </div>
        </Card>
      )}

      {plan.issueId && (
        <Card className="p-3 border-emerald-500/30 bg-emerald-500/5">
          <div className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>
              Issue created:{" "}
              <a href={`/issues/${plan.issueId}`} className="font-mono underline inline-flex items-center gap-1">
                {plan.issueId.slice(0, 8)}… <ExternalLink className="h-3 w-3" />
              </a>
            </span>
          </div>
        </Card>
      )}

      {plan.executionError && (
        <Card className="p-3 border-rose-500/40 bg-rose-500/5 text-sm text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{plan.executionError}</span>
        </Card>
      )}

      {plan.decisionNote && (
        <Card className="p-3 bg-muted/40">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
            Decision note
          </div>
          <div className="text-sm whitespace-pre-wrap">{plan.decisionNote}</div>
        </Card>
      )}

      {pending && (
        <div className="space-y-3">
          <Textarea
            placeholder="Optional note for this decision…"
            value={note}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={() => decideMutation.mutate("approved")}
              disabled={decideMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <Check className="h-4 w-4 mr-1" /> Approve
            </Button>
            <Button
              variant="outline"
              onClick={() => decideMutation.mutate("revision_requested")}
              disabled={decideMutation.isPending}
            >
              <RotateCcw className="h-4 w-4 mr-1" /> Request revision
            </Button>
            <Button
              variant="outline"
              onClick={() => decideMutation.mutate("rejected")}
              disabled={decideMutation.isPending}
              className="text-destructive hover:text-destructive"
            >
              <X className="h-4 w-4 mr-1" /> Reject
            </Button>
          </div>
        </div>
      )}

      {!pending && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> Decided{" "}
          {plan.decidedAt ? new Date(plan.decidedAt).toLocaleString() : "—"}
          {plan.decidedByUserId ? ` by ${plan.decidedByUserId.slice(0, 8)}…` : ""}
        </div>
      )}
    </div>
  );
}
