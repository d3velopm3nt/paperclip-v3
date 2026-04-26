import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { roomsApi } from "../../api/rooms";
import { issuesApi } from "../../api/issues";
import { MentionPopup, type MentionItem } from "./MentionPopup";
import type { ContextRef } from "../../api/chat";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

interface Props {
  companyId: string;
  onSend: (body: string, contextRefs: ContextRef[]) => void;
  disabled?: boolean;
}

type MentionTrigger = "@" | "#" | "$" | null;

export function ChatComposer({ companyId, onSend, disabled }: Props) {
  const [body, setBody] = useState("");
  const [contextRefs, setContextRefs] = useState<ContextRef[]>([]);
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: agents = [] } = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", companyId],
    queryFn: () => roomsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: issueList = [] } = useQuery({
    queryKey: ["issues", companyId, "all"],
    queryFn: () => issuesApi.list(companyId),
    enabled: mentionTrigger === "$",
  });

  function getMentionItems(): MentionItem[] {
    const q = mentionQuery.toLowerCase();
    if (mentionTrigger === "@") {
      return agents
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((a) => ({ label: a.name, value: `@${a.name}` }));
    }
    if (mentionTrigger === "#") {
      return rooms
        .filter((r) => r.slug.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((r) => ({ label: r.name, value: `#${r.slug}` }));
    }
    if (mentionTrigger === "$") {
      return issueList
        .filter(
          (i) =>
            i.title?.toLowerCase().includes(q) ||
            (i.identifier?.toLowerCase() ?? "").includes(q),
        )
        .slice(0, 8)
        .map((i) => ({
          label: i.identifier ?? i.id,
          value: `$issue:${i.id}`,
          sublabel: i.title ?? undefined,
        }));
    }
    return [];
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setBody(val);

    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atMatch = before.match(/(?:^|\s)@([\w-]*)$/);
    const hashMatch = before.match(/(?:^|\s)#([\w-]*)$/);
    const dollarMatch = before.match(/(?:^|\s)\$([\w:]*)$/);

    if (atMatch) {
      setMentionTrigger("@");
      setMentionQuery(atMatch[1] ?? "");
    } else if (hashMatch) {
      setMentionTrigger("#");
      setMentionQuery(hashMatch[1] ?? "");
    } else if (dollarMatch) {
      setMentionTrigger("$");
      setMentionQuery(dollarMatch[1] ?? "");
    } else {
      setMentionTrigger(null);
      setMentionQuery("");
    }
  }

  function handleMentionSelect(item: MentionItem) {
    if (mentionTrigger === "$") {
      setBody((prev) => prev.replace(/\$([\w:]*)$/, "").trimEnd());
      const issueId = item.value.replace("$issue:", "");
      setContextRefs((prev) => [
        ...prev.filter((r) => r.id !== issueId),
        { type: "issue", id: issueId, label: item.label },
      ]);
    } else {
      const trigger = mentionTrigger!;
      setBody((prev) => {
        const re = new RegExp(`${trigger}[\\w-]*$`);
        return prev.replace(re, item.value);
      });
    }
    setMentionTrigger(null);
    setMentionQuery("");
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && mentionTrigger === null) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, contextRefs);
    setBody("");
    setContextRefs([]);
    setMentionTrigger(null);
  }

  return (
    <div className="border-t border-border p-3 flex flex-col gap-2">
      {contextRefs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {contextRefs.map((ref) => (
            <span
              key={ref.id}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-950 border border-emerald-800 text-emerald-300 text-xs px-2 py-0.5"
            >
              {ref.label}
              <button
                type="button"
                className="ml-0.5 hover:text-white"
                onClick={() => setContextRefs((prev) => prev.filter((r) => r.id !== ref.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative flex items-end gap-2">
        <MentionPopup
          open={mentionTrigger !== null}
          items={getMentionItems()}
          onSelect={handleMentionSelect}
          onClose={() => setMentionTrigger(null)}
        />
        <textarea
          ref={textareaRef}
          rows={1}
          value={body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Message — use @agent, #room, $issue…"
          className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 min-h-[38px] max-h-32"
          style={{ height: "auto" }}
          onInput={(e) => {
            const t = e.currentTarget;
            t.style.height = "auto";
            t.style.height = `${Math.min(t.scrollHeight, 128)}px`;
          }}
        />
        <Button
          size="icon"
          onClick={submit}
          disabled={disabled || !body.trim()}
          className="shrink-0 h-[38px] w-[38px]"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
