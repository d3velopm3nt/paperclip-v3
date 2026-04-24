// v3: per-email-account detail page with tabs (Settings / Agent & Role / Voice).
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  emailAccountsApi,
  type EmailAccount,
  type EmailAccountUpdateRequest,
} from "../api/emailAccounts";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { Plus } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { ArrowLeft, Plug, Save } from "lucide-react";

type TabKey = "settings" | "agent" | "voice";

interface FormState {
  label: string;
  role: "inbound" | "agent_voice";
  folder: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  pollIntervalSec: string;
  active: boolean;
  imapHost: string;
  imapPort: string;
  imapUser: string;
  imapPassword: string;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  smtpSecure: boolean;
  smtpSameAsImap: boolean;
  teamEmails: string;
  triageAgentId: string;
  replyFromAccountId: string;
  autoAcknowledge: boolean;
  ackSubject: string;
  ackBody: string;
}

function accountToForm(a: EmailAccount): FormState {
  const sameAsImap =
    !!a.smtpHost && a.smtpHost === a.imapHost && (a.smtpUser ?? a.imapUser) === a.imapUser;
  return {
    label: a.label,
    role: a.role,
    folder: a.folder,
    fromName: a.fromName,
    fromEmail: a.fromEmail,
    replyTo: a.replyTo ?? "",
    pollIntervalSec: String(a.pollIntervalSec),
    active: a.active,
    imapHost: a.imapHost,
    imapPort: String(a.imapPort),
    imapUser: a.imapUser,
    imapPassword: "",
    imapTls: a.imapTls,
    smtpHost: a.smtpHost ?? "",
    smtpPort: a.smtpPort ? String(a.smtpPort) : "587",
    smtpUser: a.smtpUser ?? "",
    smtpPassword: "",
    smtpSecure: a.smtpSecure,
    smtpSameAsImap: sameAsImap,
    teamEmails: (a.teamEmails ?? []).join(", "),
    triageAgentId: a.triageAgentId ?? "",
    replyFromAccountId: a.replyFromAccountId ?? "",
    autoAcknowledge: a.autoAcknowledge,
    ackSubject: a.ackSubject ?? "",
    ackBody: a.ackBody ?? "",
  };
}

