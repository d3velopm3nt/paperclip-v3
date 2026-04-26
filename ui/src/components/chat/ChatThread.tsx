import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, typingAgents.length]);

  const send = useMutation({
    mutationFn: ({ body, contextRefs }: { body: string; contextRefs: ContextRef[] }) =>
      chatApi.sendMessage(companyId, body, contextRefs),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(companyId, threadId) });
    },
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-4 h-12 shrink-0 border-b border-border">
        <span className="w-2 h-2 rounded-full bg-indigo-400" />
        <span className="text-sm font-semibold">{threadName}</span>
        {threadName === "Dispatcher" && (
          <span className="text-xs text-muted-foreground">routes to any agent</span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {!isLoading && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No messages yet. Say hi to your agents.
          </p>
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
        onSend={(body, contextRefs) => send.mutate({ body, contextRefs })}
      />
    </div>
  );
}
