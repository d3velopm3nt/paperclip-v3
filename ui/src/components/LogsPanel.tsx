import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronDown, ChevronUp, MessageSquare, Terminal, X } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STORAGE_OPEN = "paperclip.logsPanel.open";
const STORAGE_HEIGHT = "paperclip.logsPanel.height";
const STORAGE_TAB = "paperclip.logsPanel.tab";
const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 80;

type Tab = "activity" | "chat" | "llm";

function storedBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === "true" ? true : v === "false" ? false : fallback;
  } catch {
    return fallback;
  }
}
function storedNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
function storedTab(fallback: Tab): Tab {
  try {
    const v = localStorage.getItem(STORAGE_TAB);
    return v === "activity" || v === "chat" || v === "llm" ? v : fallback;
  } catch {
    return fallback;
  }
}

function formatTs(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d as string);
  return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function rowColor(e: ActivityEvent): string {
  if (/error|fail/.test(e.action)) return "text-red-400";
  if (/create|add|wake|start/.test(e.action)) return "text-green-400";
  if (/update|assign|comment|reply/.test(e.action)) return "text-blue-400";
  if (/delete|remove|pause|cancel/.test(e.action)) return "text-orange-400";
  if (e.actorType === "agent") return "text-cyan-400";
  return "text-neutral-400";
}

function ActivityRow({ event, agentName }: { event: ActivityEvent; agentName: string | null }) {
  const detailStr = (() => {
    if (!event.details || Object.keys(event.details).length === 0) return null;
    return JSON.stringify(event.details).slice(0, 100);
  })();
  return (
    <div className="flex items-baseline gap-2 px-3 py-1 hover:bg-white/5 font-mono text-xs">
      <span className="text-neutral-600 shrink-0 tabular-nums">{formatTs(event.createdAt)}</span>
      <span className={cn("shrink-0", agentName ? "text-cyan-400" : "text-neutral-600")}>
        [{agentName ?? event.actorType}]
      </span>
      <span className={cn("shrink-0 font-semibold", rowColor(event))}>{event.action}</span>
      <span className="text-neutral-500 shrink-0">{event.entityType}</span>
      <span className="text-neutral-700 shrink-0 tabular-nums">#{event.entityId.slice(0, 8)}</span>
      {detailStr && <span className="text-neutral-600 truncate min-w-0">{detailStr}</span>}
    </div>
  );
}

function ChatRow({ event, agentName }: { event: ActivityEvent; agentName: string | null }) {
  const isRequest = event.action === "chat.request";
  const isResponse = event.action === "chat.response";
  const isError = event.action === "chat.error";

  const isThinking = event.action === "chat.thinking";
  const isTimeout = event.action === "chat.timeout";

  const [showPrompt, setShowPrompt] = useState(false);

  const text = (() => {
    if (!event.details) return null;
    if (isRequest) {
      const msg = typeof event.details.message === "string" ? event.details.message : null;
      const refs = Array.isArray(event.details.contextRefs) ? (event.details.contextRefs as string[]).join(", ") : null;
      return msg ? (refs ? `${msg}  [ctx: ${refs}]` : msg) : null;
    }
    if (isResponse) return typeof event.details.reply === "string" ? event.details.reply : null;
    if (isError) return typeof event.details.error === "string" ? event.details.error : null;
    if (isThinking) return `TTFB ${event.details.ttfbMs}ms`;
    if (isTimeout) return `timeout after ${event.details.elapsedMs}ms — stdout: ${event.details.stdoutLen} bytes — stderr: ${event.details.stderr ?? ""}`;
    return JSON.stringify(event.details).slice(0, 200);
  })();

  return (
    <div className="flex flex-wrap gap-2 px-3 py-1.5 hover:bg-white/5 font-mono text-xs border-b border-white/5">
      <span className="text-neutral-600 shrink-0 tabular-nums pt-px">{formatTs(event.createdAt)}</span>
      {isRequest && (
        <>
          <span className="text-yellow-400 shrink-0 font-semibold pt-px">→</span>
          <span className="text-neutral-300 break-words min-w-0 flex-1">{text}</span>
          {event.details?.systemPrompt && (
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              className="shrink-0 text-neutral-600 hover:text-neutral-400 text-[10px] ml-1"
            >
              {showPrompt ? "▲ prompt" : "▼ prompt"}
            </button>
          )}
        </>
      )}
      {isRequest && showPrompt && typeof event.details?.systemPrompt === "string" && (
        <div className="w-full mt-1 rounded bg-neutral-900 px-2 py-1.5 text-[10px] text-neutral-400 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {event.details.systemPrompt as string}
        </div>
      )}
      {isResponse && (
        <>
          <span className="text-green-400 shrink-0 font-semibold pt-px">←</span>
          <span className="text-cyan-300 shrink-0 pt-px">{agentName ?? "agent"}:</span>
          <span className="text-neutral-300 break-words min-w-0">{text}</span>
        </>
      )}
      {isError && (
        <>
          <span className="text-red-400 shrink-0 font-semibold pt-px">✗</span>
          <span className="text-red-300 break-words min-w-0">{text}</span>
        </>
      )}
      {isThinking && (
        <>
          <span className="text-neutral-500 shrink-0 pt-px">⏱</span>
          <span className="text-neutral-500 break-words min-w-0">{text}</span>
        </>
      )}
      {isTimeout && (
        <>
          <span className="text-orange-400 shrink-0 font-semibold pt-px">⏰</span>
          <span className="text-orange-300 break-words min-w-0">{text}</span>
        </>
      )}
      {!isRequest && !isResponse && !isError && !isThinking && !isTimeout && (
        <span className="text-neutral-400 break-words min-w-0">{text}</span>
      )}
    </div>
  );
}

