import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { roomsApi } from "../../api/rooms";
import { issuesApi } from "../../api/issues";
import { projectsApi } from "../../api/projects";
import { clientsApi } from "../../api/clients";
import { referenceDocumentsApi } from "../../api/referenceDocuments";
import { MentionPopup, type MentionItem } from "./MentionPopup";
import type { ContextRef } from "../../api/chat";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

interface Props {
  companyId: string;
  onSend: (body: string, contextRefs: ContextRef[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

type MentionTrigger = "@" | "#" | "$" | "/" | "%" | "*" | null;

const CONTEXT_REF_COLORS: Record<ContextRef["type"], string> = {
  agent:    "bg-blue-950 border-blue-800 text-blue-300",
  project:  "bg-violet-950 border-violet-800 text-violet-300",
  client:   "bg-orange-950 border-orange-800 text-orange-300",
  issue:    "bg-emerald-950 border-emerald-800 text-emerald-300",
  document: "bg-purple-950 border-purple-800 text-purple-300",
};

export function ChatComposer({ companyId, onSend, disabled, placeholder }: Props) {
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

  const { data: projectList = [] } = useQuery({
    queryKey: ["projects", companyId],
    queryFn: () => projectsApi.list(companyId),
    enabled: mentionTrigger === "/",
  });

  const { data: clientList = [] } = useQuery({
    queryKey: ["clients", companyId],
    queryFn: () => clientsApi.list(companyId),
    enabled: mentionTrigger === "%",
  });

  const { data: docList = [] } = useQuery({
    queryKey: ["reference-docs", companyId],
    queryFn: () => referenceDocumentsApi.list(companyId),
    enabled: mentionTrigger === "*",
  });

  const selectedProjectIds = contextRefs.filter((r) => r.type === "project").map((r) => r.id);

  const { data: selectedProjectWorkspaces = [], isLoading: workspacesLoading } = useQuery({
    queryKey: ["project-workspaces-chat", ...selectedProjectIds],
    queryFn: () =>
      Promise.all(selectedProjectIds.map((id) => projectsApi.listWorkspaces(id, companyId))).then((results) =>
        results.flat(),
      ),
    enabled: selectedProjectIds.length > 0,
  });

  const LOCAL_SOURCE_TYPES = ["local_path", "non_git_path"];

  const projectsWithNoLocalPath = workspacesLoading
    ? []
    : selectedProjectIds.filter(
        (id) => !selectedProjectWorkspaces.some((w) => w.projectId === id && w.cwd),
      );

  function getMentionItems(): MentionItem[] {
    const q = mentionQuery.toLowerCase();
    if (mentionTrigger === "@") {
      return agents
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((a) => ({ label: a.name, value: `@agent:${a.id}`, sublabel: a.role }));
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
    if (mentionTrigger === "/") {
      return projectList
        .filter((p) => p.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((p) => ({ label: p.name, value: `/project:${p.id}`, sublabel: p.status }));
    }
    if (mentionTrigger === "%") {
      return clientList
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ label: c.name, value: `%client:${c.id}` }));
    }
    if (mentionTrigger === "*") {
      return docList
        .filter((d) => d.title.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q))
        .slice(0, 8)
        .map((d) => ({ label: d.title, value: `*doc:${d.id}`, sublabel: d.description ?? d.sourceType }));
    }
    return [];
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setBody(val);

    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atMatch    = before.match(/(?:^|\s)@([\w-]*)$/);
    const hashMatch  = before.match(/(?:^|\s)#([\w-]*)$/);
    const dollarMatch = before.match(/(?:^|\s)\$([\w:]*)$/);
    const slashMatch = before.match(/(?:^|\s)\/([\w-]*)$/);
    const pctMatch   = before.match(/(?:^|\s)%([\w-]*)$/);
    const starMatch  = before.match(/(?:^|\s)\*([\w-]*)$/);

    if (atMatch) {
      setMentionTrigger("@");
      setMentionQuery(atMatch[1] ?? "");
    } else if (hashMatch) {
      setMentionTrigger("#");
      setMentionQuery(hashMatch[1] ?? "");
    } else if (dollarMatch) {
      setMentionTrigger("$");
      setMentionQuery(dollarMatch[1] ?? "");
    } else if (slashMatch) {
      setMentionTrigger("/");
      setMentionQuery(slashMatch[1] ?? "");
    } else if (pctMatch) {
      setMentionTrigger("%");
      setMentionQuery(pctMatch[1] ?? "");
    } else if (starMatch) {
      setMentionTrigger("*");
      setMentionQuery(starMatch[1] ?? "");
    } else {
      setMentionTrigger(null);
      setMentionQuery("");
    }
  }

  function addContextRef(ref: ContextRef) {
    setContextRefs((prev) => [...prev.filter((r) => r.id !== ref.id), ref]);
  }

  function handleMentionSelect(item: MentionItem) {
    if (mentionTrigger === "@") {
      setBody((prev) => prev.replace(/@[\w-]*$/, "").trimEnd());
      const agentId = item.value.replace("@agent:", "");
      addContextRef({ type: "agent", id: agentId, label: item.label });
    } else if (mentionTrigger === "$") {
      setBody((prev) => prev.replace(/\$([\w:]*)$/, "").trimEnd());
      const issueId = item.value.replace("$issue:", "");
      addContextRef({ type: "issue", id: issueId, label: item.label });
    } else if (mentionTrigger === "/") {
      setBody((prev) => prev.replace(/\/[\w-]*$/, "").trimEnd());
      const projectId = item.value.replace("/project:", "");
      addContextRef({ type: "project", id: projectId, label: item.label });
    } else if (mentionTrigger === "%") {
      setBody((prev) => prev.replace(/%[\w-]*$/, "").trimEnd());
      const clientId = item.value.replace("%client:", "");
      addContextRef({ type: "client", id: clientId, label: item.label });
    } else if (mentionTrigger === "*") {
      setBody((prev) => prev.replace(/\*[\w-]*$/, "").trimEnd());
      const docId = item.value.replace("*doc:", "");
      addContextRef({ type: "document", id: docId, label: item.label });
    } else {
      // #room — insert as text
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
              className={`inline-flex items-center gap-1 rounded-md border text-xs px-2 py-0.5 ${CONTEXT_REF_COLORS[ref.type]}`}
            >
              <span className="text-[10px] opacity-60">{ref.type}</span>
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

      {projectsWithNoLocalPath.length > 0 && (
        <div className="flex items-center gap-1.5 rounded-md bg-orange-950/60 border border-orange-800/60 px-2.5 py-1.5 text-[11px] text-orange-300">
          <span>⚠</span>
          <span>
            {contextRefs
              .filter((r) => r.type === "project" && projectsWithNoLocalPath.includes(r.id))
              .map((r) => r.label)
              .join(", ")}{" "}
            has no local folder set — agent cannot read code files.
          </span>
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
          placeholder={placeholder ?? "Message — @agent  $issue  /project  %client  *doc  #room"}
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