export function EmailAccountDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const id = params.id!;
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyId = selectedCompanyId!;
  const ownerEmail = selectedCompany?.ownerEmail ?? null;
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<TabKey>("settings");
  const [form, setForm] = useState<FormState | null>(null);

  const detailQuery = useQuery({
    queryKey: queryKeys.emailAccounts.detail(id),
    queryFn: () => emailAccountsApi.get(id),
    enabled: !!id,
  });

  const accountsQuery = useQuery({
    queryKey: queryKeys.emailAccounts.list(companyId),
    queryFn: () => emailAccountsApi.list(companyId),
    enabled: !!companyId,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", "list", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  useEffect(() => {
    if (detailQuery.data) {
      setForm(accountToForm(detailQuery.data));
      setBreadcrumbs([
        { label: "Email Accounts", href: "/email/accounts" },
        { label: detailQuery.data.label },
      ]);
    }
  }, [detailQuery.data, setBreadcrumbs]);

  const updateMutation = useMutation({
    mutationFn: (data: EmailAccountUpdateRequest) => emailAccountsApi.update(id, data),
    onSuccess: (updated) => {
      pushToast({ title: "Saved", tone: "success" });
      qc.setQueryData(queryKeys.emailAccounts.detail(id), updated);
      qc.invalidateQueries({ queryKey: queryKeys.emailAccounts.list(companyId) });
      setForm(accountToForm(updated));
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Save failed", body: err.message }),
  });

  const testImapMutation = useMutation({
    mutationFn: () => emailAccountsApi.testConnection(id),
    onSuccess: (r) => {
      if (r.ok) pushToast({ title: "IMAP OK", tone: "success" });
      else pushToast({ tone: "warn", title: "IMAP failed", body: r.error });
    },
  });

  const testSmtpMutation = useMutation({
    mutationFn: () => emailAccountsApi.testSmtp(id),
    onSuccess: (r) => {
      if (r.ok) pushToast({ title: "SMTP OK", tone: "success" });
      else pushToast({ tone: "warn", title: "SMTP failed", body: r.error });
    },
  });

  if (detailQuery.isLoading || !form || !detailQuery.data) return <PageSkeleton />;
  const account = detailQuery.data;

  function save() {
    if (!form) return;
    const port = parseInt(form.imapPort, 10);
    if (!Number.isInteger(port)) {
      pushToast({ tone: "warn", title: "IMAP port must be a number" });
      return;
    }
    const smtpPortNum = parseInt(form.smtpPort, 10);
    const teamEmailsArr = form.teamEmails
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const hasSmtp = !!form.smtpHost;
    const data: EmailAccountUpdateRequest = {
      label: form.label,
      role: form.role,
      teamEmails: teamEmailsArr,
      triageAgentId: form.triageAgentId.trim() || null,
      replyFromAccountId: form.replyFromAccountId.trim() || null,
      autoAcknowledge: form.autoAcknowledge,
      ackSubject: form.ackSubject.trim() || null,
      ackBody: form.ackBody.trim() || null,
      folder: form.folder,
      fromName: form.fromName,
      fromEmail: form.fromEmail,
      replyTo: form.replyTo || null,
      pollIntervalSec: parseInt(form.pollIntervalSec, 10) || 60,
      active: form.active,
      imapHost: form.imapHost,
      imapPort: port,
      imapUser: form.imapUser,
      imapTls: form.imapTls,
      smtpHost: hasSmtp ? form.smtpHost : null,
      smtpPort: hasSmtp && Number.isInteger(smtpPortNum) ? smtpPortNum : null,
      smtpUser: hasSmtp ? (form.smtpSameAsImap ? form.imapUser : form.smtpUser) : null,
      smtpSecure: form.smtpSecure,
    };
    if (form.imapPassword) data.imapPassword = form.imapPassword;
    if (hasSmtp && !form.smtpSameAsImap && form.smtpPassword) data.smtpPassword = form.smtpPassword;
    if (hasSmtp && form.smtpSameAsImap && form.imapPassword) data.smtpPassword = form.imapPassword;
    updateMutation.mutate(data);
  }

  const otherAccounts = (accountsQuery.data ?? []).filter((a) => a.id !== id);
  const agents = agentsQuery.data ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("/email/accounts")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Accounts
          </Button>
          <h1 className="text-xl font-semibold">{account.label}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              account.role === "agent_voice"
                ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                : "bg-blue-500/15 text-blue-700 dark:text-blue-300"
            }`}
          >
            {account.role === "agent_voice" ? "agent voice" : "inbound"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testImapMutation.mutate()}
            disabled={testImapMutation.isPending}
          >
            <Plug className="h-4 w-4 mr-1" />
            {testImapMutation.isPending ? "Testing…" : "Test IMAP"}
          </Button>
          {account.smtpHost && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => testSmtpMutation.mutate()}
              disabled={testSmtpMutation.isPending}
            >
              <Plug className="h-4 w-4 mr-1" />
              {testSmtpMutation.isPending ? "Testing…" : "Test SMTP"}
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={updateMutation.isPending}>
            <Save className="h-4 w-4 mr-1" />
            {updateMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-4">
        <PageTabBar
          align="start"
          items={[
            { value: "settings", label: "Email settings" },
            { value: "agent", label: "Agent & Role" },
            { value: "voice", label: "Voice" },
          ]}
          value={tab}
          onValueChange={(v) => setTab(v as TabKey)}
        />

        <TabsContent value="settings" className="space-y-5">
          <Card className="p-5 space-y-5">
            <Section title="General">
              <Grid>
                <Field label="Label" value={form.label} onChange={(v) => setForm({ ...form, label: v })} />
                <Field label="Folder" value={form.folder} onChange={(v) => setForm({ ...form, folder: v })} />
                <Field label="From name" value={form.fromName} onChange={(v) => setForm({ ...form, fromName: v })} />
                <Field label="From email" value={form.fromEmail} onChange={(v) => setForm({ ...form, fromEmail: v })} />
                <Field label="Reply-To (optional)" value={form.replyTo} onChange={(v) => setForm({ ...form, replyTo: v })} />
                <Field label="Poll interval (sec)" value={form.pollIntervalSec} onChange={(v) => setForm({ ...form, pollIntervalSec: v })} />
                <Toggle label="Active" value={form.active} onChange={(v) => setForm({ ...form, active: v })} />
              </Grid>
            </Section>
            <Section title="Incoming mail (IMAP)">
              <Grid>
                <Field label="IMAP host" value={form.imapHost} onChange={(v) => setForm({ ...form, imapHost: v })} />
                <Field label="IMAP port" value={form.imapPort} onChange={(v) => setForm({ ...form, imapPort: v })} />
                <Field label="IMAP user" value={form.imapUser} onChange={(v) => setForm({ ...form, imapUser: v })} />
                <Field label="IMAP password (blank = keep)" type="password" value={form.imapPassword} onChange={(v) => setForm({ ...form, imapPassword: v })} />
                <Toggle label="TLS" value={form.imapTls} onChange={(v) => setForm({ ...form, imapTls: v })} />
              </Grid>
            </Section>
            <Section title="Outgoing mail (SMTP)">
              <Toggle
                label="Same server as IMAP"
                value={form.smtpSameAsImap}
                onChange={(v) =>
                  setForm({
                    ...form,
                    smtpSameAsImap: v,
                    smtpHost: v ? form.imapHost : form.smtpHost,
                  })
                }
              />
              <Grid>
                <Field label="SMTP host" value={form.smtpHost} onChange={(v) => setForm({ ...form, smtpHost: v })} />
                <Field label="SMTP port" value={form.smtpPort} onChange={(v) => setForm({ ...form, smtpPort: v })} />
                {!form.smtpSameAsImap && (
                  <>
                    <Field label="SMTP user" value={form.smtpUser} onChange={(v) => setForm({ ...form, smtpUser: v })} />
                    <Field label="SMTP password (blank = keep)" type="password" value={form.smtpPassword} onChange={(v) => setForm({ ...form, smtpPassword: v })} />
                  </>
                )}
                <Toggle label="TLS (secure)" value={form.smtpSecure} onChange={(v) => setForm({ ...form, smtpSecure: v })} />
              </Grid>
            </Section>
          </Card>
        </TabsContent>

        <TabsContent value="agent" className="space-y-5">
          <Card className="p-5 space-y-5">
            <Section title="Role">
              <label className="flex flex-col gap-1 text-sm max-w-md">
                <span className="text-muted-foreground">Account role</span>
                <select
                  className="border border-input bg-background rounded-md h-9 px-2 text-sm"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as FormState["role"] })}
                >
                  <option value="inbound">Inbound — polls IMAP, replies to clients</option>
                  <option value="agent_voice">Agent voice — sends operator/team notifications</option>
                </select>
              </label>
            </Section>
            {form.role === "inbound" && (
              <>
                <Section title="Triage agent">
                  <p className="text-xs text-muted-foreground mb-2">
                    Agent that owns plans from emails received on this inbox. Falls back to company CEO agent.
                  </p>
                  <label className="flex flex-col gap-1 text-sm max-w-md">
                    <span className="text-muted-foreground">Triage agent</span>
                    <select
                      className="border border-input bg-background rounded-md h-9 px-2 text-sm"
                      value={form.triageAgentId}
                      onChange={(e) => setForm({ ...form, triageAgentId: e.target.value })}
                    >
                      <option value="">(use company CEO agent)</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} {a.role ? `— ${a.role}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </Section>
                <Section title="Team notification recipients">
                  <p className="text-xs text-muted-foreground mb-2">
                    Addresses notified (via the agent_voice account) when a plan is proposed for this inbox. Comma-separated.
                  </p>
                  <Field label="Team emails" value={form.teamEmails} onChange={(v) => setForm({ ...form, teamEmails: v })} />
                  {ownerEmail && !form.teamEmails.includes(ownerEmail) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const current = form.teamEmails.trim();
                        const next = current ? `${current}, ${ownerEmail}` : ownerEmail;
                        setForm({ ...form, teamEmails: next });
                      }}
                    >
                      <Plus className="h-4 w-4 mr-1" /> Add owner email ({ownerEmail})
                    </Button>
                  )}
                </Section>
              </>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="voice" className="space-y-5">
          <Card className="p-5 space-y-5">
            <Section title="Reply voice">
              <p className="text-xs text-muted-foreground mb-2">
                When a plan is approved to reply to a client, which account's SMTP sends the reply? Default is this account (continuity for the sender).
              </p>
              <label className="flex flex-col gap-1 text-sm max-w-md">
                <span className="text-muted-foreground">Reply from</span>
                <select
                  className="border border-input bg-background rounded-md h-9 px-2 text-sm"
                  value={form.replyFromAccountId}
                  onChange={(e) => setForm({ ...form, replyFromAccountId: e.target.value })}
                >
                  <option value="">This account (self)</option>
                  {otherAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} — {a.fromEmail} ({a.role})
                    </option>
                  ))}
                </select>
              </label>
            </Section>
            <Section title="Auto-acknowledge">
              <p className="text-xs text-muted-foreground mb-2">
                When enabled, inbound emails get an immediate reply so the sender knows they've been received. Uses the reply voice account's SMTP.
                Template placeholders: <code className="bg-muted px-1 rounded">{"{from}"}</code>,{" "}
                <code className="bg-muted px-1 rounded">{"{subject}"}</code>.
              </p>
              <Toggle
                label="Send acknowledgement on every inbound email"
                value={form.autoAcknowledge}
                onChange={(v) => setForm({ ...form, autoAcknowledge: v })}
              />
              {form.autoAcknowledge && (
                <div className="space-y-3 pt-2">
                  <Field
                    label="Ack subject (blank = Re: {subject})"
                    value={form.ackSubject}
                    onChange={(v) => setForm({ ...form, ackSubject: v })}
                  />
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Ack body (blank = default greeting)</span>
                    <textarea
                      className="border border-input bg-background rounded-md px-2 py-2 text-sm min-h-[140px] font-mono"
                      value={form.ackBody}
                      onChange={(e) => setForm({ ...form, ackBody: e.target.value })}
                      placeholder="Hi,\n\nThanks for your message — we received it and our team is reviewing it now. We'll be in touch shortly.\n\nBest,\nThe team"
                    />
                  </label>
                </div>
              )}
            </Section>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