function LlmIoRow({ event, agentName }: { event: ActivityEvent; agentName: string | null }) {
  const [expanded, setExpanded] = useState<"stdin" | "stdout" | "stderr" | null>(null);
  const d = event.details ?? {};
  const stdin  = typeof d.stdin  === "string" ? d.stdin  : null;
  const stdout = typeof d.stdout === "string" ? d.stdout : null;
  const stderr = typeof d.stderr === "string" ? d.stderr : null;
  const totalMs = typeof d.totalMs === "number" ? d.totalMs : null;
  const exitCode = typeof d.exitCode === "number" ? d.exitCode : null;

  return (
    <div className="px-3 py-1.5 font-mono text-xs border-b border-white/5 hover:bg-white/5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-neutral-600 shrink-0 tabular-nums">{formatTs(event.createdAt)}</span>
        <span className="text-cyan-400 shrink-0">{agentName ?? "agent"}</span>
        {totalMs !== null && <span className="text-neutral-600 shrink-0">{totalMs}ms</span>}
        {exitCode !== null && <span className={exitCode === 0 ? "text-green-400" : "text-red-400"}>exit:{exitCode}</span>}
        {stdin && (
          <button type="button" onClick={() => setExpanded(expanded === "stdin" ? null : "stdin")}
            className="text-yellow-400/70 hover:text-yellow-400 text-[10px]">
            {expanded === "stdin" ? "▲" : "▼"} stdin
          </button>
        )}
        {stdout && (
          <button type="button" onClick={() => setExpanded(expanded === "stdout" ? null : "stdout")}
            className="text-green-400/70 hover:text-green-400 text-[10px]">
            {expanded === "stdout" ? "▲" : "▼"} stdout
          </button>
        )}
        {stderr && (
          <button type="button" onClick={() => setExpanded(expanded === "stderr" ? null : "stderr")}
            className="text-red-400/70 hover:text-red-400 text-[10px]">
            {expanded === "stderr" ? "▲" : "▼"} stderr
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-1.5 rounded bg-neutral-900 px-2 py-1.5 text-[10px] whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-neutral-300">
          {expanded === "stdin" ? stdin : expanded === "stdout" ? stdout : stderr}
        </div>
      )}
    </div>
  );
}

