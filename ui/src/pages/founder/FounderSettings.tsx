import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FounderProfile } from "@paperclipai/shared";

interface GeneralSettings {
  founderProfile?: FounderProfile;
  eaNotificationMatrix?: EaNotificationMatrix;
  operatorNotifyEmail?: string;
  [key: string]: unknown;
}

interface EaNotificationChannelConfig {
  high_risk_detected: boolean;
  approval_required: boolean;
  new_lead_created: boolean;
  proposal_request_detected: boolean;
  agent_blocked: boolean;
  topic_created: boolean;
  issue_created: boolean;
  urgent_item_detected: boolean;
  thread_reply_received: boolean;
}

interface EaNotificationMatrix {
  telegram: EaNotificationChannelConfig;
  email: EaNotificationChannelConfig;
}

const EA_CHANNEL_CONFIG_DEFAULTS: EaNotificationChannelConfig = {
  high_risk_detected: false,
  approval_required: false,
  new_lead_created: false,
  proposal_request_detected: false,
  agent_blocked: false,
  topic_created: false,
  issue_created: false,
  urgent_item_detected: false,
  thread_reply_received: false,
};

const EA_NOTIFICATION_DEFAULTS: EaNotificationMatrix = {
  telegram: {
    high_risk_detected: true,
    approval_required: true,
    new_lead_created: true,
    proposal_request_detected: true,
    agent_blocked: true,
    topic_created: false,
    issue_created: false,
    urgent_item_detected: true,
    thread_reply_received: false,
  },
  email: EA_CHANNEL_CONFIG_DEFAULTS,
};

const EA_NOTIFICATION_LABELS: Record<keyof EaNotificationChannelConfig, string> = {
  high_risk_detected: "High risk detected",
  approval_required: "Approval required",
  new_lead_created: "New lead created",
  proposal_request_detected: "Proposal request",
  agent_blocked: "Agent blocked",
  topic_created: "Topic created",
  issue_created: "Issue created",
  urgent_item_detected: "Urgent item",
  thread_reply_received: "Thread reply received",
};

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
  const [operatorNotifyEmail, setOperatorNotifyEmail] = useState("");
  const [emailSaved, setEmailSaved] = useState(false);

  useEffect(() => {
    const profile = settingsQuery.data?.founderProfile;
    if (profile) {
      setName(profile.name ?? "");
      setPersonalCompanyId(profile.personalCompanyId ?? "");
    }
    if (settingsQuery.data?.operatorNotifyEmail !== undefined) {
      setOperatorNotifyEmail(settingsQuery.data.operatorNotifyEmail ?? "");
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

  const rawMatrix = settingsQuery.data?.eaNotificationMatrix as EaNotificationMatrix | undefined;
  const matrix: EaNotificationMatrix = {
    telegram: { ...EA_NOTIFICATION_DEFAULTS.telegram, ...(rawMatrix?.telegram ?? {}) },
    email: { ...EA_CHANNEL_CONFIG_DEFAULTS, ...(rawMatrix?.email ?? {}) },
  };

  const updateMatrixMutation = useMutation({
    mutationFn: (newMatrix: EaNotificationMatrix) =>
      api.patch<GeneralSettings>("/instance/settings/general", {
        eaNotificationMatrix: newMatrix,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["instance-settings-general"] }),
  });

  const saveEmailMutation = useMutation({
    mutationFn: (email: string) =>
      api.patch<GeneralSettings>("/instance/settings/general", {
        operatorNotifyEmail: email || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["instance-settings-general"] });
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 2000);
    },
  });

  function toggleMatrixEvent(
    channel: keyof EaNotificationMatrix,
    event: keyof EaNotificationChannelConfig,
  ) {
    const updated: EaNotificationMatrix = {
      ...matrix,
      [channel]: {
        ...matrix[channel],
        [event]: !matrix[channel][event],
      },
    };
    updateMatrixMutation.mutate(updated);
  }

  if (settingsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading settings…</div>;
  }

  return (
    <div className="max-w-md space-y-8">
      <div className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Founder Profile</h2>
          <p className="text-sm text-muted-foreground">
            Configure your identity. The founder name is injected into the EA agent&apos;s system
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
              Used as the header label in Founder Overview and in the EA agent&apos;s context.
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

      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">EA Notification Matrix</h2>
          <p className="text-sm text-muted-foreground">
            Control which events trigger notifications per channel from the Executive Agent.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Event</th>
                <th className="text-center py-2 px-4 w-24 font-medium text-muted-foreground">Telegram</th>
                <th className="text-center py-2 px-4 w-24 font-medium text-muted-foreground">Email</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(EA_NOTIFICATION_LABELS) as Array<keyof EaNotificationChannelConfig>).map((event) => (
                <tr key={event} className="border-b border-border last:border-0">
                  <td className="py-2 px-4 text-sm">{EA_NOTIFICATION_LABELS[event]}</td>
                  {(["telegram", "email"] as const).map((channel) => (
                    <td key={channel} className="py-2 px-4 text-center">
                      <button
                        type="button"
                        onClick={() => toggleMatrixEvent(channel, event)}
                        disabled={updateMatrixMutation.isPending}
                        aria-label={`Toggle ${EA_NOTIFICATION_LABELS[event]} for ${channel}`}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                          matrix[channel][event] ? "bg-primary" : "bg-muted"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                            matrix[channel][event] ? "translate-x-4" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-1.5 pt-1">
          <label className="text-sm font-medium">Notification email address</label>
          <p className="text-xs text-muted-foreground">
            Required for email channel notifications. Leave blank to disable email.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="email"
              value={operatorNotifyEmail}
              onChange={(e) => setOperatorNotifyEmail(e.target.value)}
              placeholder="operator@example.com"
              className="max-w-xs"
            />
            <Button
              size="sm"
              onClick={() => saveEmailMutation.mutate(operatorNotifyEmail)}
              disabled={saveEmailMutation.isPending}
            >
              {saveEmailMutation.isPending ? "Saving…" : "Save"}
            </Button>
            {emailSaved && <span className="text-sm text-muted-foreground">Saved!</span>}
            {saveEmailMutation.isError && <span className="text-sm text-destructive">Save failed</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
