import { useEffect, useState } from "react";

interface TypingAgent {
  agentId: string;
  agentName: string;
}

interface TypingEvent {
  type: "chat.agent.typing" | "chat.agent.done";
  companyId: string;
  payload: { agentId: string; agentName: string; chatThreadId: string };
}

export function useChatTyping(companyId: string | null, _threadId: string | null) {
  const [typing, setTyping] = useState<Map<string, TypingAgent>>(new Map());

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
          const parsed = JSON.parse(event.data as string) as TypingEvent;
          if (parsed.companyId !== companyId) return;
          if (parsed.type !== "chat.agent.typing" && parsed.type !== "chat.agent.done") return;

          const { agentId, agentName } = parsed.payload;

          if (parsed.type === "chat.agent.typing") {
            setTyping((prev) => {
              const next = new Map(prev);
              next.set(agentId, { agentId, agentName });
              return next;
            });
          } else {
            setTyping((prev) => {
              const next = new Map(prev);
              next.delete(agentId);
              return next;
            });
          }
        } catch {
          // ignore
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
      socket?.close(1000, "typing_hook_unmount");
    };
  }, [companyId]);

  return { typingAgents: Array.from(typing.values()) };
}