export function LogsPanel({ companyId }: { companyId: string | null }) {
  const [open, setOpen] = useState(() => storedBool(STORAGE_OPEN, false));
  const [height, setHeight] = useState(() => storedNum(STORAGE_HEIGHT, DEFAULT_HEIGHT));
  const [tab, setTab] = useState<Tab>(() => storedTab("activity"));
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const dragState = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => { try { localStorage.setItem(STORAGE_OPEN, String(open)); } catch {} }, [open]);
  useEffect(() => { try { localStorage.setItem(STORAGE_HEIGHT, String(height)); } catch {} }, [height]);
  useEffect(() => { try { localStorage.setItem(STORAGE_TAB, tab); } catch {} }, [tab]);

  // Ctrl+` to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startY: e.clientY, startH: height };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startY - ev.clientY;
      const max = Math.floor(window.innerHeight * 0.6);
      setHeight(Math.max(MIN_HEIGHT, Math.min(max, dragState.current.startH + delta)));
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId && open,
  });

  const { data: activityEvents = [] } = useQuery({
    queryKey: [...queryKeys.activity(companyId ?? ""), "activity-tab", agentFilter],
    queryFn: () =>
      activityApi.list(companyId!, agentFilter !== "all" ? { agentId: agentFilter } : undefined)
        .then((evs) => evs.filter((e) => e.entityType !== "chat_thread")),
    enabled: !!companyId && open && tab === "activity",
    refetchInterval: open && tab === "activity" ? 3000 : false,
  });

  const { data: chatEvents = [] } = useQuery({
    queryKey: [...queryKeys.activity(companyId ?? ""), "chat-tab", agentFilter],
    queryFn: () =>
      activityApi.list(companyId!, {
        entityType: "chat_thread",
        ...(agentFilter !== "all" ? { agentId: agentFilter } : {}),
      }),
    enabled: !!companyId && open && tab === "chat",
    refetchInterval: open && tab === "chat" ? 3000 : false,
  });

  const { data: llmEvents = [] } = useQuery({
    queryKey: [...queryKeys.activity(companyId ?? ""), "llm-tab", agentFilter],
    queryFn: () =>
      activityApi.list(companyId!, {
        entityType: "chat_thread",
        ...(agentFilter !== "all" ? { agentId: agentFilter } : {}),
      }).then((evs) => evs.filter((e) => e.action === "llm.io")),
    enabled: !!companyId && open && tab === "llm",
    refetchInterval: open && tab === "llm" ? 3000 : false,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a.name]));
  const events = tab === "chat" ? chatEvents : tab === "llm" ? llmEvents : activityEvents;

  return (
    <div className="shrink-0 border-t border-border bg-background flex flex-col">
      {open && (
        <div
          className="h-1 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors shrink-0"
          onMouseDown={onDragStart}
        />
      )}

      {/* Header bar */}
      <div className="flex items-center gap-1 px-3 h-8 shrink-0 select-none border-t border-border/50">
        {/* Toggle open/close */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          title="Toggle panel (Ctrl+`)"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        </button>

        {/* Tab buttons — always visible so user can switch/open */}
        <button
          type="button"
          onClick={() => { setTab("activity"); setOpen(true); }}
          className={cn(
            "flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded transition-colors",
            tab === "activity" && open
              ? "text-foreground bg-accent"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Activity className="h-3.5 w-3.5" />
          Activity
        </button>

        <button
          type="button"
          onClick={() => { setTab("chat"); setOpen(true); }}
          className={cn(
            "flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded transition-colors",
            tab === "chat" && open
              ? "text-foreground bg-accent"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </button>

        <button
          type="button"
          onClick={() => { setTab("llm"); setOpen(true); }}
          className={cn(
            "flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded transition-colors",
            tab === "llm" && open
              ? "text-foreground bg-accent"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Terminal className="h-3.5 w-3.5" />
          LLM
        </button>

        {open && (
          <>
            <div className="w-px h-4 bg-border mx-1" />

            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-5 text-xs border-0 bg-transparent shadow-none px-1 py-0 gap-1 focus:ring-0 text-muted-foreground hover:text-foreground w-auto min-w-[90px]">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {events.length} events
            </span>

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
              aria-label="Close panel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Content */}
      {open && (
        <div
          className="overflow-y-auto bg-neutral-950 dark:bg-neutral-950 flex flex-col"
          style={{ height }}
        >
          {events.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-neutral-500">
              {tab === "chat" ? "No chat activity yet" : tab === "llm" ? "No LLM calls yet" : "No activity yet"}
            </div>
          ) : tab === "chat" ? (
            <div>
              {events.map((event) => (
                <ChatRow
                  key={event.id}
                  event={event}
                  agentName={event.agentId ? (agentMap.get(event.agentId) ?? null) : null}
                />
              ))}
            </div>
          ) : tab === "llm" ? (
            <div className="divide-y divide-white/5">
              {events.map((event) => (
                <LlmIoRow
                  key={event.id}
                  event={event}
                  agentName={event.agentId ? (agentMap.get(event.agentId) ?? null) : null}
                />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {events.map((event) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  agentName={event.agentId ? (agentMap.get(event.agentId) ?? null) : null}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
