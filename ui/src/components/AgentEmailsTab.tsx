// v3: emails tab on the agent detail page — inbox (received) and sent (matched inbound) toggle.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useToast } from "../context/ToastContext";
import { useConfirm } from "./ConfirmDialogProvider";
import {
  emailMessagesApi,
  type EmailMessageDetail,
  type EmailMessageSummary,
} from "../api/emailMessages";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Mail,
  Paperclip,
  RefreshCw,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Activity,
  Trash2,
  Inbox,
  Send,
} from "lucide-react";

type Direction = "received" | "sent";

const STATE_FILTERS = [
  { key: "__all__", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "analyzing", label: "Analyzing" },
  { key: "plan_proposed", label: "Plan proposed" },
  { key: "executed", label: "Executed" },
  { key: "ignored", label: "Ignored" },
  { key: "error", label: "Error" },
] as const;

const STATE_COLORS: Record<string, string> = {
  pending: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  analyzing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  plan_proposed: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  clarifying: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  declined: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  executed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  ignored: "bg-muted text-muted-foreground",
  error: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AgentEmailsTab({
  agentId,
  companyId,
}: {
  agentId: string;
  companyId: string;
}) {
  const [direction, setDirection] = useState<Direction>("received");
  const [stateFilter, setStateFilter] = useState<string>("__all__");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const confirm = useConfirm();

  // Received = replies from clients arriving in agent_voice inbox
  // Sent     = inbound client emails matched to this agent (emails agent triaged/responded to)
  const listQuery = useQuery({
    queryKey: [
      ...queryKeys.emailMessages.list(companyId, stateFilter),
      "agent-emails",
      direction,
      agentId,
    ],
    queryFn: () =>
      direction === "received"
        ? emailMessagesApi.list(
            companyId,
            stateFilter === "__all__" ? undefined : stateFilter,
            "agent_voice",
          )
        : emailMessagesApi.list(
            companyId,
            stateFilter === "__all__" ? undefined : stateFilter,
            "inbound",
            agentId,
          ),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  const detailQuery = useQuery({
    queryKey: selectedId
      ? queryKeys.emailMessages.detail(selectedId)
      : ["email-messages", "detail", "none"],
    queryFn: () => emailMessagesApi.get(selectedId!),
    enabled: !!selectedId,
  });

  const reprocessMutation = useMutation({
    mutationFn: (id: string) => emailMessagesApi.reprocess(id),
    onSuccess: (_data, id) => {
      pushToast({ tone: "success", title: "Email reprocessed" });
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.detail(id) });
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.list(companyId, stateFilter) });
    },
    onError: (err: Error) =>
      pushToast({ tone: "warn", title: "Reprocess failed", body: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => emailMessagesApi.remove(id),
    onSuccess: (data, id) => {
      pushToast({
        tone: "success",
        title: "Deleted email + history",
        body: `plans=${data.deletedPlans} runs=${data.deletedWorkflowRuns} issue=${data.deletedIssue ? "yes" : "no"}`,
      });
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.list(companyId, stateFilter) });
    },
    onError: (err: Error) =>
      pushToast({ tone: "warn", title: "Delete failed", body: err.message }),
  });

  const messages = (listQuery.data ?? []).filter((m) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      m.subject.toLowerCase().includes(q) ||
      m.fromAddr.toLowerCase().includes(q) ||
      m.body.toLowerCase().includes(q)
    );
  });

  function switchDirection(d: Direction) {
    setDirection(d);
    setSelectedId(null);
    setStateFilter("__all__");
  }

  return (
    <div className="flex flex-col min-h-0" style={{ height: "calc(100vh - 220px)" }}>
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          <button
            onClick={() => switchDirection("received")}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              direction === "received"
                ? "bg-foreground/10 text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            }`}
          >
            <Inbox className="h-3.5 w-3.5" />
            Received
          </button>
          <button
            onClick={() => switchDirection("sent")}
            className={`flex items-center gap-1.5 px-3 py-1.5 border-l border-border transition-colors ${
              direction === "sent"
                ? "bg-foreground/10 text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            }`}
          >
            <Send className="h-3.5 w-3.5" />
            Sent
          </button>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {direction === "received"
              ? "Replies received on the agent voice inbox"
              : "Client emails this agent was assigned to handle"}
          </p>
          <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 py-3 border-b border-border flex-wrap">
        {STATE_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStateFilter(f.key)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              stateFilter === f.key
                ? "border-foreground/40 bg-foreground/10"
                : "border-border hover:border-foreground/30"
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto w-64">
          <Input
            placeholder="Search subject, sender, body…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden">
        <div
          className={`flex-1 min-h-0 overflow-y-auto ${
            selectedId ? "hidden sm:block sm:max-w-md sm:border-r sm:border-border" : ""
          }`}
        >
          {listQuery.isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <Mail className="h-10 w-10 mx-auto mb-3 opacity-40" />
              No messages {stateFilter !== "__all__" ? `in ${stateFilter}` : ""}.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {messages.map((m) => (
                <AgentEmailRow
                  key={m.id}
                  message={m}
                  selected={m.id === selectedId}
                  onClick={() => setSelectedId(m.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {selectedId && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-muted/20">
            <AgentEmailDetail
              detail={detailQuery.data ?? null}
              loading={detailQuery.isLoading}
              onBack={() => setSelectedId(null)}
              onReprocess={(id) => reprocessMutation.mutate(id)}
              reprocessing={reprocessMutation.isPending}
              onDelete={async (id) => {
                const ok = await confirm({
                  title: "Delete email + history?",
                  body: (
                    <div className="space-y-2 text-sm">
                      <p>Permanently removes the email and all derived data:</p>
                      <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                        <li>Plans, approvals, decision tokens</li>
                        <li>Workflow runs + stage results</li>
                        <li>Wakeup requests</li>
                        <li>Linked triage issue + comments (if no other email references it)</li>
                        <li>Email attachments on disk</li>
                      </ul>
                      <p className="text-destructive">This cannot be undone.</p>
                    </div>
                  ),
                  confirmLabel: "Delete email",
                  danger: true,
                });
                if (ok) deleteMutation.mutate(id);
              }}
              deleting={deleteMutation.isPending}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AgentEmailRow({
  message,
  selected,
  onClick,
}: {
  message: EmailMessageSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const hasAttachment = !!message.attachmentsPath;
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left p-4 hover:bg-accent/40 transition-colors ${selected ? "bg-accent/60" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{message.fromAddr || "(no sender)"}</span>
          <span className="text-xs text-muted-foreground shrink-0">{relativeTime(message.receivedAt)}</span>
        </div>
        <div className="text-sm truncate mt-0.5">{message.subject || "(no subject)"}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {message.body.replace(/\s+/g, " ").slice(0, 140)}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ${STATE_COLORS[message.processingState] ?? "bg-muted text-muted-foreground"}`}
          >
            {message.processingState}
          </span>
          {message.accountLabel && (
            <span className="text-[11px] text-muted-foreground">via {message.accountLabel}</span>
          )}
          {hasAttachment && <Paperclip className="h-3 w-3 text-muted-foreground" />}
          {message.errorText && <AlertCircle className="h-3 w-3 text-destructive" />}
        </div>
      </button>
    </li>
  );
}

function AgentEmailDetail({
  detail,
  loading,
  onBack,
  onReprocess,
  reprocessing,
  onDelete,
  deleting,
}: {
  detail: EmailMessageDetail | null;
  loading: boolean;
  onBack: () => void;
  onReprocess: (id: string) => void;
  reprocessing: boolean;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const navigate = useNavigate();
  if (loading || !detail) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="sm:hidden">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/email/inbox/${detail.id}/workflow`)}
          >
            <Activity className="h-3.5 w-3.5 mr-1" />
            Workflow
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReprocess(detail.id)}
            disabled={reprocessing}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${reprocessing ? "animate-spin" : ""}`} />
            Reprocess
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDelete(detail.id)}
            disabled={deleting}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${STATE_COLORS[detail.processingState] ?? "bg-muted text-muted-foreground"}`}
          >
            {detail.processingState}
          </span>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold leading-tight">{detail.subject || "(no subject)"}</h2>
        <div className="text-sm text-muted-foreground mt-1">
          From <span className="font-mono">{detail.fromAddr}</span>
        </div>
        <div className="text-sm text-muted-foreground">
          To <span className="font-mono">{detail.toAddrs.join(", ")}</span>
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
          <Clock className="h-3 w-3" />
          {new Date(detail.receivedAt).toLocaleString()}
          {detail.accountLabel && <span className="ml-2">via {detail.accountLabel}</span>}
        </div>
      </div>

      {detail.errorText && (
        <Card className="p-3 border-destructive/40 bg-destructive/5 text-sm text-destructive flex items-start gap-2">
          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{detail.errorText}</span>
        </Card>
      )}

      {detail.attachments.length > 0 && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            Attachments ({detail.attachments.length})
          </h3>
          <div className="flex flex-col gap-1.5">
            {detail.attachments.map((a) => (
              <a
                key={a.id}
                href={emailMessagesApi.attachmentUrl(detail.id, a.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-sm hover:border-foreground/30"
              >
                <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="flex-1 truncate">{a.filename}</span>
                <span className="text-xs text-muted-foreground shrink-0">{formatBytes(a.sizeBytes)}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      <Card className="p-4">
        <pre className="text-sm whitespace-pre-wrap break-words font-sans">{detail.body || "(empty body)"}</pre>
      </Card>

      {(detail.issueId || detail.approvalId) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {detail.issueId && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Linked to issue {detail.issueId.slice(0, 8)}
            </span>
          )}
          {detail.approvalId && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Approval {detail.approvalId.slice(0, 8)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
