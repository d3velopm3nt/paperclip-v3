import { useState } from "react";
import type { ChatMessage as ChatMessageType, ContextRef } from "../../api/chat";

interface Props {
  message: ChatMessageType;
  agentName?: string | null;
  companyPrefix?: string | null;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const CONTEXT_REF_COLORS: Record<ContextRef["type"], string> = {
  agent:    "bg-blue-950 border-blue-800 text-blue-300",
  project:  "bg-violet-950 border-violet-800 text-violet-300",
  client:   "bg-orange-950 border-orange-800 text-orange-300",
  issue:    "bg-emerald-950 border-emerald-800 text-emerald-300",
  document: "bg-purple-950 border-purple-800 text-purple-300",
};

function ContextPills({ refs }: { refs: ContextRef[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (refs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {refs.map((ref) => (
        <div key={ref.id} className="flex flex-col items-start">
          <button
            type="button"
            onClick={() => setExpanded(expanded === ref.id ? null : ref.id)}
            className={`inline-flex items-center gap-1 rounded-md border text-[11px] px-1.5 py-0.5 transition-opacity hover:opacity-80 ${CONTEXT_REF_COLORS[ref.type]}`}
          >
            <span className="opacity-50">{ref.type}</span>
            <span>{ref.label}</span>
            <span className="opacity-40 ml-0.5">{expanded === ref.id ? "▲" : "▼"}</span>
          </button>
          {expanded === ref.id && (
            <div className="mt-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground max-w-[280px] space-y-0.5">
              <div className="font-medium text-foreground">{ref.label}</div>
              <div className="opacity-60">{ref.type}{ref.meta?.status ? ` · ${ref.meta.status}` : ""}{ref.meta?.role ? ` · ${ref.meta.role}` : ""}</div>
              {ref.meta?.cwd && (
                <div className="flex items-center gap-1 mt-1 pt-1 border-t border-border">
                  <span className="text-green-400">📁</span>
                  <span className="font-mono text-[10px] text-green-300 break-all">{ref.meta.cwd}</span>
                </div>
              )}
              {!ref.meta?.cwd && ref.type === "project" && (
                <div className="text-orange-400/70 text-[10px] mt-1 pt-1 border-t border-border">
                  No local path set — agent cannot read files
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ChatMessage({ message, agentName, companyPrefix }: Props) {
  const isOperator = message.direction === "inbound";
  const displayName = agentName ?? "Agent";

  if (message.isStatus) {
    return (
      <div className="flex justify-start gap-2.5 px-1">
        <div className="text-[11px] text-muted-foreground/70 italic pl-9 py-0.5">{message.body}</div>
      </div>
    );
  }
  const contextRefs: ContextRef[] = message.rawPayload?.contextRefs ?? [];
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
          {contextRefs.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1 px-1">
              <ContextPills refs={contextRefs} />
            </div>
          )}
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
