// v3: inbox view of processed inbound email for the selected company.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { useToast } from "../context/ToastContext";
import { issuesApi } from "../api/issues";
import { useConfirm } from "../components/ConfirmDialogProvider";
import {
  emailMessagesApi,
  type EmailMessageDetail,
  type EmailMessageSummary,
} from "../api/emailMessages";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FolderSelector, type FolderSelection } from "../components/FolderSelector";
import { StorageSetupBanner } from "../components/StorageSetupBanner";
import {
  Inbox as InboxIcon,
  Link2,
  List,
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
  Bot,
  Users,
  Eye,
  Download,
  FileText,
  FolderOpen,
  RotateCcw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { EmailProcessingLog } from "../components/EmailProcessingLog";
import { FiledCheckDialog } from "../components/EmailProcessingLog";


type MailboxTab = "inbound" | "agent_voice";

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

function BulkActionPanel({
  checkedIds,
  messages,
  companyId,
  companyName,
  isPending,
  onReprocess,
  onClear,
}: {
  checkedIds: Set<string>;
  messages: EmailMessageSummary[];
  companyId: string;
  companyName?: string;
  isPending: boolean;
  onReprocess: () => void;
  onClear: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const selected = messages.filter((m) => checkedIds.has(m.id));

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-3 px-6 py-2 bg-accent/40">
        <span className="text-sm font-medium">{checkedIds.size} selected</span>
        <Button size="sm" onClick={onReprocess} disabled={isPending}>
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          {isPending ? "Reprocessing…" : `Reprocess ${checkedIds.size}`}
        </Button>
        <button
          onClick={() => setLogsOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {logsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Logs
        </button>
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          Clear selection
        </button>
      </div>
      {logsOpen && (
        <div className="max-h-80 overflow-y-auto px-6 py-3 space-y-2 bg-background/60">
          {selected.map((m) => (
            <EmailProcessingLog key={m.id} message={m} companyId={companyId} companyName={companyName} />
          ))}
        </div>
      )}
    </div>
  );
}

export function EmailInbox() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId!;
  const [mailbox, setMailbox] = useState<MailboxTab>("inbound");
  const [stateFilter, setStateFilter] = useState<string>("__all__");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"list" | "by_sender">("list");
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const listPane = useResizable(380, 220, 700);
  const senderPane = useResizable(240, 160, 480);
  const senderEmailPane = useResizable(320, 200, 600);

  useEffect(() => {
    setBreadcrumbs([{ label: "Email Inbox" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: [...queryKeys.emailMessages.list(companyId, stateFilter), mailbox],
    queryFn: () =>
      emailMessagesApi.list(
        companyId,
        stateFilter === "__all__" ? undefined : stateFilter,
        mailbox,
      ),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  const detailQuery = useQuery({
    queryKey: selectedId ? queryKeys.emailMessages.detail(selectedId) : ["email-messages", "detail", "none"],
    queryFn: () => emailMessagesApi.get(selectedId!),
    enabled: !!selectedId,
  });

  const qc = useQueryClient();
  const { pushToast } = useToast();
  const confirm = useConfirm();
  const reprocessMutation = useMutation({
    mutationFn: (id: string) => emailMessagesApi.reprocess(id),
    onMutate: (id) => {
      // Optimistically show "analyzing" so user sees something changed
      qc.setQueryData(queryKeys.emailMessages.detail(id), (old: unknown) => {
        if (!old || typeof old !== "object") return old;
        return { ...old as object, processingState: "analyzing", processedAt: null };
      });
    },
    onSuccess: (_data, id) => {
      pushToast({ tone: "success", title: "Email reprocessed" });
      // Invalidate detail, list, and any filed-check queries for this email
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.detail(id) });
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.list(companyId, stateFilter) });
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.list(companyId, undefined) });
      qc.invalidateQueries({ queryKey: ["filed-check", id] });
    },
    onError: (_err, id) => {
      // Roll back optimistic update
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.detail(id) });
      pushToast({ tone: "warn", title: "Reprocess failed" });
    },
  });

  const bulkReprocessMutation = useMutation({
    mutationFn: (ids: string[]) => emailMessagesApi.bulkReprocess(ids),
    onSuccess: (data) => {
      pushToast({
        tone: data.failed > 0 ? "warn" : "success",
        title: `Reprocessed ${data.reprocessed} email${data.reprocessed !== 1 ? "s" : ""}`,
        body: data.failed > 0 ? `${data.failed} failed` : undefined,
      });
      setCheckedIds(new Set());
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.list(companyId, stateFilter) });
      qc.invalidateQueries({ queryKey: queryKeys.emailMessages.list(companyId, undefined) });
      // Invalidate all detail queries so processing logs refresh
      qc.invalidateQueries({ queryKey: ["email-messages", "detail"] });
      qc.invalidateQueries({ queryKey: ["filed-check"] });
    },
    onError: (err: Error) =>
      pushToast({ tone: "warn", title: "Bulk reprocess failed", body: err.message }),
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

  const senderGroups = useMemo<SenderGroup[]>(() => {
    const map = new Map<string, SenderGroup>();
    for (const m of messages) {
      const key = m.fromAddr || "(no sender)";
      if (!map.has(key)) {
        map.set(key, { addr: key, emails: [], lastDate: m.receivedAt, hasPending: false, hasError: false });
      }
      const g = map.get(key)!;
      g.emails.push(m);
      if (new Date(m.receivedAt) > new Date(g.lastDate)) g.lastDate = m.receivedAt;
      if (m.processingState === "pending" || m.processingState === "analyzing") g.hasPending = true;
      if (m.processingState === "error") g.hasError = true;
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime(),
    );
  }, [messages]);

  const senderMessages = selectedSender
    ? messages.filter((m) => (m.fromAddr || "(no sender)") === selectedSender)
    : [];

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (listQuery.isLoading) return <PageSkeleton />;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between p-6 pb-3 border-b border-border">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <InboxIcon className="h-6 w-6" />
            Email Inbox
            {selectedCompany && (
              <span className="text-sm font-normal text-muted-foreground">· {selectedCompany.name}</span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mailbox === "inbound"
              ? "Client messages captured by the IMAP monitor."
              : "Agent voice messages — questions sent and replies received."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            <button
              onClick={() => { setMailbox("inbound"); setSelectedId(null); setStateFilter("__all__"); setSelectedSender(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                mailbox === "inbound"
                  ? "bg-foreground/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Client Mail
            </button>
            <button
              onClick={() => { setMailbox("agent_voice"); setSelectedId(null); setStateFilter("__all__"); setSelectedSender(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 border-l border-border transition-colors ${
                mailbox === "agent_voice"
                  ? "bg-foreground/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              }`}
            >
              <Bot className="h-3.5 w-3.5" />
              Agent Mail
            </button>
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            <button
              onClick={() => { setViewMode("list"); setSelectedSender(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                viewMode === "list"
                  ? "bg-foreground/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              }`}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
              List
            </button>
            <button
              onClick={() => { setViewMode("by_sender"); setSelectedId(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 border-l border-border transition-colors ${
                viewMode === "by_sender"
                  ? "bg-foreground/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              }`}
              title="By sender"
            >
              <Users className="h-3.5 w-3.5" />
              By Sender
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-6 py-3 border-b border-border flex-wrap">
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
        <div className="ml-auto">
          <Input
            placeholder="Search subject, sender, body…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm w-64"
          />
        </div>
      </div>

      {checkedIds.size > 0 && (
        <BulkActionPanel
          checkedIds={checkedIds}
          messages={messages}
          companyId={companyId}
          companyName={selectedCompany?.name}
          isPending={bulkReprocessMutation.isPending}
          onReprocess={() => bulkReprocessMutation.mutate(Array.from(checkedIds))}
          onClear={() => setCheckedIds(new Set())}
        />
      )}

      <div className="px-6 pt-3">
        <StorageSetupBanner companyId={companyId} />
      </div>

      {viewMode === "list" ? (
        /* ── LIST VIEW ─────────────────────────────────────────────────── */
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
          <div
            className={`min-h-0 overflow-y-auto ${selectedId ? "hidden sm:block shrink-0 border-r border-border" : "flex-1"}`}
            style={selectedId ? { width: listPane.width } : undefined}
          >
            {messages.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                <Mail className="h-10 w-10 mx-auto mb-3 opacity-40" />
                No messages {stateFilter !== "__all__" ? `in ${stateFilter}` : ""}.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                <li className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border sticky top-0 z-10">
                  <input
                    type="checkbox"
                    checked={messages.length > 0 && messages.every((m) => checkedIds.has(m.id))}
                    ref={(el) => {
                      if (el) el.indeterminate = checkedIds.size > 0 && !messages.every((m) => checkedIds.has(m.id));
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setCheckedIds(new Set(messages.map((m) => m.id)));
                      } else {
                        setCheckedIds(new Set());
                      }
                    }}
                    className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                  />
                  <span className="text-xs text-muted-foreground">
                    {checkedIds.size > 0 ? `${checkedIds.size} of ${messages.length} selected` : `${messages.length} email${messages.length !== 1 ? "s" : ""}`}
                  </span>
                </li>
                {messages.map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    selected={m.id === selectedId}
                    checked={checkedIds.has(m.id)}
                    onCheck={(id, on) => {
                      setCheckedIds((prev) => {
                        const next = new Set(prev);
                        on ? next.add(id) : next.delete(id);
                        return next;
                      });
                    }}
                    onClick={() => setSelectedId(m.id)}
                  />
                ))}
              </ul>
            )}
          </div>

          {selectedId && (
            <>
              <ResizeHandle onMouseDown={listPane.onMouseDown} />
              <div className="flex-1 min-h-0 overflow-y-auto bg-muted/20">
                <MessageDetail
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
                          <p>This permanently removes the email and everything derived from it:</p>
                          <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                            <li>Plans, approvals, decision tokens</li>
                            <li>Workflow runs + stage results</li>
                            <li>Wakeup requests for the triage agent</li>
                            <li>Linked triage issue + its comments (if no other email points to it)</li>
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
                  companyId={companyId}
                  companyName={selectedCompany?.name}
                />
              </div>
            </>
          )}
        </div>
      ) : (
        /* ── BY SENDER VIEW ─────────────────────────────────────────────── */
        <div className="flex-1 min-h-0 flex flex-row">
          {/* Sender list */}
          <div
            className={`min-h-0 overflow-y-auto ${selectedSender ? "hidden sm:flex sm:flex-col shrink-0" : "flex-1 sm:flex-none shrink-0"}`}
            style={selectedSender ? { width: senderPane.width } : undefined}
          >
            {senderGroups.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
                No senders {stateFilter !== "__all__" ? `in ${stateFilter}` : ""}.
              </div>
            ) : (
              <>
                <div className="px-3 py-2 bg-muted/30 border-b border-border sticky top-0 z-10">
                  <span className="text-xs text-muted-foreground">{senderGroups.length} sender{senderGroups.length !== 1 ? "s" : ""}</span>
                </div>
                <ul className="divide-y divide-border">
                  {senderGroups.map((g) => (
                    <SenderRow
                      key={g.addr}
                      group={g}
                      selected={g.addr === selectedSender}
                      onClick={() => { setSelectedSender(g.addr); setSelectedId(null); }}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* Email list for selected sender */}
          {selectedSender && (
            <>
              <ResizeHandle onMouseDown={senderPane.onMouseDown} />
            <div
              className={`min-h-0 overflow-y-auto ${selectedId ? "hidden sm:flex sm:flex-col shrink-0" : "flex-1"}`}
              style={selectedId ? { width: senderEmailPane.width } : undefined}
            >
              <div className="px-3 py-2 bg-muted/30 border-b border-border sticky top-0 z-10 flex items-center gap-2">
                <button
                  className="sm:hidden text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedSender(null)}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div
                  className="h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-semibold text-white shrink-0"
                  style={{ backgroundColor: senderColor(selectedSender) }}
                >
                  {senderInitials(selectedSender)}
                </div>
                <span className="text-xs text-muted-foreground truncate flex-1">{selectedSender}</span>
                <span className="text-xs text-muted-foreground shrink-0">{senderMessages.length}</span>
              </div>
              {senderMessages.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">No emails.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {senderMessages.map((m) => (
                    <MessageRow
                      key={m.id}
                      message={m}
                      selected={m.id === selectedId}
                      checked={checkedIds.has(m.id)}
                      onCheck={(id, on) => {
                        setCheckedIds((prev) => {
                          const next = new Set(prev);
                          on ? next.add(id) : next.delete(id);
                          return next;
                        });
                      }}
                      onClick={() => setSelectedId(m.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
            </>
          )}

          {/* Detail panel */}
          {selectedId && (
            <>
              <ResizeHandle onMouseDown={senderEmailPane.onMouseDown} />
              <div className="flex-1 min-h-0 overflow-y-auto bg-muted/20">
              <MessageDetail
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
                        <p>This permanently removes the email and everything derived from it:</p>
                        <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                          <li>Plans, approvals, decision tokens</li>
                          <li>Workflow runs + stage results</li>
                          <li>Wakeup requests for the triage agent</li>
                          <li>Linked triage issue + its comments (if no other email points to it)</li>
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
                companyId={companyId}
                companyName={selectedCompany?.name}
              />
            </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function useResizable(defaultWidth: number, min: number, max: number) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.max(min, Math.min(max, startWidth.current + ev.clientX - startX.current));
      setWidth(next);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [width, min, max]);

  return { width, onMouseDown };
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 hover:bg-primary/40 active:bg-primary/60 cursor-col-resize transition-colors group relative z-10 border-r border-border"
      title="Drag to resize"
    />
  );
}

// Deterministic pastel color from email string
function senderColor(addr: string): string {
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) & 0xffff;
  const hue = h % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

function senderInitials(addr: string): string {
  const local = addr.split("@")[0] ?? addr;
  const parts = local.split(/[._\-+]/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

interface SenderGroup {
  addr: string;
  emails: EmailMessageSummary[];
  lastDate: string;
  hasPending: boolean;
  hasError: boolean;
}

function SenderRow({
  group,
  selected,
  onClick,
}: {
  group: SenderGroup;
  selected: boolean;
  onClick: () => void;
}) {
  const color = senderColor(group.addr);
  const initials = senderInitials(group.addr);
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 transition-colors ${selected ? "bg-accent/60" : ""}`}
      >
        <div
          className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0"
          style={{ backgroundColor: color }}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-sm font-medium truncate">{group.addr}</span>
            <span className="text-xs text-muted-foreground shrink-0">{relativeTime(group.lastDate)}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-muted-foreground">{group.emails.length} email{group.emails.length !== 1 ? "s" : ""}</span>
            {group.hasError && (
              <span className="text-[10px] px-1.5 py-0 rounded-full bg-rose-500/15 text-rose-400">error</span>
            )}
            {group.hasPending && !group.hasError && (
              <span className="text-[10px] px-1.5 py-0 rounded-full bg-amber-500/15 text-amber-400">pending</span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function MessageRow({
  message,
  selected,
  checked,
  onCheck,
  onClick,
}: {
  message: EmailMessageSummary;
  selected: boolean;
  checked: boolean;
  onCheck: (id: string, on: boolean) => void;
  onClick: () => void;
}) {
  const hasAttachment = !!message.attachmentsPath;
  return (
    <li>
      <div className={`flex items-stretch hover:bg-accent/40 transition-colors ${selected ? "bg-accent/60" : ""}`}>
        <label
          className="flex items-center px-3 cursor-pointer shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(message.id, e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
          />
        </label>
        <button
          onClick={onClick}
          className="flex-1 min-w-0 text-left py-4 pr-4"
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
      </div>
    </li>
  );
}

function AttachmentRow({ messageId, att, companyId }: {
  messageId: string;
  att: EmailMessageDetail["attachments"][0];
  companyId: string;
}) {
  const [open, setOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const qc = useQueryClient();
  const isImage = att.contentType.startsWith("image/");
  const isPdf = att.contentType === "application/pdf";
  const canPreview = isImage || isPdf;
  const previewUrl = emailMessagesApi.attachmentUrl(messageId, att.id, true);
  const downloadUrl = emailMessagesApi.attachmentUrl(messageId, att.id, false);

  const fileMutation = useMutation({
    mutationFn: (opts: { driveFolderId?: string; localPath?: string; clientId?: string }) =>
      emailMessagesApi.fileAttachment(messageId, att.id, opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-message", messageId] });
      setFileOpen(false);
    },
  });

  function handleFolderSelect(sel: FolderSelection) {
    if (sel.type === "source") {
      if (sel.source.driveFolderId) fileMutation.mutate({ driveFolderId: sel.source.driveFolderId });
      else if (sel.source.localPath) fileMutation.mutate({ localPath: sel.source.localPath });
    } else if (sel.type === "drive") {
      fileMutation.mutate({ driveFolderId: sel.folderId });
    } else {
      fileMutation.mutate({ localPath: sel.path });
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-sm">
        <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1 truncate">{att.filename}</span>
        <span className="text-xs text-muted-foreground shrink-0">{formatBytes(att.sizeBytes)}</span>
        {/* Filed indicator */}
        {att.filedAt ? (
          <button
            className="flex items-center gap-1 text-[11px] text-green-400 hover:text-green-300 shrink-0 transition-colors"
            onClick={() => setCheckOpen(true)}
            title="Click to verify filed location"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />Filed
          </button>
        ) : (
          <button
            className="text-[11px] text-muted-foreground/60 hover:text-foreground shrink-0 flex items-center gap-1 transition-colors"
            onClick={() => setFileOpen(true)}
          >
            <FolderOpen className="h-3.5 w-3.5" />File
          </button>
        )}
        {canPreview && (
          <button
            className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
            onClick={() => setOpen(true)}
          >
            <Eye className="h-3.5 w-3.5" />Preview
          </button>
        )}
        <a href={downloadUrl} download className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 shrink-0">
          <Download className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* File dialog */}
      <Dialog open={fileOpen} onOpenChange={setFileOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-amber-400" />
              File "{att.filename}"
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <FolderSelector companyId={companyId} onSelect={handleFolderSelect} />
            {fileMutation.isPending && (
              <p className="text-xs text-muted-foreground">Filing…</p>
            )}
            {fileMutation.isError && (
              <p className="text-xs text-destructive">
                {fileMutation.error instanceof Error ? fileMutation.error.message : "Failed to file"}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex flex-col p-0 gap-0"
          style={{ width: "95vw", maxWidth: "95vw", height: "95vh" }}
        >
          <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
            <DialogTitle className="text-sm truncate flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
              {att.filename}
              <span className="text-xs text-muted-foreground font-normal ml-1">{formatBytes(att.sizeBytes)}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {isImage && (
              <div className="flex items-center justify-center h-full bg-muted/20 p-4">
                <img
                  src={previewUrl}
                  alt={att.filename}
                  className="max-h-full max-w-full object-contain rounded"
                />
              </div>
            )}
            {isPdf && (
              <iframe
                src={`${previewUrl}#zoom=100`}
                title={att.filename}
                className="w-full h-full border-0"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Filed-check dialog */}
      {checkOpen && (
        <FiledCheckDialog
          messageId={messageId}
          attachmentId={att.id}
          filename={att.filename}
          onClose={() => setCheckOpen(false)}
        />
      )}
    </>
  );
}

function EmailBodyRenderer({ messageId, plainBody }: { messageId: string; plainBody: string }) {
  const isDark = document.documentElement.classList.contains("dark");
  const { data, isLoading } = useQuery({
    queryKey: ["email-html", messageId],
    queryFn: () => emailMessagesApi.getHtml(messageId),
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleIframeLoad = () => {
    const frame = iframeRef.current;
    if (!frame?.contentDocument?.body) return;
    frame.style.height = `${frame.contentDocument.body.scrollHeight + 32}px`;
  };

  if (isLoading) {
    return <Card className="p-4"><p className="text-xs text-muted-foreground">Loading...</p></Card>;
  }

  if (data?.html) {
    const bg = isDark ? "#141414" : "#ffffff";
    const fg = isDark ? "#e5e5e5" : "#111111";
    const link = isDark ? "#60a5fa" : "#2563eb";
    const overrides = isDark
      ? "html { background: #141414 !important; } body { background: #141414 !important; color: #e5e5e5; } table, td, th { background-color: transparent !important; }"
      : "";
    const injected = `<style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: ${fg}; margin: 0; padding: 16px; word-break: break-word; }
      a { color: ${link}; } img { max-width: 100%; height: auto; }
      ${overrides}
    </style>`;
    const srcDoc = `<!DOCTYPE html><html><head>${injected}</head><body>${data.html}</body></html>`;
    return (
      <Card className="overflow-hidden" style={{ background: bg }}>
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-same-origin"
          title="Email body"
          className="w-full min-h-32 border-0"
          style={{ height: "400px", background: bg }}
          onLoad={handleIframeLoad}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4 bg-muted/30">
      <pre className="text-sm whitespace-pre-wrap break-words font-sans text-foreground">{plainBody || "(empty body)"}</pre>
    </Card>
  );
}

function MessageDetail({
  detail,
  loading,
  onBack,
  onReprocess,
  reprocessing,
  onDelete,
  deleting,
  companyId,
  companyName,
}: {
  detail: EmailMessageDetail | null;
  loading: boolean;
  onBack: () => void;
  onReprocess: (id: string) => void;
  reprocessing: boolean;
  onDelete: (id: string) => void;
  deleting: boolean;
  companyId: string;
  companyName?: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [linkOpen, setLinkOpen] = useState(false);
  const [issueSearch, setIssueSearch] = useState("");

  const issuesQuery = useQuery({
    queryKey: ["issues", "list", companyId],
    queryFn: () => issuesApi.list(companyId),
    enabled: linkOpen,
  });

  const linkMutation = useMutation({
    mutationFn: ({ id, issueId }: { id: string; issueId: string | null }) =>
      emailMessagesApi.linkToIssue(id, issueId),
    onSuccess: (_data, vars) => {
      pushToast({ tone: "success", title: vars.issueId ? "Linked to issue" : "Issue link removed" });
      qc.invalidateQueries({ queryKey: ["email-messages", "detail", vars.id] });
      setLinkOpen(false);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Failed", body: err.message }),
  });

  if (loading || !detail) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const filteredIssues = (issuesQuery.data ?? [])
    .filter((issue) => {
      if (!issueSearch.trim()) return true;
      const q = issueSearch.toLowerCase();
      return (
        issue.title.toLowerCase().includes(q) ||
        (issue.identifier ?? "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      // Sort by identifier number descending (DEV-87 before DEV-86)
      const numA = parseInt((a.identifier ?? "").replace(/\D/g, "") || "0", 10);
      const numB = parseInt((b.identifier ?? "").replace(/\D/g, "") || "0", 10);
      return numB - numA;
    })
    .slice(0, 100);

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
            onClick={() => { setIssueSearch(""); setLinkOpen(true); }}
          >
            <Link2 className="h-3.5 w-3.5 mr-1" />
            {detail.issueId ? "Re-link Issue" : "Link to Issue"}
          </Button>
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

      <EmailProcessingLog message={detail} companyId={companyId} companyName={companyName} />

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

      {detail.attachments.filter((a) => !a.isInline).length > 0 && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Attachments ({detail.attachments.filter((a) => !a.isInline).length})
          </h3>
          <div className="flex flex-col gap-1.5">
            {detail.attachments.filter((a) => !a.isInline).map((a) => (
              <AttachmentRow key={a.id} messageId={detail.id} att={a} companyId={companyId} />
            ))}
          </div>
        </div>
      )}

      <EmailBodyRenderer messageId={detail.id} plainBody={detail.body} />

      {(detail.issueId || detail.approvalId) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {detail.issueId && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              Linked to issue{" "}
              <Link
                to={`/issues/${detail.issueId}`}
                className="font-mono hover:underline text-foreground"
              >
                {detail.issueId.slice(0, 8)}
              </Link>
              <button
                className="ml-1 text-muted-foreground/60 hover:text-destructive transition-colors"
                title="Remove link"
                onClick={() => linkMutation.mutate({ id: detail.id, issueId: null })}
                disabled={linkMutation.isPending}
              >
                ×
              </button>
            </span>
          )}
          {detail.approvalId && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Approval {detail.approvalId.slice(0, 8)}
            </span>
          )}
        </div>
      )}

      {/* Link to Issue dialog */}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              Link email to issue
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search issues…"
              value={issueSearch}
              onChange={(e) => setIssueSearch(e.target.value)}
              className="h-8 text-sm"
              autoFocus
            />
            <div className="max-h-72 overflow-y-auto divide-y divide-border rounded-md border border-border">
              {issuesQuery.isLoading ? (
                <p className="p-3 text-xs text-muted-foreground">Loading…</p>
              ) : filteredIssues.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">No issues found.</p>
              ) : (
                filteredIssues.map((issue) => (
                  <button
                    key={issue.id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent/40 transition-colors flex items-center gap-2"
                    onClick={() => linkMutation.mutate({ id: detail.id, issueId: issue.id })}
                    disabled={linkMutation.isPending}
                  >
                    <span className="font-mono text-xs text-muted-foreground shrink-0 w-14">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${STATE_COLORS[issue.status] ?? "bg-muted text-muted-foreground"}`}
                    >
                      {issue.status}
                    </span>
                    <span className="truncate">{issue.title}</span>
                  </button>
                ))
              )}
            </div>
            {linkMutation.isPending && (
              <p className="text-xs text-muted-foreground">Saving…</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
