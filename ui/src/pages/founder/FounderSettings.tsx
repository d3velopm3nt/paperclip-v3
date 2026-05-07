import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FounderProfile } from "@paperclipai/shared";

interface GeneralSettings {
  founderProfile?: FounderProfile;
  [key: string]: unknown;
}

export function FounderSettings() {
  const queryClient = useQueryClient();
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");

  const settingsQuery = useQuery({
    queryKey: ["instance-settings-general"],
    queryFn: () => api.get<GeneralSettings>("/instance/settings/general"),
    staleTime: 60_000,
  });

  const [name, setName] = useState("");
  const [personalCompanyId, setPersonalCompanyId] = useState<string>("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const profile = settingsQuery.data?.founderProfile;
    if (profile) {
      setName(profile.name ?? "");
      setPersonalCompanyId(profile.personalCompanyId ?? "");
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch<GeneralSettings>("/instance/settings/general", {
        founderProfile: {
          name: name.trim(),
          personalCompanyId: personalCompanyId || null,
        },
      }),
    onSuccess: () => {
      localStorage.setItem("founder.personalCompanyId", personalCompanyId || "");
      queryClient.invalidateQueries({ queryKey: ["instance-settings-general"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  if (settingsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading settings…</div>;
  }

  return (
    <div className="max-w-md space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Founder Profile</h2>
        <p className="text-sm text-muted-foreground">
          Configure your identity. The founder name is injected into the ECC agent&apos;s system
          prompt so it knows who it&apos;s talking to.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Founder name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
          <p className="text-xs text-muted-foreground">
            Used as the header label in Founder Overview and in the ECC agent&apos;s context.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Personal company</label>
          <select
            value={personalCompanyId}
            onChange={(e) => setPersonalCompanyId(e.target.value)}
            className="w-full text-sm rounded-md border border-input bg-background px-3 py-1.5"
          >
            <option value="">None selected</option>
            {activeCompanies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            This company gets a &quot;Personal&quot; badge in the Overview. Use it for Finance,
            Family, Home Maintenance, and other personal life topics.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save settings"}
          </Button>
          {saved && <span className="text-sm text-muted-foreground">Saved!</span>}
          {saveMutation.isError && (
            <span className="text-sm text-destructive">Save failed</span>
          )}
        </div>
      </div>
    </div>
  );
}
