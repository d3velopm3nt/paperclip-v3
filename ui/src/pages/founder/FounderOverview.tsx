// v3: founder overview — two-column dashboard (companies + agents left, conversations right).
import { useNavigate } from "@/lib/router";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, XCircle, Clock, Activity, MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useCompany } from "../../context/CompanyContext";
import { issuesApi } from "../../api/issues";
import { workflowRunsApi, type WorkflowRun } from "../../api/workflowRuns";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { api } from "../../api/client";
import { IncomingMessages, type InboundMessage } from "../FounderConversations";
import type { Company } from "@paperclipai/shared";
import type { Issue } from "@paperclipai/shared";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EaAgent {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: string | null;
  metadata: {
    currentTopicId?: string;
    currentTopicName?: string;
    lastMessagePreview?: string;
  } | null;
}

interface EaTopic {
  id: string;
  name: string;
  companyId: string | null;
  currentState: string | null;
  status: string;
}

interface LinkedIssue {
  id: string;
  identifier: string;
}

interface EaConversation {
  id: string;
  topicName: string | null;
  companyName: string | null;
  companyId: string | null;
  topicState: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string;
  expiresAt: string;
  linkedIssues: LinkedIssue[];
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

// ── Badge ─────────────────────────────────────────────────────────────────────

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

// ── ConvCard (right panel) ────────────────────────────────────────────────────

const CONV_STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  active: CheckCircle2,
  extended: CheckCircle2,
  expired: XCircle,
  running: Activity,
};
const CONV_STATUS_COLOR: Record<string, string> = {
  active: "text-emerald-600",
  extended: "text-emerald-600",
  expired: "text-muted-foreground",
  running: "text-blue-600",
};

