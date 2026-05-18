// v3: cross-company EA conversation list on founder profile.
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Card } from "@/components/ui/card";
import { MessageSquare, CheckCircle2, Clock, XCircle, Activity, Loader2, ArrowRight, Inbox, X } from "lucide-react";

interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

interface EaConversation {
  id: string;
  topicId: string;
  topicName: string | null;
  companyId: string | null;
  companyName: string | null;
  topicState: string | null;
  topicSummary: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string;
  expiresAt: string;
  linkedIssues: LinkedIssue[];
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
}

export interface InboundMessage {
  id: string;
  platform: string;
  body: string;
  rawPayload: {
    identifyStatus?: "identifying" | "identified" | "inbox";
    topicId?: string;
    topicName?: string | null;
    workflowRunId?: string | null;
    eaAgentId?: string | null;
  } | null;
  createdAt: string;
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

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  active: CheckCircle2,
  extended: CheckCircle2,
  expired: XCircle,
  running: Activity,
};
const STATUS_COLOR: Record<string, string> = {
  active: "text-emerald-600",
  extended: "text-emerald-600",
  expired: "text-muted-foreground",
  running: "text-blue-600",
};

function Badge({ label, tone = "default" }: { label: string; tone?: "default" | "blue" | "green" | "amber" | "violet" }) {
  const colors: Record<string, string> = {
    default: "bg-muted text-muted-foreground",
    blue: "bg-blue-500/10 text-blue-700",
    green: "bg-emerald-500/10 text-emerald-700",
    amber: "bg-amber-500/10 text-amber-700",
    violet: "bg-violet-500/10 text-violet-700",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[tone]}`}>
      {label}
    </span>
  );
}

function InboundStatusBadge({ msg }: { msg: InboundMessage }) {
  const status = msg.rawPayload?.identifyStatus;
  if (!status || status === "identifying") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 font-medium">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Identifying…
      </span>
    );
  }
  if (status === "identified" && msg.rawPayload?.topicName) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 font-medium">
        <ArrowRight className="h-2.5 w-2.5" />
        {msg.rawPayload.topicName}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
      <Inbox className="h-2.5 w-2.5" />
      Inbox
    </span>
  );
}

export function IncomingMessages({ onMessageClick }: { onMessageClick?: (msg: InboundMessage) => void } = {}) {
  const qc = useQueryClient();
  const inboundQuery = useQuery({
    queryKey: ["ea-inbound-messages"],
    queryFn: () => api.get<InboundMessage[]>("/ea/inbound-messages?limit=10"),
    refetchInterval: 3_000,
  });

  const messages = inboundQuery.data ?? [];
  const recent = messages.filter((m) => {
    const age = Date.now() - new Date(m.createdAt).getTime();
    return age < 24 * 60 * 60 * 1000;
  });

  if (recent.length === 0) return null;

  async function dismiss(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await api.patch(`/ea/inbound-messages/${id}/dismiss`, {});
    qc.invalidateQueries({ queryKey: ["ea-inbound-messages"] });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Incoming</span>
        <span className="text-[10px] text-muted-foreground">({recent.length})</span>
      </div>
      {recent.map((msg) => (
        <div
          key={msg.id}
          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/50 border border-border/40 ${onMessageClick ? "cursor-pointer hover:bg-muted/80 transition-colors" : ""}`}
          onClick={() => onMessageClick?.(msg)}
        >
          <div className="flex-1 min-w-0">
            <p className="text-xs line-clamp-1 text-foreground/80">{msg.body}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <InboundStatusBadge msg={msg} />
            <span className="text-[10px] text-muted-foreground">{relativeTime(msg.createdAt)}</span>
            <button
              type="button"
              onClick={(e) => dismiss(e, msg.id)}
              className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ))}
      <div className="border-b border-border/30 my-1" />
    </div>
  );
}

export function FounderConversations() {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);

  const convsQuery = useQuery({
    queryKey: ["ea-conversations", showAll],
    queryFn: () => api.get<EaConversation[]>(`/ea/conversations${showAll ? "?all=true" : ""}`),
    refetchInterval: 15_000,
  });

  const conversations = convsQuery.data ?? [];

  return (
    <div className="space-y-3">
      <IncomingMessages
        onMessageClick={(msg) => {
          const { eaAgentId, workflowRunId } = msg.rawPayload ?? {};
          if (eaAgentId && workflowRunId) {
            navigate(`/agents/${eaAgentId}/runs/${workflowRunId}`);
          } else if (eaAgentId) {
            navigate(`/agents/${eaAgentId}`);
          }
        }}
      />

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
          {!showAll && " · active"}
        </span>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {showAll ? "Active only" : "Show all"}
        </button>
      </div>

      {convsQuery.isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {!convsQuery.isLoading && conversations.length === 0 && (
        <div className="text-center py-12 text-sm text-muted-foreground">
          <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-30" />
          {showAll ? "No conversations found." : "No active conversations. Send a Telegram message to start one."}
        </div>
      )}

      {conversations.map((conv) => {
        const isExpired = conv.status === "expired" || daysUntil(conv.expiresAt) <= 0;
        const expiring = !isExpired && conv.status === "active" && daysUntil(conv.expiresAt) <= 3;
        const statusKey = isExpired ? "expired" : conv.status;
        const Icon = STATUS_ICON[statusKey] ?? Clock;
        const iconColor = STATUS_COLOR[statusKey] ?? "text-muted-foreground";

        return (
          <Card
            key={conv.id}
            className={`p-3 cursor-pointer hover:bg-accent/30 transition-colors ${isExpired ? "opacity-55" : ""}`}
            onClick={() => navigate(`/founder/conversations/${conv.id}`)}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 shrink-0 ${iconColor}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                {/* Meta row */}
                <div className="flex items-center gap-2">
                  {conv.topicName && <Badge label={conv.topicName} tone="violet" />}
                  {conv.companyName && <Badge label={conv.companyName} tone="blue" />}
                  {conv.topicState && <Badge label={conv.topicState} />}
                  {conv.linkedIssues.map((issue) => (
                    <Badge key={issue.id} label={issue.identifier} tone="green" />
                  ))}
                  {expiring && <Badge label={`exp ${daysUntil(conv.expiresAt)}d`} tone="amber" />}
                  {isExpired && <Badge label="expired" />}
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 ml-auto">
                    <MessageSquare className="h-2.5 w-2.5" />{conv.messageCount}
                  </span>
                </div>
                {/* Last message */}
                {conv.lastUserMessage ? (
                  <p className="text-sm mt-0.5 line-clamp-1 text-foreground">{conv.lastUserMessage}</p>
                ) : (
                  <p className="text-sm mt-0.5 text-muted-foreground italic">No messages yet</p>
                )}
                {/* Assistant reply */}
                {conv.lastAssistantMessage && (
                  <p className="text-xs mt-0.5 text-muted-foreground line-clamp-1">↳ {conv.lastAssistantMessage}</p>
                )}
              </div>
              <div className="text-xs text-muted-foreground shrink-0 text-right">
                {relativeTime(conv.lastMessageAt)}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
