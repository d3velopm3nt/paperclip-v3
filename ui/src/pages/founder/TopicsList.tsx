import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Archive, RotateCcw, Trash2 } from "lucide-react";
import { topicsApi, type Topic } from "../../api/topics";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../../lib/utils";

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "text-xs px-1.5 py-0.5 rounded",
        status === "active"
          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

export function TopicsList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { companies } = useCompany();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCompanyId, setNewCompanyId] = useState<string>("");

  const topicsQuery = useQuery({
    queryKey: ["ecc-topics", showArchived ? "archived" : "active"],
    queryFn: () => topicsApi.list(showArchived ? "archived" : "active"),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      topicsApi.create({ name: newName.trim(), companyId: newCompanyId || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ecc-topics"] });
      setCreating(false);
      setNewName("");
      setNewCompanyId("");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "archived" }) =>
      topicsApi.update(id, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ecc-topics"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => topicsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ecc-topics"] });
    },
  });

  const companyById = new Map(companies.map((c) => [c.id, c]));
  const topics: Topic[] = topicsQuery.data ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {showArchived ? "Show active" : "Show archived"}
        </button>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="h-4 w-4 mr-1" />
          New Topic
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border p-4 space-y-3 bg-card">
          <h3 className="text-sm font-medium">New Topic</h3>
          <Input
            placeholder="Topic name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) createMutation.mutate();
              if (e.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            autoFocus
          />
          <select
            value={newCompanyId}
            onChange={(e) => setNewCompanyId(e.target.value)}
            className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
          >
            <option value="">Cross-company</option>
            {companies
              .filter((c) => c.status !== "archived")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Create
            </Button>
          </div>
        </div>
      )}

      {topicsQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading topics…</p>
      )}

      {topics.length === 0 && !topicsQuery.isLoading && (
        <p className="text-sm text-muted-foreground">
          {showArchived ? "No archived topics." : "No active topics. Create one to get started."}
        </p>
      )}

      {topics.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          {topics.map((topic, i) => {
            const company = topic.companyId ? companyById.get(topic.companyId) : null;
            return (
              <div
                key={topic.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 hover:bg-muted/30 cursor-pointer",
                  i > 0 && "border-t border-border",
                )}
                onClick={() => navigate(`/founder/topics/${topic.id}`)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{topic.name}</span>
                    <StatusBadge status={topic.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                    <span>{company ? company.name : "Cross-company"}</span>
                    {topic.currentState && (
                      <span className="truncate max-w-[200px]">{topic.currentState}</span>
                    )}
                    <span>
                      {topic.issueCount} issue{topic.issueCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    archiveMutation.mutate({
                      id: topic.id,
                      status: topic.status === "active" ? "archived" : "active",
                    });
                  }}
                  className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                  title={topic.status === "active" ? "Archive" : "Restore"}
                >
                  {topic.status === "active" ? (
                    <Archive className="h-4 w-4" />
                  ) : (
                    <RotateCcw className="h-4 w-4" />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Delete topic "${topic.name}"? This cannot be undone.`)) return;
                    deleteMutation.mutate(topic.id);
                  }}
                  disabled={deleteMutation.isPending}
                  className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0"
                  title="Delete topic"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
