import type { ChatMessage as ChatMessageType } from "../../api/chat";

interface Props {
  message: ChatMessageType;
  agentName?: string | null;
  companyPrefix?: string | null;
}

export function ChatMessage({ message, agentName, companyPrefix }: Props) {
  const isOutbound = message.direction === "outbound";
  const displayName = agentName ?? "Agent";
  const issueLink = message.issueId
    ? companyPrefix
      ? `/${companyPrefix}/issues/${message.issueId}`
      : `/issues/${message.issueId}`
    : null;

  if (!isOutbound) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm text-white">
          {message.body}
        </div>
        <span className="text-[10px] text-muted-foreground pr-1">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-[11px] font-semibold text-indigo-400 pl-1">{displayName}</span>
      <div className="max-w-[75%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-foreground">
        {message.body}
      </div>
      <div className="flex items-center gap-3 pl-1">
        <span className="text-[10px] text-muted-foreground">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        {issueLink && (
          <a
            href={issueLink}
            className="text-[10px] text-muted-foreground underline hover:text-foreground"
          >
            view issue →
          </a>
        )}
      </div>
    </div>
  );
}

export function TypingIndicator({ agentName }: { agentName: string }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-[11px] font-semibold text-indigo-400 pl-1">{agentName}</span>
      <div className="rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2">
        <div className="flex gap-1 items-center h-4">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
