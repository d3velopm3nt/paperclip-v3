// v3: messages list for a single EA conversation — one row per workflow run (message turn).
import { useParams, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { workflowRunsApi, type WorkflowRun } from "../api/workflowRuns";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "../components/PageSkeleton";
import { ArrowLeft, CheckCircle2, XCircle, Clock, Activity, MessageSquare } from "lucide-react";

interface EaConversationDetail {
  id: string;
  topicId: string;
  topicName: string | null;
  companyId: string | null;
  topicState: string | null;
  topicSummary: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string;
  expiresAt: string;
}

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  passed: CheckCircle2,
  failed: XCircle,
  running: Activity,
  partial: Clock,
};

const STATUS_COLORS: Record<string, string> = {
  passed: "text-emerald-600",
  failed: "text-rose-600",
  running: "text-blue-600",
  partial: "text-amber-600",
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
  return d.toLocaleString();
}

function durationMs(run: WorkflowRun): string | null {
  if (!run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RunRow({ run, index, total, onClick }: { run: WorkflowRun; index: number; total: number; onClick: () => void }) {
  const Icon = STATUS_ICONS[run.overallStatus] ?? Clock;
  const color = STATUS_COLORS[run.overallStatus] ?? "text-muted-foreground";
  const dur = durationMs(run);

  // Fetch stages to get action summary
  const stagesQuery = useQuery({
    queryKey: ["workflow-runs", "detail", run.id],
    queryFn: () => workflowRunsApi.get(run.id),
    staleTime: 60_000,
  });
  const actionStage = stagesQuery.data?.stages.find((s) => s.stageId === "action_taken");
  const actionSummary = actionStage?.actuals && typeof (actionStage.actuals as Record<string, unknown>).actionSummary === "string"
    ? (actionStage.actuals as Record<string, unknown>).actionSummary as string
    : null;
  const msgPreview = stagesQuery.data?.stages.find((s) => s.stageId === "message_received")
    ?.actuals && typeof ((stagesQuery.data?.stages.find((s) => s.stageId === "message_received")?.actuals) as Record<string, unknown>)?.messagePreview === "string"
    ? ((stagesQuery.data?.stages.find((s) => s.stageId === "message_received")?.actuals) as Record<string, unknown>)?.messagePreview as string
    : null;

  return (
    <Card
      className="p-3 cursor-pointer hover:bg-accent/30 transition-colors"
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${color}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">
              Turn {total - index}
            </span>
            <span className={`text-xs ${color}`}>{run.overallStatus}</span>
            {dur && <span className="text-xs text-muted-foreground">{dur}</span>}
          </div>
          {msgPreview && (
            <p className="text-sm mt-0.5 line-clamp-1 text-foreground">{msgPreview}</p>
          )}
          {actionSummary && (
            <p className="text-xs mt-0.5 text-muted-foreground line-clamp-1">↳ {actionSummary}</p>
          )}
          {!msgPreview && !actionSummary && !stagesQuery.isLoading && (
            <p className="text-xs mt-0.5 text-muted-foreground">(no summary)</p>
          )}
        </div>
        <div className="text-xs text-muted-foreground shrink-0 text-right">
          {relativeTime(run.startedAt)}
        </div>
      </div>
    </Card>
  );
}

export function FounderConversationDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const convId = params.convId!;

  const convQuery = useQuery({
    queryKey: ["ea-conversations", convId],
    queryFn: () => api.get<EaConversationDetail>(`/ea/conversations/${convId}`),
  });

  const runsQuery = useQuery({
    queryKey: ["workflow-runs", "by-source", "ea_conversation", convId],
    queryFn: () => workflowRunsApi.listBySource("ea_conversation", convId, 50),
    refetchInterval: 10_000,
  });

  const conv = convQuery.data;
  const runs = runsQuery.data ?? [];

  if (convQuery.isLoading) return <PageSkeleton />;
  if (!conv) return <div className="p-6 text-sm text-muted-foreground">Conversation not found.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate("/founder/conversations")}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Conversations
        </Button>
        <div>
          <h2 className="text-lg font-semibold">{conv.topicName ?? "(no topic)"}</h2>
          {conv.topicState && (
            <span className="text-xs text-muted-foreground font-mono">{conv.topicState}</span>
          )}
        </div>
      </div>

      {conv.topicSummary && (
        <Card className="p-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground mb-1">Topic memory</div>
          <p className="whitespace-pre-wrap line-clamp-4">{conv.topicSummary}</p>
        </Card>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquare className="h-3.5 w-3.5" />
        {runs.length} message{runs.length !== 1 ? "s" : ""}
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">No messages yet.</div>
      ) : (
        <div className="space-y-2">
          {runs.map((run, i) => (
            <RunRow
              key={run.id}
              run={run}
              index={i}
              total={runs.length}
              onClick={() => navigate(`/workflows/run/${run.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
