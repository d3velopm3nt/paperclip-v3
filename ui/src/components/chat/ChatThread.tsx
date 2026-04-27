import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatApi } from "../../api/chat";
import { useChatMessages } from "../../hooks/useChatMessages";
import { useChatTyping } from "../../hooks/useChatTyping";
import { ChatMessage, TypingIndicator } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import { queryKeys } from "../../lib/queryKeys";
import type { ContextRef } from "../../api/chat";

interface Props {
  companyId: string;
  companyPrefix: string | null;
  threadId: string;
  threadName: string;
}

export function ChatThread({ companyId, companyPrefix, threadId, threadName }: Props) {
  const queryClient = useQueryClient();
  const { messages, isLoading } = useChatMessages(companyId, threadId);
  const { typingAgents } = useChatTyping(companyId, threadId);

  const agents = queryClient.getQueryData<{ id: string; name: string }[]>(
    ["agents", companyId],
  ) ?? [];
  const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

  // Determine if this is a DM thread and which agentId to direct messages to
  const threads = queryClient.getQueryData<{ id: string; agentId: string | null; name: string }[]>(
    queryKeys.chat.threads(companyId),
  ) ?? [];
  const currentThread = threads.find((t) => t.id === threadId);
  const toAgentId = currentThread?.agentId ?? undefined;

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, typingAgents.length]);

  const send = useMutation({
    mutationFn: ({ body, contextRefs }: { body: string; contextRefs: ContextRef[] }) =>
      chatApi.sendMessage(companyId, body, contextRefs, toAgentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(companyId, threadId) });
    },
  });

  const isDispatcher = !toAgentId;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-5 h-12 shrink-0 border-b border-border">
        {isDispatcher ? (
          <>
            <span className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />
            <div>
              <span className="text-sm font-semibold">{threadName}</span>
              <span className="ml-2 text-xs text-muted-foreground">routes to any agent</span>
            </div>
          </>
        ) : (
          <>
            <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-[11px] font-semibold text-foreground shrink-0">
              {threadName.charAt(0).toUpperCase()}
            </span>
            <div>
              <span className="text-sm font-semibold">{threadName}</span>
              <span className="block text-[11px] text-emerald-500">online</span>
            </div>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-2">
        {isLoading && (
          <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
        )}
        {!isLoading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-sm font-medium text-foreground">
              {isDispatcher ? "Start a conversation" : `Message ${threadName}`}
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              {isDispatcher
                ? "Your message will be routed to the right agent automatically."
                : `Directly message ${threadName}. They'll respond in this thread.`}
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            agentName={msg.fromAgentId ? (agentNameMap.get(msg.fromAgentId) ?? null) : null}
            companyPrefix={companyPrefix}
          />
        ))}
        {typingAgents.map((agent) => (
          <TypingIndicator key={agent.agentId} agentName={agent.agentName} />
        ))}
        <div ref={bottomRef} />
      </div>

      <ChatComposer
        companyId={companyId}
        disabled={send.isPending}
        placeholder={
          isDispatcher
            ? "Message — use @agent, #room…"
            : `Message ${threadName}…`
        }
        onSend={(body, contextRefs) => send.mutate({ body, contextRefs })}
      />
    </div>
  );
}
