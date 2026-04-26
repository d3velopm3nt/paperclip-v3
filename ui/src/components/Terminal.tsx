import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { repoApi } from "@/api/repo";

interface TerminalProps {
  projectId: string;
  className?: string;
}

type LineKind = "stdout" | "stderr" | "info";

interface TerminalLine {
  id: number;
  kind: LineKind;
  text: string;
}

export function Terminal({ projectId, className }: TerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const lineIdRef = useRef(0);
  const cmdRef = useRef(cmd);
  useEffect(() => { cmdRef.current = cmd; }, [cmd]);

  // Auto-scroll to bottom whenever lines change
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const appendLine = useCallback((kind: LineKind, text: string) => {
    setLines((prev) => [...prev, { id: ++lineIdRef.current, kind, text }]);
  }, []);

  const abort = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setRunning(false);
  }, []);

  const run = useCallback(() => {
    const trimmed = cmdRef.current.trim();
    if (!trimmed || running) return;

    // Close any existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    appendLine("info", `$ ${trimmed}`);
    setCmd("");
    setRunning(true);

    const url = repoApi.terminalUrl(projectId, trimmed);
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("stdout", (e: MessageEvent) => {
      const text = JSON.parse(e.data) as string;
      if (text) appendLine("stdout", text);
    });

    es.addEventListener("stderr", (e: MessageEvent) => {
      const text = JSON.parse(e.data) as string;
      if (text) appendLine("stderr", text);
    });

    es.addEventListener("exit", (e: MessageEvent) => {
      let code: number | null = null;
      try {
        const parsed = JSON.parse(e.data) as { code: number | null };
        code = parsed.code;
      } catch {
        // ignore parse errors
      }
      appendLine("info", `[exited with code ${code ?? "?"}]`);
      es.close();
      esRef.current = null;
      setRunning(false);
    });

    es.onerror = () => {
      appendLine("stderr", "[connection error]");
      es.close();
      esRef.current = null;
      setRunning(false);
    };
  }, [running, projectId, appendLine]);

  // Ctrl+C support
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        run();
      } else if (e.key === "c" && e.ctrlKey) {
        if (running) {
          e.preventDefault();
          abort();
        }
      }
    },
    [run, running, abort],
  );

  // Clean up EventSource on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg overflow-hidden bg-black font-mono text-sm border border-zinc-700",
        className,
      )}
    >
      {/* Output area */}
      <div
        ref={outputRef}
        className="min-h-[200px] overflow-y-auto p-3 flex-1 space-y-0.5"
      >
        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              "whitespace-pre-wrap break-all leading-5",
              line.kind === "stdout" && "text-green-300",
              line.kind === "stderr" && "text-red-400",
              line.kind === "info" && "text-zinc-400",
            )}
          >
            {line.text}
          </div>
        ))}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center gap-2 border-t border-zinc-700 bg-zinc-900 px-3 py-2">
        <span className="text-zinc-400 select-none">$</span>
        <input
          type="text"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter command…"
          className="flex-1 bg-transparent text-zinc-100 placeholder:text-zinc-600 outline-none caret-zinc-100"
          aria-label="Terminal input"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={running ? abort : run}
          disabled={!running && !cmd.trim()}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40",
            running
              ? "bg-red-600 text-white hover:bg-red-700"
              : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600",
          )}
        >
          {running ? "Abort" : "Run"}
        </button>
      </div>
    </div>
  );
}
