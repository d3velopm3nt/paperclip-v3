import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatApi, type ChatThread } from "../../api/chat";
import { agentsApi } from "../../api/agents";
import { channelsApi } from "../../api/channels";
import { queryKeys } from "../../lib/queryKeys";
import { MessageSquare, Send } from "lucide-react";

interface Props {
  companyId: string;
  companyPrefix: string | null;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string, threadName: string) => void;
}

export function ChatSidebar({ companyId, selectedThreadId, onSelectThread }: Props) {
  const queryClient = useQueryClient();

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.chat.threads(companyId),
    queryFn: () => chatApi.listThreads(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: channelsStatus } = useQuery({
    queryKey: ["channels-status"],
    queryFn: () => channelsApi.status(),
    staleTime: 30_000,
  });

  const telegramConfigured = channelsStatus?.telegram?.configured ?? false;

  const openDm = useMutation({
    mutationFn: (agentId: string) => chatApi.ensureAgentThread(companyId, agentId),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(companyId) });
      onSelectThread(thread.id, thread.name);
    },
  });

  const openTelegram = useMutation({
    mutationFn: () => chatApi.ensureTelegramThread(companyId),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(companyId) });
      onSelectThread(thread.id, thread.name);
    },
  });

  const dispatcher = threads.find((t) => t.agentId === null && t.platform === "web");
  const telegramThreads = threads.filter((t) => t.platform === "telegram");
  const activeAgentIds = new Set(threads.filter((t) => t.agentId !== null).map((t) => t.agentId!));
  const threadByAgentId = new Map<string, ChatThread>(
    threads.filter((t) => t.agentId !== null).map((t) => [t.agentId!, t]),
  );

  function itemClass(active: boolean) {
    return [
      "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors text-left",
      active
        ? "bg-accent text-foreground font-medium"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    ].join(" ");
  }

  const liveAgents = agents.filter((a) => a.status !== "terminated");

  return (
    <div className="w-52 shrink-0 flex flex-col border-r border-border h-full bg-background">
      <div className="px-4 h-12 flex items-center shrink-0 border-b border-border">
        <span className="text-sm font-semibold text-foreground">Messages</span>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-4">
        {/* Dispatcher */}
        <div className="flex flex-col gap-0.5">
          {dispatcher && (
            <button
              className={itemClass(selectedThreadId === dispatcher.id)}
              onClick={() => onSelectThread(dispatcher.id, "Dispatcher")}
            >
              <span className="w-7 h-7 rounded-full bg-indigo-500/20 flex items-center justify-center shrink-0">
                <MessageSquare className="h-3.5 w-3.5 text-indigo-400" />
              </span>
              <div className="flex flex-col min-w-0">
                <span className="truncate">Dispatcher</span>
                <span className="text-[11px] text-muted-foreground truncate">routes to any agent</span>
              </div>
            </button>
          )}
        </div>

        {/* Agents */}
        {liveAgents.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Agents
            </div>
            {liveAgents.map((agent) => {
              const thread = threadByAgentId.get(agent.id);
              const isActive = !!thread && selectedThreadId === thread.id;
              const hasThread = activeAgentIds.has(agent.id);
              return (
                <button
                  key={agent.id}
                  className={itemClass(isActive)}
                  onClick={() => {
                    if (thread) {
                      onSelectThread(thread.id, agent.name);
                    } else {
                      openDm.mutate(agent.id);
                    }
                  }}
                >
                  <span className="relative w-7 h-7 shrink-0">
                    <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-[11px] font-semibold text-foreground">
                      {agent.name.charAt(0).toUpperCase()}
                    </span>
                    {hasThread && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-background" />
                    )}
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{agent.name}</span>
                    {agent.role && (
                      <span className="text-[11px] text-muted-foreground truncate capitalize">{agent.role}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Channels — always show if configured */}
        {(telegramConfigured || telegramThreads.length > 0) && (
          <div className="flex flex-col gap-0.5">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Channels
            </div>

            {/* Show real per-chat Telegram threads (skip the inbox placeholder) */}
            {telegramThreads.filter((t) => t.externalKey !== "inbox").length > 0 ? (
              telegramThreads
                .filter((t) => t.externalKey !== "inbox")
                .map((thread) => (
                  <button
                    key={thread.id}
                    className={itemClass(selectedThreadId === thread.id)}
                    onClick={() => onSelectThread(thread.id, thread.name)}
                  >
                    <span className="w-7 h-7 rounded-full bg-blue-500/15 flex items-center justify-center shrink-0">
                      <Send className="h-3.5 w-3.5 text-blue-400" />
                    </span>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{thread.name}</span>
                      <span className="text-[11px] text-muted-foreground truncate">Telegram</span>
                    </div>
                  </button>
                ))
            ) : (
              <div className={itemClass(false) + " cursor-default opacity-60"}>
                <span className="w-7 h-7 rounded-full bg-blue-500/15 flex items-center justify-center shrink-0">
                  <Send className="h-3.5 w-3.5 text-blue-400" />
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="truncate">Telegram</span>
                  <span className="text-[11px] text-muted-foreground truncate">Send a message to start</span>
                </div>
              </div>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}
