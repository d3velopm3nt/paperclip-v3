// v3: index of all message workflow runs (all types) for the selected company.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { workflowRunsApi, type WorkflowRun } from "../api/workflowRuns";
import { emailMessagesApi, type EmailMessageSummary } from "../api/emailMessages";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Activity, CheckCircle2, XCircle, Clock, MinusCircle, HelpCircle } from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
  inbound_email: "Email",
  ecc_conversation: "ECC",
};

const STATUS_META: Record<string, { color: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  passed: { color: "text-emerald-600", icon: CheckCircle2, label: "passed" },
  failed: { color: "text-rose-600", icon: XCircle, label: "failed" },
  partial: { color: "text-amber-600", icon: Clock, label: "partial" },
  running: { color: "text-blue-600", icon: Activity, label: "running" },
  skipped: { color: "text-muted-foreground", icon: MinusCircle, label: "skipped" },
  unknown: { color: "text-slate-500", icon: HelpCircle, label: "unknown" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${meta.color}`}>
      <Icon className="h-3.5 w-3.5" />
      {status}
    </span>
  );
}

function TypeChip({ type }: { type: string }) {
  const label = TYPE_LABELS[type] ?? type;
  const colors: Record<string, string> = {
    inbound_email: "bg-blue-500/10 text-blue-700",
    ecc_conversation: "bg-violet-500/10 text-violet-700",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[type] ?? "bg-muted text-muted-foreground"}`}>
      {label}
    </span>
  );
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export function EmailWorkflows() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const companyId = selectedCompanyId!;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Message Workflows" }]);
  }, [setBreadcrumbs]);

  const runsQuery = useQuery({
    queryKey: ["workflow-runs", "company", companyId, "all"],
    queryFn: () => workflowRunsApi.listForCompany(companyId, undefined, 200),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });

  // Latest run per source per type (collapse history rows).
  const latestRuns = useMemo<WorkflowRun[]>(() => {
    const rows = runsQuery.data ?? [];
    const seen = new Set<string>();
    const out: WorkflowRun[] = [];
    for (const r of rows) {
      const key = `${r.workflowType}:${r.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }, [runsQuery.data]);

  // Resolve email metadata only for email-type runs.
  const emailSourceIds = latestRuns.filter((r) => r.workflowType === "inbound_email").map((r) => r.sourceId);
  const emailsQuery = useQuery({
    queryKey: ["workflow-runs", "emails", emailSourceIds.join(",")],
    queryFn: async () => {
      const out = new Map<string, EmailMessageSummary>();
      await Promise.all(
        emailSourceIds.map(async (id) => {
          try {
            const e = await emailMessagesApi.get(id);
            out.set(id, e);
          } catch {
            // deleted — leave missing
          }
        }),
      );
      return out;
    },
    enabled: emailSourceIds.length > 0,
  });

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (runsQuery.isLoading) return <PageSkeleton />;

  const filtered = latestRuns.filter((r) => {
    if (typeFilter !== "all" && r.workflowType !== typeFilter) return false;
    if (statusFilter !== "all" && r.overallStatus !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const email = emailsQuery.data?.get(r.sourceId);
    return (
      r.sourceId.toLowerCase().includes(q) ||
      r.workflowType.toLowerCase().includes(q) ||
      (email?.subject?.toLowerCase().includes(q) ?? false) ||
      (email?.fromAddr?.toLowerCase().includes(q) ?? false)
    );
  });

  function handleRowClick(r: WorkflowRun) {
    if (r.workflowType === "inbound_email") {
      navigate(`/email/inbox/${r.sourceId}/workflow`);
    } else {
      navigate(`/workflows/run/${r.id}`);
    }
  }

  function rowLabel(r: WorkflowRun): string {
    if (r.workflowType === "inbound_email") {
      const email = emailsQuery.data?.get(r.sourceId);
      return email?.subject || (email ? "(no subject)" : "(email deleted)");
    }
    return r.sourceId.slice(0, 8) + "…";
  }

  function rowSublabel(r: WorkflowRun): string {
    if (r.workflowType === "inbound_email") {
      const email = emailsQuery.data?.get(r.sourceId);
      return email?.fromAddr ?? r.sourceId;
    }
    return r.sourceId;
  }

  // Distinct types present in data for tab display
  const typesPresent = Array.from(new Set(latestRuns.map((r) => r.workflowType)));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-6 pb-3 border-b border-border">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Activity className="h-6 w-6" /> Message Workflows
              {selectedCompany && (
                <span className="text-sm font-normal text-muted-foreground">· {selectedCompany.name}</span>
              )}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Latest workflow run per message — click to inspect.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              placeholder="Search subject / sender / id"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56"
            />
            <select
              className="border border-input bg-background rounded-md h-9 px-2 text-sm"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All types</option>
              {typesPresent.map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
              ))}
            </select>
            <select
              className="border border-input bg-background rounded-md h-9 px-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="passed">Passed</option>
              <option value="partial">Partial</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No workflow runs match.
          </Card>
        ) : (
          <div className="grid gap-2">
            {filtered.map((r) => (
              <Card
                key={r.id}
                className="p-3 hover:border-border/80 hover:bg-accent/30 cursor-pointer transition-colors"
                onClick={() => handleRowClick(r)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-24 shrink-0">
                    <StatusBadge status={r.overallStatus} />
                  </div>
                  <div className="shrink-0">
                    <TypeChip type={r.workflowType} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{rowLabel(r)}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate">{rowSublabel(r)}</div>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0 text-right">
                    <div>started {relativeTime(r.startedAt)}</div>
                    {r.finishedAt && <div>finished {relativeTime(r.finishedAt)}</div>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
