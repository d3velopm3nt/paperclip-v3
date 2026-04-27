import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatApi, type ChatMessage } from "../api/chat";
import { queryKeys } from "../lib/queryKeys";

interface LiveChatEvent {
  type: "chat.message.new";
  companyId: string;
  payload: {
    id: string;
    body: string;
    direction: "inbound" | "outbound";
    fromAgentId: string | null;
    agentName: string | null;
    chatThreadId: string | null;
    createdAt: string;
    contextRefs?: Array<{ type: "issue" | "project" | "client" | "agent"; id: string; label: string; meta?: { cwd?: string; status?: string; role?: string } }>;
    isStatus?: boolean;
  };
}

export function useChatMessages(companyId: string | null, threadId: string | null) {
  const { data: initial = [], isLoading } = useQuery({
    queryKey: queryKeys.chat.messages(companyId ?? "", threadId ?? ""),
    queryFn: () => chatApi.listMessages(companyId!, threadId!),
    enabled: !!companyId && !!threadId,
  });

  const [live, setLive] = useState<ChatMessage[]>([]);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  useEffect(() => {
    setLive([]);
  }, [threadId]);

  useEffect(() => {
    if (!companyId) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string) as LiveChatEvent;
          if (parsed.type !== "chat.message.new") return;
          if (parsed.companyId !== companyId) return;
          const msg = parsed.payload;
          if (msg.chatThreadId && msg.chatThreadId !== threadIdRef.current) return;
          const newMsg: ChatMessage = {
            id: msg.id,
            companyId,
            issueId: null,
            direction: msg.direction,
            platform: "chat",
            source: "chat",
            fromAgentId: msg.fromAgentId,
            body: msg.body,
            chatThreadId: msg.chatThreadId,
            rawPayload: msg.contextRefs ? { contextRefs: msg.contextRefs } : null,
            isStatus: msg.isStatus,
            createdAt: msg.createdAt,
          };
          setLive((prev) => [...prev, newMsg]);
        } catch {
          // ignore malformed
        }
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!closed) scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "hook_unmount");
    };
  }, [companyId]);

  const seen = new Set(initial.map((m) => m.id));
  const merged = [...initial, ...live.filter((m) => !seen.has(m.id))];

  return { messages: merged, isLoading };
}
