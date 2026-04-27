import type { ChatMessage as ChatMessageType } from "../../api/chat";

interface Props {
  message: ChatMessageType;
  agentName?: string | null;
  companyPrefix?: string | null;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatMessage({ message, agentName, companyPrefix }: Props) {
  const isOperator = message.direction === "inbound";
  const displayName = agentName ?? "Agent";
  const issueLink = message.issueId
    ? companyPrefix
      ? `/${companyPrefix}/issues/${message.issueId}`
      : `/issues/${message.issueId}`
    : null;

  if (isOperator) {
    return (
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-1 max-w-[70%]">
          <div className="rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm text-white leading-relaxed">
            {message.body}
          </div>
          <span className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-2.5">
      <span className="w-7 h-7 rounded-full bg-indigo-500/15 flex items-center justify-center text-[11px] font-semibold text-indigo-400 shrink-0 mt-0.5">
        {displayName.charAt(0).toUpperCase()}
      </span>
      <div className="flex flex-col items-start gap-1 max-w-[70%]">
        <span className="text-[12px] font-semibold text-indigo-400 pl-0.5">{displayName}</span>
        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
          {message.body}
        </div>
        <div className="flex items-center gap-3 pl-0.5">
          <span className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</span>
          {issueLink && (
            <a
              href={issueLink}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
            >
              view issue →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function TypingIndicator({ agentName }: { agentName: string }) {
  return (
    <div className="flex justify-start gap-2.5">
      <span className="w-7 h-7 rounded-full bg-indigo-500/15 flex items-center justify-center text-[11px] font-semibold text-indigo-400 shrink-0 mt-0.5">
        {agentName.charAt(0).toUpperCase()}
      </span>
      <div className="flex flex-col items-start gap-1">
        <span className="text-[12px] font-semibold text-indigo-400 pl-0.5">{agentName}</span>
        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
          <div className="flex gap-1 items-center">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
