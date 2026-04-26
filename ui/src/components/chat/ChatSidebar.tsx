import { useQuery } from "@tanstack/react-query";
import { chatApi } from "../../api/chat";
import { roomsApi } from "../../api/rooms";
import { queryKeys } from "../../lib/queryKeys";
import { Hash, MessageSquare } from "lucide-react";
import { useNavigate } from "../../lib/router";

interface Props {
  companyId: string;
  companyPrefix: string | null;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}

export function ChatSidebar({
  companyId,
  companyPrefix,
  selectedThreadId,
  onSelectThread,
}: Props) {
  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.chat.threads(companyId),
    queryFn: () => chatApi.listThreads(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", companyId],
    queryFn: () => roomsApi.list(companyId),
    enabled: !!companyId,
  });

  const navigate = useNavigate();

  const dispatcher = threads.find((t) => t.agentId === null);
  const agentThreads = threads.filter((t) => t.agentId !== null);

  function threadClass(id: string) {
    return `w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm cursor-pointer transition-colors text-left ${
      selectedThreadId === id
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
    }`;
  }

  return (
    <div className="w-44 shrink-0 flex flex-col border-r border-border h-full overflow-y-auto">
      <div className="px-3 py-3 shrink-0">
        <span className="text-sm font-semibold text-foreground">Chat</span>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {dispatcher && (
          <button
            className={threadClass(dispatcher.id)}
            onClick={() => onSelectThread(dispatcher.id)}
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Dispatcher</span>
          </button>
        )}

        {agentThreads.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Agents
            </div>
            {agentThreads.map((thread) => (
              <button
                key={thread.id}
                className={threadClass(thread.id)}
                onClick={() => onSelectThread(thread.id)}
              >
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">{thread.name}</span>
              </button>
            ))}
          </>
        )}

        {rooms.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Rooms
            </div>
            {rooms.map((room) => (
              <button
                key={room.id}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm cursor-pointer transition-colors text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={() =>
                  navigate(
                    companyPrefix ? `/${companyPrefix}/rooms/${room.id}` : `/rooms/${room.id}`,
                  )
                }
              >
                <Hash className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{room.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
