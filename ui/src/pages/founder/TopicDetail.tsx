import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X, Trash2, Archive } from "lucide-react";
import { topicsApi, type LinkedIssue } from "../../api/topics";
import { issuesApi } from "../../api/issues";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../../lib/utils";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function TopicDetail() {
  const { topicId } = useParams<{ topicId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companies } = useCompany();

  const topicQuery = useQuery({
    queryKey: ["topic", topicId],
    queryFn: () => topicsApi.getById(topicId!),
    enabled: !!topicId,
  });

  const topic = topicQuery.data;

  const [name, setName] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [summary, setSummary] = useState("");
  const [companyId, setCompanyId] = useState<string>("");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (topic) {
      setName(topic.name);
      setCurrentState(topic.currentState ?? "");
      setSummary(topic.summary);
      setCompanyId(topic.companyId ?? "");
    }
  }, [topic]);

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof topicsApi.update>[1]) =>
      topicsApi.update(topicId!, data),
    onSuccess: () => {
      setLastSaved(new Date());
      setSaveError(false);
      queryClient.invalidateQueries({ queryKey: ["topics"] });
    },
    onError: () => setSaveError(true),
  });

  const debouncedSummary = useDebounce(summary, 1000);
  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      return;
    }
    if (!topicId || debouncedSummary === (topic?.summary ?? "")) return;
    updateMutation.mutate({ summary: debouncedSummary });
  }, [debouncedSummary]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveField = useCallback(
    (data: Parameters<typeof topicsApi.update>[1]) => {
      if (!topicId) return;
      updateMutation.mutate(data);
    },
    [topicId, updateMutation],
  );

  const linkIssueMutation = useMutation({
    mutationFn: (issueId: string) => topicsApi.linkIssue(topicId!, issueId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["topic", topicId] }),
  });

  const unlinkIssueMutation = useMutation({
    mutationFn: (issueId: string) => topicsApi.unlinkIssue(topicId!, issueId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["topic", topicId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => topicsApi.remove(topicId!),
    onSuccess: () => navigate("/founder/topics"),
  });

  const [issueSearch, setIssueSearch] = useState("");
  const [searchCompanyId, setSearchCompanyId] = useState(companies[0]?.id ?? "");

  const issueSearchQuery = useQuery({
    queryKey: ["issue-search", searchCompanyId, issueSearch],
    queryFn: () => issuesApi.list(searchCompanyId, { q: issueSearch }),
    enabled: issueSearch.length > 1 && !!searchCompanyId,
    staleTime: 10_000,
  });

  const activeCompanies = companies.filter((c) => c.status !== "archived");
  const companyById = new Map(activeCompanies.map((c) => [c.id, c]));
  const linkedIssueIds = new Set(topic?.issues.map((i) => i.id) ?? []);

  const savedMinutesAgo = lastSaved
    ? Math.round((Date.now() - lastSaved.getTime()) / 60000)
    : null;

  if (topicQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!topic) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Topic not found.</p>
        <Button variant="link" onClick={() => navigate("/founder/topics")}>
          Back to Topics
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <button
          onClick={() => navigate("/founder/topics")}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name.trim() !== topic.name && saveField({ name: name.trim() })
          }
          className="flex-1 text-lg font-semibold bg-transparent border-none outline-none"
          aria-label="Topic name"
        />
        <span className="text-xs text-muted-foreground">
          {saveError
            ? "Save failed"
            : savedMinutesAgo !== null
              ? savedMinutesAgo === 0
                ? "Saved just now"
                : `Saved ${savedMinutesAgo}m ago`
              : ""}
        </span>
      </div>

      {/* Body — two columns */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left: Memory */}
        <div className="flex-[3] flex flex-col border-r border-border overflow-auto p-6 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Current State
            </label>
            <Input
              value={currentState}
              onChange={(e) => setCurrentState(e.target.value)}
              onBlur={() => saveField({ currentState: currentState || null })}
              placeholder="Single-line status (e.g. Awaiting contract sign-off)"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Company
            </label>
            <select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                saveField({ companyId: e.target.value || null });
              }}
              className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
            >
              <option value="">Cross-company</option>
              {activeCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 space-y-1.5 flex flex-col">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Memory
            </label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Markdown notes, context, decisions…"
              className={cn("flex-1 min-h-[300px] resize-none font-mono text-sm")}
            />
            <p className="text-xs text-muted-foreground">Auto-saves 1s after you stop typing.</p>
          </div>
        </div>

        {/* Right: Context */}
        <div className="flex-[2] flex flex-col overflow-auto p-6 gap-4">
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Linked Issues
            </h3>
            {topic.issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">No issues linked yet.</p>
            ) : (
              <div className="space-y-1">
                {topic.issues.map((issue: LinkedIssue) => (
                  <div
                    key={issue.id}
                    className="flex items-center gap-2 text-sm rounded-md border border-border px-3 py-2"
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {issue.identifier ?? "—"}
                    </span>
                    <span className="flex-1 truncate">{issue.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {companyById.get(issue.companyId)?.name}
                    </span>
                    <button
                      onClick={() => unlinkIssueMutation.mutate(issue.id)}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      aria-label="Unlink issue"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Link issue search */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Link Issue
            </label>
            <select
              value={searchCompanyId}
              onChange={(e) => setSearchCompanyId(e.target.value)}
              className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
            >
              {activeCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Input
              value={issueSearch}
              onChange={(e) => setIssueSearch(e.target.value)}
              placeholder="Search by title…"
            />
            {issueSearchQuery.data && issueSearch.length > 1 && (
              <div className="rounded-md border border-border max-h-48 overflow-auto">
                {issueSearchQuery.data
                  .filter((i) => !linkedIssueIds.has(i.id))
                  .slice(0, 10)
                  .map((issue) => (
                    <button
                      key={issue.id}
                      onClick={() => {
                        linkIssueMutation.mutate(issue.id);
                        setIssueSearch("");
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center gap-2 border-b border-border last:border-0"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {issue.identifier}
                      </span>
                      <span className="truncate">{issue.title}</span>
                    </button>
                  ))}
                {issueSearchQuery.data.filter((i) => !linkedIssueIds.has(i.id)).length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No results.</p>
                )}
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="mt-auto pt-4 border-t border-border space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                saveField({ status: topic.status === "active" ? "archived" : "active" })
              }
            >
              <Archive className="h-4 w-4 mr-2" />
              {topic.status === "active" ? "Archive topic" : "Restore topic"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm(`Delete topic "${topic.name}"? This cannot be undone.`)) {
                  deleteMutation.mutate();
                }
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete topic
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
