import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag, Trash2, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { emailLabelDefinitionsApi } from "../api/emailLabelDefinitions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PRESET_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
  "#1abc9c", "#3498db", "#9b59b6", "#6b7280",
];

export function EmailLabels() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId!;
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[7]!);

  useEffect(() => {
    setBreadcrumbs([{ label: "Email Labels" }]);
  }, [setBreadcrumbs]);

  const labelsQuery = useQuery({
    queryKey: queryKeys.emailLabelDefinitions.list(companyId),
    queryFn: () => emailLabelDefinitionsApi.list(companyId),
    enabled: !!companyId,
  });

  const createMutation = useMutation({
    mutationFn: () => emailLabelDefinitionsApi.create(companyId, newName.trim(), newColor),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.emailLabelDefinitions.list(companyId) });
      setNewName("");
      pushToast({ tone: "success", title: "Label created" });
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Failed", body: err.message }),
  });

  const removeMutation = useMutation({
    mutationFn: (labelId: string) => emailLabelDefinitionsApi.remove(companyId, labelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.emailLabelDefinitions.list(companyId) });
      pushToast({ tone: "success", title: "Label removed" });
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Failed", body: err.message }),
  });

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;

  return (
    <div className="p-6 max-w-lg space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Tag className="h-6 w-6" />
          Email Labels
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Define tags for categorizing inbound emails. The EA agent can apply these via Telegram.
        </p>
      </div>

      {/* Add new label */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium">Add label</h2>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Label name (e.g. spam, marketing, AI)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) createMutation.mutate();
            }}
            className="h-8 text-sm flex-1"
          />
          <Button
            size="sm"
            disabled={!newName.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setNewColor(c)}
              className={`h-6 w-6 rounded-full transition-all ${newColor === c ? "ring-2 ring-offset-2 ring-foreground/50 scale-110" : "hover:scale-105"}`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <span className="text-xs text-muted-foreground ml-1">Color</span>
        </div>
      </div>

      {/* Existing labels */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Defined labels</h2>
        {labelsQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (labelsQuery.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No labels yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {(labelsQuery.data ?? []).map((lbl) => (
              <li key={lbl.id} className="flex items-center gap-3 px-3 py-2.5">
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ background: lbl.color }}
                />
                <span className="flex-1 text-sm">{lbl.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{lbl.color}</span>
                <button
                  onClick={() => removeMutation.mutate(lbl.id)}
                  disabled={removeMutation.isPending}
                  className="text-muted-foreground/60 hover:text-destructive transition-colors"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
