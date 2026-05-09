// v3: cross-company ECC conversation view on founder profile.
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { workflowRunsApi, type WorkflowRun } from "../api/workflowRuns";
import { Card } from "@/components/ui/card";
import { MessageSquare, Clock, CheckCircle2 } from "lucide-react";

interface EccConversation {
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
  return `${day}d ago`;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function RunStatusDot({ conversationId }: { conversationId: string }) {
  const runsQuery = useQuery({
    queryKey: ["workflow-runs", "by-source", "ecc_conversation", conversationId],
    queryFn: () => workflowRunsApi.listBySource("ecc_conversation", conversationId, 1),
    staleTime: 30_000,
  });
  const latest: WorkflowRun | undefined = runsQuery.data?.[0];
  if (!latest) return null;
  const colors: Record<string, string> = {
    passed: "bg-emerald-500",
    failed: "bg-rose-500",
    running: "bg-blue-500 animate-pulse",
    partial: "bg-amber-500",
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colors[latest.overallStatus] ?? "bg-slate-400"}`}
      title={`Last run: ${latest.overallStatus}`}
    />
  );
}

export function FounderConversations() {
  const navigate = useNavigate();

  const convsQuery = useQuery({
    queryKey: ["ecc-conversations"],
    queryFn: () => api.get<EccConversation[]>("/ecc/conversations"),
    refetchInterval: 15_000,
  });

  const conversations = convsQuery.data ?? [];

  if (convsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading conversations…</div>;
  }

  if (conversations.length === 0) {
    return (
      <div className="text-center py-12 text-sm text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-30" />
        No active conversations yet. Send a Telegram message to start one.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {conversations.map((conv) => {
        const expiring = daysUntil(conv.expiresAt) <= 3;
        return (
          <Card
            key={conv.id}
            className="p-4 cursor-pointer hover:bg-accent/30 transition-colors"
            onClick={() => navigate(`/workflows?source=${conv.id}`)}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                <RunStatusDot conversationId={conv.id} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">
                    {conv.topicName ?? "(no topic)"}
                  </span>
                  {conv.topicState && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                      {conv.topicState}
                    </span>
                  )}
                  {expiring && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 font-medium">
                      expires in {daysUntil(conv.expiresAt)}d
                    </span>
                  )}
                </div>
                {conv.topicSummary && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                    {conv.topicSummary}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0 text-xs text-muted-foreground space-y-0.5">
                <div className="flex items-center gap-1 justify-end">
                  <MessageSquare className="h-3 w-3" />
                  {conv.messageCount}
                </div>
                <div className="flex items-center gap-1 justify-end">
                  <Clock className="h-3 w-3" />
                  {relativeTime(conv.lastMessageAt)}
                </div>
                <div className="flex items-center gap-1 justify-end text-muted-foreground/60">
                  <CheckCircle2 className="h-3 w-3" />
                  {daysUntil(conv.expiresAt)}d left
                </div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
