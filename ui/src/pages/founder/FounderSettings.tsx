import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { channelsApi } from "../../api/channels";
import { useCompany } from "../../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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

  // ── Channels (Telegram) ──────────────────────────────────────────────────
  const channelsQuery = useQuery({
    queryKey: ["channels-status"],
    queryFn: () => channelsApi.status(),
    staleTime: 30_000,
  });
  const tg = channelsQuery.data?.telegram;

  const [tokenInput, setTokenInput] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  const setTokenMutation = useMutation({
    mutationFn: () => channelsApi.setTelegramToken(tokenInput.trim()),
    onSuccess: () => {
      setTokenInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const deleteTokenMutation = useMutation({
    mutationFn: () => channelsApi.deleteTelegramToken(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  const setChatIdMutation = useMutation({
    mutationFn: () => channelsApi.setTelegramOperatorChatId(chatIdInput.trim()),
    onSuccess: () => {
      setChatIdInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const detectMutation = useMutation({
    mutationFn: () => channelsApi.detectTelegramOperatorChatId(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
      setDetectMsg(
        data.chatId
          ? `Detected: ${data.chatId}`
          : "No recent message found — send a message to the bot first.",
      );
      setTimeout(() => setDetectMsg(null), 5000);
    },
    onError: () => {
      setDetectMsg("Detection failed. Bot may not be configured.");
      setTimeout(() => setDetectMsg(null), 4000);
    },
  });

  const testMutation = useMutation({
    mutationFn: () => channelsApi.testTelegram(),
    onSuccess: () => {
      setTestMsg("Test message sent!");
      setTimeout(() => setTestMsg(null), 3000);
    },
    onError: () => {
      setTestMsg("Failed to send. Check bot token and chat ID.");
      setTimeout(() => setTestMsg(null), 3000);
    },
  });

  // ── Instance settings (Profile + Notifications) ──────────────────────────
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
    <Tabs defaultValue="profile" className="w-full max-w-2xl">
      <TabsList className="mb-6">
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="channels">Channels</TabsTrigger>
        <TabsTrigger value="notifications">Notifications</TabsTrigger>
      </TabsList>

      {/* ── Profile ─────────────────────────────────────────────────────── */}
      <TabsContent value="profile">
        <div className="space-y-6 max-w-md">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Founder Profile</h2>
            <p className="text-sm text-muted-foreground">
              Your identity injected into the EA agent's system prompt.
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
                Used in the Founder Overview header and in the EA agent's context.
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
                Gets a "Personal" badge in the Overview — use for Finance, Home, Family topics.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
              {saved && <span className="text-sm text-muted-foreground">Saved!</span>}
              {saveMutation.isError && (
                <span className="text-sm text-destructive">Save failed</span>
              )}
            </div>
          </div>
        </div>
      </TabsContent>

      {/* ── Channels ────────────────────────────────────────────────────── */}
      <TabsContent value="channels">
        <div className="space-y-6 max-w-md">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Telegram</h2>
            <p className="text-sm text-muted-foreground">
              The bot used to notify you and receive replies as the operator.
            </p>
          </div>

          <div className="space-y-5">
            {/* Bot token */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Bot token</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    tg?.tokenSet
                      ? "bg-green-500/15 text-green-600 dark:text-green-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {tg?.tokenSet ? `configured · ${tg.tokenSource ?? "db"}` : "not set"}
                </span>
              </div>
              {tg?.bot && (
                <p className="text-xs text-muted-foreground">
                  @{tg.bot.username} — {tg.bot.firstName}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Input
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={tg?.tokenSet ? "Paste new token to replace…" : "Paste token from @BotFather"}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  onClick={() => setTokenMutation.mutate()}
                  disabled={!tokenInput.trim() || setTokenMutation.isPending}
                >
                  {setTokenMutation.isPending ? "Saving…" : "Save"}
                </Button>
                {tg?.tokenSet && tg.tokenSource === "db" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive shrink-0"
                    onClick={() => deleteTokenMutation.mutate()}
                    disabled={deleteTokenMutation.isPending}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>

            {/* Operator chat ID */}
            <div className="space-y-2 border-t border-border pt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Operator chat ID</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium font-mono ${
                    tg?.operatorChatId
                      ? "bg-green-500/15 text-green-600 dark:text-green-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {tg?.operatorChatId ?? "not set"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Send any message to your bot, then click Detect. Or paste your chat ID manually.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={chatIdInput}
                  onChange={(e) => setChatIdInput(e.target.value)}
                  placeholder="Manual override"
                  className="font-mono text-xs max-w-[160px]"
                />
                <Button
                  size="sm"
                  onClick={() => setChatIdMutation.mutate()}
                  disabled={!chatIdInput.trim() || setChatIdMutation.isPending}
                >
                  {setChatIdMutation.isPending ? "Saving…" : "Set"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => detectMutation.mutate()}
                  disabled={detectMutation.isPending || !tg?.tokenSet}
                >
                  {detectMutation.isPending ? "Detecting…" : "Detect"}
                </Button>
              </div>
              {detectMsg && <p className="text-xs text-muted-foreground">{detectMsg}</p>}
            </div>

            {/* Test */}
            <div className="border-t border-border pt-5 flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending || !tg?.tokenSet || !tg?.operatorChatId}
              >
                {testMutation.isPending ? "Sending…" : "Send test message"}
              </Button>
              {testMsg && <span className="text-xs text-muted-foreground">{testMsg}</span>}
            </div>
          </div>
        </div>
      </TabsContent>

      {/* ── Notifications ───────────────────────────────────────────────── */}
      <TabsContent value="notifications">
        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">EA Notification Matrix</h2>
            <p className="text-sm text-muted-foreground">
              Control which events trigger operator notifications per channel.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Event</th>
                  <th className="text-center py-2.5 px-4 w-28 font-medium text-muted-foreground">Telegram</th>
                  <th className="text-center py-2.5 px-4 w-28 font-medium text-muted-foreground">Email</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(EA_NOTIFICATION_LABELS) as Array<keyof EaNotificationChannelConfig>).map(
                  (event) => (
                    <tr key={event} className="border-b border-border last:border-0">
                      <td className="py-2.5 px-4">{EA_NOTIFICATION_LABELS[event]}</td>
                      {(["telegram", "email"] as const).map((channel) => (
                        <td key={channel} className="py-2.5 px-4 text-center">
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
                  ),
                )}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5 max-w-md">
            <label className="text-sm font-medium">Notification email</label>
            <p className="text-xs text-muted-foreground">
              Required for email channel. Leave blank to disable.
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
              {saveEmailMutation.isError && (
                <span className="text-sm text-destructive">Save failed</span>
              )}
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}
