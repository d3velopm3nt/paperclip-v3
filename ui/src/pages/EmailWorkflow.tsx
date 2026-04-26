// v3: workflow viewer for inbound email — visual diagnostic of the
// triage → plan → execute pipeline against a single email.
import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  workflowRunsApi,
  type WorkflowRun,
  type WorkflowStageResult,
} from "../api/workflowRuns";
import { emailMessagesApi } from "../api/emailMessages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, RefreshCw, CheckCircle2, XCircle, Clock, MinusCircle, HelpCircle, Inbox } from "lucide-react";

const WORKFLOW_TYPE = "inbound_email";

const STATUS_META: Record<string, { color: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  passed: { color: "text-emerald-600", icon: CheckCircle2, label: "passed" },
  failed: { color: "text-rose-600", icon: XCircle, label: "failed" },
  pending: { color: "text-amber-600", icon: Clock, label: "pending" },
  skipped: { color: "text-muted-foreground", icon: MinusCircle, label: "skipped" },
  unknown: { color: "text-slate-500", icon: HelpCircle, label: "unknown" },
};

function StatusIcon({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const Icon = meta.icon;
  return <Icon className={`h-4 w-4 ${meta.color}`} />;
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
  return d.toLocaleString();
}

export function EmailWorkflow() {
  const params = useParams();
  const navigate = useNavigate();
  const emailId = params.id!;
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const qc = useQueryClient();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);

  const emailQuery = useQuery({
    queryKey: ["email-messages", "detail", emailId],
    queryFn: () => emailMessagesApi.get(emailId),
    enabled: !!emailId,
  });

  const runsQuery = useQuery({
    queryKey: ["workflow-runs", "by-source", WORKFLOW_TYPE, emailId],
    queryFn: () => workflowRunsApi.listBySource(WORKFLOW_TYPE, emailId, 10),
    enabled: !!emailId,
    refetchInterval: 5_000,
  });

  const runs = runsQuery.data ?? [];
  const activeRunId = selectedRunId ?? runs[0]?.id ?? null;

  const runDetailQuery = useQuery({
    queryKey: ["workflow-runs", "detail", activeRunId],
    queryFn: () => workflowRunsApi.get(activeRunId!),
    enabled: !!activeRunId,
    refetchInterval: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Email Inbox", href: "/email/inbox" },
      { label: emailQuery.data?.subject || "(no subject)" },
      { label: "Workflow" },
    ]);
  }, [setBreadcrumbs, emailQuery.data?.subject]);

  const reRunMutation = useMutation({
    mutationFn: () => workflowRunsApi.run(WORKFLOW_TYPE, emailId),
    onSuccess: (data) => {
      pushToast({ tone: "success", title: "Re-evaluated workflow" });
      setSelectedRunId(data.run.id);
      qc.invalidateQueries({ queryKey: ["workflow-runs", "by-source", WORKFLOW_TYPE, emailId] });
      qc.invalidateQueries({ queryKey: ["workflow-runs", "detail", data.run.id] });
    },
    onError: (err: Error) =>
      pushToast({ tone: "warn", title: "Re-evaluate failed", body: err.message }),
  });

  const stages = runDetailQuery.data?.stages ?? [];
  const selectedStage = useMemo<WorkflowStageResult | null>(() => {
    if (!stages.length) return null;
    if (selectedStageId) {
      const m = stages.find((s) => s.stageId === selectedStageId);
      if (m) return m;
    }
    // Default to first failed > pending > first stage.
    return stages.find((s) => s.status === "failed") ?? stages.find((s) => s.status === "pending") ?? stages[0]!;
  }, [stages, selectedStageId]);

  if (emailQuery.isLoading || runsQuery.isLoading) return <PageSkeleton />;
  const email = emailQuery.data;
  if (!email) return <div className="p-6 text-sm text-muted-foreground">Email not found.</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/email/inbox`)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Inbox
          </Button>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Inbox className="h-5 w-5 text-muted-foreground" />
            {email.subject || "(no subject)"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <RunPicker
            runs={runs}
            value={activeRunId}
            onChange={(id) => {
              setSelectedRunId(id);
              setSelectedStageId(null);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => reRunMutation.mutate()}
            disabled={reRunMutation.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${reRunMutation.isPending ? "animate-spin" : ""}`} />
            Re-evaluate
          </Button>
        </div>
      </div>

      <Card className="p-3 text-xs text-muted-foreground">
        <div><strong>From:</strong> {email.fromAddr}</div>
        <div><strong>To:</strong> {email.toAddrs.join(", ")}</div>
        <div><strong>Account:</strong> {email.accountLabel ?? "(unknown)"}</div>
        <div><strong>State:</strong> {email.processingState}</div>
        {runDetailQuery.data?.run && (
          <div className="pt-1">
            <strong>Run:</strong> {runDetailQuery.data.run.overallStatus} · started {relativeTime(runDetailQuery.data.run.startedAt)}
            {runDetailQuery.data.run.finishedAt && ` · finished ${relativeTime(runDetailQuery.data.run.finishedAt)}`}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
        <Card className="p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            Pipeline
          </div>
          {stages.length === 0 ? (
            <div className="text-sm text-muted-foreground p-3">
              No workflow run yet. Click "Re-evaluate" to run one now.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {stages.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedStageId(s.stageId)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-accent/40 ${selectedStage?.id === s.id ? "bg-accent/60" : ""} ${s.parentStageId ? "pl-8" : s.branch ? "pl-5" : ""}`}
                  >
                    <StatusIcon status={s.status} />
                    {s.branch && (
                      <span className="text-[10px] font-mono px-1 rounded bg-muted text-muted-foreground">
                        {s.branch}
                      </span>
                    )}
                    <span className="flex-1 truncate">{s.label}</span>
                    <span className="text-[11px] text-muted-foreground">{s.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4 min-h-[300px]">
          {selectedStage ? <StageDetail stage={selectedStage} /> : (
            <div className="text-sm text-muted-foreground">Select a stage to inspect.</div>
          )}
        </Card>
      </div>

      {stages.length > 0 && (
        <Card className="p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            Event timeline
          </div>
          <ul className="space-y-1 text-xs font-mono">
            {[...stages]
              .filter((s) => s.status !== "skipped" && s.status !== "unknown")
              .sort((a, b) => new Date(a.computedAt).getTime() - new Date(b.computedAt).getTime())
              .map((s) => (
                <li key={s.id} className="flex gap-3">
                  <span className="text-muted-foreground shrink-0">
                    {new Date(s.computedAt).toLocaleTimeString()}
                  </span>
                  <StatusIcon status={s.status} />
                  <span className="truncate">{s.label}</span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RunPicker({
  runs,
  value,
  onChange,
}: {
  runs: WorkflowRun[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <select
      className="border border-input bg-background rounded-md h-9 px-2 text-sm"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {runs.map((r, i) => (
        <option key={r.id} value={r.id}>
          {i === 0 ? "Latest · " : `Run ${runs.length - i} · `}
          {r.overallStatus} · {relativeTime(r.startedAt)}
        </option>
      ))}
    </select>
  );
}

function StageDetail({ stage }: { stage: WorkflowStageResult }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Stage</div>
        <div className="text-base font-semibold flex items-center gap-2">
          <StatusIcon status={stage.status} />
          {stage.label}
        </div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5">
          {stage.stageId} {stage.branch ? `· branch ${stage.branch}` : ""}
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Expectations</div>
        {stage.expectations.length === 0 ? (
          <div className="text-xs text-muted-foreground">(none defined)</div>
        ) : (
          <ul className="list-disc pl-5 text-xs space-y-0.5">
            {stage.expectations.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Actuals</div>
        <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto">
          {JSON.stringify(stage.actuals, null, 2)}
        </pre>
      </div>

      {stage.errorText && (
        <div>
          <div className="text-xs uppercase tracking-wide text-rose-600 mb-1">Error</div>
          <div className="text-xs text-rose-700 bg-rose-500/10 p-2 rounded">{stage.errorText}</div>
        </div>
      )}

      <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
        Computed {relativeTime(stage.computedAt)}
      </div>
    </div>
  );
}