function ConvCard({ conv, onClick }: { conv: EaConversation; onClick: () => void }) {
  const isExpired = conv.status === "expired" || daysUntil(conv.expiresAt) <= 0;
  const expiring = !isExpired && conv.status === "active" && daysUntil(conv.expiresAt) <= 3;
  const statusKey = isExpired ? "expired" : conv.status;
  const Icon = CONV_STATUS_ICON[statusKey] ?? Clock;
  const iconColor = CONV_STATUS_COLOR[statusKey] ?? "text-muted-foreground";

  return (
    <Card
      className={`p-3 cursor-pointer hover:bg-accent/30 transition-colors ${isExpired ? "opacity-55" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${iconColor}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {conv.topicName && <Badge label={conv.topicName} tone="violet" />}
            {conv.companyName && <Badge label={conv.companyName} tone="blue" />}
            {conv.linkedIssues.map((i) => (
              <Badge key={i.id} label={i.identifier} tone="green" />
            ))}
            {expiring && <Badge label={`exp ${daysUntil(conv.expiresAt)}d`} tone="amber" />}
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 ml-auto">
              <MessageSquare className="h-2.5 w-2.5" />{conv.messageCount}
            </span>
          </div>
          {conv.lastUserMessage ? (
            <p className="text-sm mt-0.5 line-clamp-1 text-foreground">{conv.lastUserMessage}</p>
          ) : (
            <p className="text-sm mt-0.5 text-muted-foreground italic">No messages yet</p>
          )}
          {conv.lastAssistantMessage && (
            <p className="text-xs mt-0.5 text-muted-foreground line-clamp-1">↳ {conv.lastAssistantMessage}</p>
          )}
        </div>
        <div className="text-xs text-muted-foreground shrink-0">{relativeTime(conv.lastMessageAt)}</div>
      </div>
    </Card>
  );
}

// ── EaAgentCard (left panel — EA Agents section) ───────────────────────────

function EaAgentCard({ agent, onClick }: { agent: EaAgent; onClick: () => void }) {
  const qc = useQueryClient();
  const isProcessing = agent.status === "processing";
  const isPaused = agent.status === "paused" || agent.status === "error";
  const topicName = agent.metadata?.currentTopicName;
  const messagePreview = agent.metadata?.lastMessagePreview;

  const borderColor = isProcessing
    ? "border-blue-500/40"
    : isPaused
    ? "border-red-500/40"
    : "border-border";
  const bgColor = isProcessing ? "bg-blue-500/5" : isPaused ? "bg-red-500/5" : "bg-card";
  const dotColor = isProcessing ? "bg-blue-400" : isPaused ? "bg-red-400" : "bg-muted-foreground/30";

  async function resetAgent(e: React.MouseEvent) {
    e.stopPropagation();
    await api.post(`/ecc/agents/${agent.id}/reset`, {});
    qc.invalidateQueries({ queryKey: ["ea-agents"] });
  }

  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border ${borderColor} ${bgColor} p-3 hover:border-foreground/20 transition-colors w-full`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor} ${isProcessing ? "animate-pulse" : ""}`}
        />
        <span className="text-xs font-medium truncate flex-1">{agent.name}</span>
        {isProcessing && (
          <span
            role="button"
            onClick={resetAgent}
            title="Force reset to idle"
            className="text-[9px] text-blue-400/60 hover:text-blue-400 border border-blue-400/20 hover:border-blue-400/50 rounded px-1 py-0.5 transition-colors cursor-pointer"
          >
            reset
          </span>
        )}
      </div>
      <div className="mb-1">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            isProcessing
              ? "bg-blue-500/10 text-blue-400"
              : isPaused
              ? "bg-red-500/10 text-red-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {agent.status}
        </span>
      </div>
      {isProcessing && topicName ? (
        <div className="space-y-0.5">
          <p className="text-[11px] text-violet-400 font-medium truncate">{topicName}</p>
          {messagePreview && (
            <p className="text-[11px] text-muted-foreground line-clamp-1">{messagePreview}</p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {agent.lastHeartbeatAt ? `last active ${relativeTime(agent.lastHeartbeatAt)}` : "never active"}
        </p>
      )}
    </button>
  );
}

// ── CompanyCard (left panel) ──────────────────────────────────────────────────

function CompanyCard({
  company,
  issues,
  isLoading,
  isPersonal,
  topics,
  runningAgents,
}: {
  company: Company;
  issues: Issue[] | undefined;
  isLoading: boolean;
  isPersonal: boolean;
  topics: EaTopic[];
  runningAgents: WorkflowRun[];
}) {
  const navigate = useNavigate();
  const openIssues = issues?.filter((i) => ["backlog", "todo", "in_progress"].includes(i.status)) ?? [];
  const blockedIssues = issues?.filter((i) => i.status === "blocked") ?? [];
  const topicNames = topics
    .filter((t) => t.companyId === company.id && t.status === "active")
    .map((t) => t.name)
    .slice(0, 3);

  return (
    <button
      onClick={() => navigate(`/${company.issuePrefix}/dashboard`)}
      className="text-left rounded-lg border border-border bg-card p-4 hover:border-foreground/20 transition-colors w-full"
    >
      <div className="flex items-center gap-2 mb-2">
        {company.brandColor && (
          <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: company.brandColor }} />
        )}
        <span className="font-medium text-sm">{company.name}</span>
        {isPersonal && (
          <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">Personal</span>
        )}
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground mb-2">Loading…</div>
      ) : (
        <div className="flex gap-4 text-xs text-muted-foreground mb-2">
          <span>{openIssues.length} open</span>
          {blockedIssues.length > 0 && (
            <span className="text-red-500 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {blockedIssues.length} blocked
            </span>
          )}
        </div>
      )}

      {topicNames.length > 0 && (
        <p className="text-[11px] text-muted-foreground line-clamp-1 mb-2">
          {topicNames.join(" · ")}
        </p>
      )}

      {runningAgents.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {runningAgents.map((run) => (
            <span
              key={run.id}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-blue-500/10 border border-blue-500/20 text-blue-400"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              {run.workflowType.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// ── FounderOverview ───────────────────────────────────────────────────────────

export function FounderOverview() {
  const navigate = useNavigate();
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");
  const personalCompanyId = localStorage.getItem("founder.personalCompanyId") ?? "";

  const issueQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.issues.list(company.id),
      queryFn: () => issuesApi.list(company.id),
      staleTime: 30_000,
    })),
  });

  const topicsQuery = useQuery({
    queryKey: ["topics", "active"],
    queryFn: () => api.get<EaTopic[]>("/ecc/topics?status=active"),
    staleTime: 30_000,
  });

  const agentQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: ["workflow-runs", "running", company.id],
      queryFn: () => workflowRunsApi.listForCompany(company.id, undefined, 5, "running"),
      refetchInterval: 10_000,
      staleTime: 5_000,
    })),
  });

  const convsQuery = useQuery({
    queryKey: ["ea-conversations", "overview"],
    queryFn: () => api.get<EaConversation[]>("/ecc/conversations?limit=8"),
    refetchInterval: 15_000,
  });

  const eaAgentsQuery = useQuery({
    queryKey: ["ea-agents"],
    queryFn: () => api.get<EaAgent[]>("/ecc/agents"),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === "processing") ? 5_000 : 15_000,
  });

  const allIssues = activeCompanies.flatMap((_, i) => issueQueries[i]?.data ?? []);
  const blockedIssues = allIssues.filter((i) => i.status === "blocked");
  const needsAttention = [...blockedIssues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);
  const companyById = new Map(activeCompanies.map((c) => [c.id, c]));
  const topics = topicsQuery.data ?? [];
  const conversations = convsQuery.data ?? [];
  const eaAgents = eaAgentsQuery.data ?? [];

  return (
    <div className="flex flex-col lg:flex-row gap-0 h-full min-h-0">
      {/* LEFT: EA Agents + Companies + Needs Attention */}
      <div className="flex-[3] pr-0 lg:pr-6 space-y-8 overflow-auto pb-6">
        {eaAgents.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              EA Agents
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {eaAgents.map((agent) => (
                <EaAgentCard
                  key={agent.id}
                  agent={agent}
                  onClick={() => navigate(`/agents/${agent.id}/instructions`)}
                />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Companies
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {activeCompanies.map((company, i) => (
              <CompanyCard
                key={company.id}
                company={company}
                issues={issueQueries[i]?.data}
                isLoading={issueQueries[i]?.isLoading ?? false}
                isPersonal={company.id === personalCompanyId}
                topics={topics}
                runningAgents={agentQueries[i]?.data ?? []}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Needs Attention
          </h2>
          {needsAttention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing blocked across your companies.</p>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs">
                  <tr>
                    <th className="text-left px-4 py-2">Company</th>
                    <th className="text-left px-4 py-2">Issue</th>
                    <th className="text-left px-4 py-2">Title</th>
                    <th className="text-left px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {needsAttention.map((issue) => {
                    const company = companyById.get(issue.companyId);
                    return (
                      <tr
                        key={issue.id}
                        className={cn("border-t border-border hover:bg-muted/30 cursor-pointer")}
                        onClick={() => navigate(`/${company?.issuePrefix ?? ""}/issues/${issue.id}`)}
                      >
                        <td className="px-4 py-2 text-muted-foreground">{company?.name ?? "—"}</td>
                        <td className="px-4 py-2 font-mono text-xs">{issue.identifier}</td>
                        <td className="px-4 py-2">{issue.title}</td>
                        <td className="px-4 py-2">
                          <span className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-1.5 py-0.5 rounded">
                            {issue.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* RIGHT: Incoming + Conversations */}
      <div className="flex-[2] border-t lg:border-t-0 lg:border-l border-border pt-6 lg:pt-0 lg:pl-6 overflow-auto space-y-3 pb-6">
        <IncomingMessages
          onMessageClick={(msg: InboundMessage) => {
            const { eccAgentId, workflowRunId } = msg.rawPayload ?? {};
            if (eccAgentId && workflowRunId) {
              navigate(`/agents/${eccAgentId}/runs/${workflowRunId}`);
            } else if (eccAgentId) {
              navigate(`/agents/${eccAgentId}`);
            }
          }}
        />

        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Live Conversations
        </h2>

        {convsQuery.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}

        {!convsQuery.isLoading && conversations.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
            No active conversations.
          </div>
        )}

        {conversations.map((conv) => (
          <ConvCard
            key={conv.id}
            conv={conv}
            onClick={() => navigate(`/founder/conversations/${conv.id}`)}
          />
        ))}

        {conversations.length > 0 && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline underline-offset-2 w-full text-center pt-1"
            onClick={() => navigate("/founder/conversations")}
          >
            Show all conversations →
          </button>
        )}
      </div>
    </div>
  );
}
