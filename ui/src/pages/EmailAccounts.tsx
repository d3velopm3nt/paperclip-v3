// v3: email accounts page — list, create, edit, delete, test-connection
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  emailAccountsApi,
  type EmailAccount,
  type EmailAccountCreateRequest,
  type EmailAccountUpdateRequest,
} from "../api/emailAccounts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Mail, Plus, Pencil, Trash2, Plug, XCircle, Timer } from "lucide-react";

interface FormState {
  label: string;
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
  folder: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  pollIntervalSec: string;
  active: boolean;
}

const emptyForm: FormState = {
  label: "",
  imapHost: "",
  imapPort: "993",
  imapUser: "",
  imapPassword: "",
  imapTls: true,
  smtpHost: "",
  smtpPort: "587",
  smtpUser: "",
  smtpPassword: "",
  smtpSecure: false,
  smtpSameAsImap: true,
  folder: "INBOX",
  fromName: "",
  fromEmail: "",
  replyTo: "",
  pollIntervalSec: "60",
  active: true,
};

function accountToForm(account: EmailAccount): FormState {
  const sameAsImap =
    !!account.smtpHost &&
    account.smtpHost === account.imapHost &&
    (account.smtpUser ?? account.imapUser) === account.imapUser;
  return {
    label: account.label,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapUser: account.imapUser,
    imapPassword: "",
    imapTls: account.imapTls,
    smtpHost: account.smtpHost ?? "",
    smtpPort: account.smtpPort ? String(account.smtpPort) : "587",
    smtpUser: account.smtpUser ?? "",
    smtpPassword: "",
    smtpSecure: account.smtpSecure,
    smtpSameAsImap: sameAsImap,
    folder: account.folder,
    fromName: account.fromName,
    fromEmail: account.fromEmail,
    replyTo: account.replyTo ?? "",
    pollIntervalSec: String(account.pollIntervalSec),
    active: account.active,
  };
}

export function EmailAccounts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId!;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EmailAccount | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<EmailAccount | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingSmtpId, setTestingSmtpId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Email Accounts" }]);
  }, [setBreadcrumbs]);

  const accountsQuery = useQuery({
    queryKey: queryKeys.emailAccounts.list(companyId),
    queryFn: () => emailAccountsApi.list(companyId),
    enabled: !!companyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: EmailAccountCreateRequest) => emailAccountsApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailAccounts.list(companyId) });
      pushToast({ title: "Email account created" });
      setDialogOpen(false);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Create failed", body: err.message }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: EmailAccountUpdateRequest }) =>
      emailAccountsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailAccounts.list(companyId) });
      pushToast({ title: "Email account updated" });
      setDialogOpen(false);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Update failed", body: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => emailAccountsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emailAccounts.list(companyId) });
      pushToast({ title: "Email account deleted" });
      setDeleteConfirm(null);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Delete failed", body: err.message }),
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(account: EmailAccount) {
    setEditing(account);
    setForm(accountToForm(account));
    setDialogOpen(true);
  }

  function resolvedSmtp() {
    if (form.smtpSameAsImap) {
      return {
        host: form.imapHost,
        port: parseInt(form.smtpPort, 10),
        user: form.imapUser,
        password: form.imapPassword,
      };
    }
    return {
      host: form.smtpHost,
      port: parseInt(form.smtpPort, 10),
      user: form.smtpUser || form.imapUser,
      password: form.smtpPassword,
    };
  }

  function submit() {
    const port = parseInt(form.imapPort, 10);
    const pollInterval = parseInt(form.pollIntervalSec, 10);
    if (!Number.isInteger(port)) {
      pushToast({ tone: "warn", title: "imapPort must be a number" });
      return;
    }
    const smtp = resolvedSmtp();
    const smtpPayload: {
      smtpHost: string | null;
      smtpPort: number | null;
      smtpUser: string | null;
      smtpPassword?: string | null;
      smtpSecure: boolean;
    } = smtp.host
      ? {
          smtpHost: smtp.host,
          smtpPort: Number.isInteger(smtp.port) ? smtp.port : 587,
          smtpUser: smtp.user,
          smtpSecure: form.smtpSecure,
        }
      : {
          smtpHost: null,
          smtpPort: null,
          smtpUser: null,
          smtpPassword: null,
          smtpSecure: false,
        };

    if (editing) {
      const data: EmailAccountUpdateRequest = {
        label: form.label,
        imapHost: form.imapHost,
        imapPort: port,
        imapUser: form.imapUser,
        imapTls: form.imapTls,
        folder: form.folder,
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        replyTo: form.replyTo || null,
        pollIntervalSec: pollInterval,
        active: form.active,
        ...smtpPayload,
      };
      if (form.imapPassword) data.imapPassword = form.imapPassword;
      if (smtp.host && !form.smtpSameAsImap && form.smtpPassword) {
        data.smtpPassword = form.smtpPassword;
      }
      if (smtp.host && form.smtpSameAsImap && form.imapPassword) {
        data.smtpPassword = form.imapPassword;
      }
      updateMutation.mutate({ id: editing.id, data });
    } else {
      if (!form.imapPassword) {
        pushToast({ tone: "warn", title: "imapPassword required" });
        return;
      }
      createMutation.mutate({
        label: form.label,
        imapHost: form.imapHost,
        imapPort: port,
        imapUser: form.imapUser,
        imapPassword: form.imapPassword,
        imapTls: form.imapTls,
        folder: form.folder,
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        replyTo: form.replyTo || null,
        pollIntervalSec: pollInterval,
        active: form.active,
        ...smtpPayload,
        smtpPassword: smtp.host
          ? form.smtpSameAsImap
            ? form.imapPassword
            : form.smtpPassword || null
          : null,
      });
    }
  }

  const [formTestingKind, setFormTestingKind] = useState<"imap" | "smtp" | null>(null);

  async function testFormConnection(kind: "imap" | "smtp") {
    setFormTestingKind(kind);
    try {
      const port = parseInt(kind === "imap" ? form.imapPort : form.smtpPort, 10);
      if (!Number.isInteger(port)) {
        pushToast({ tone: "warn", title: "Port must be a number" });
        return;
      }
      const host = kind === "imap" ? form.imapHost : form.smtpSameAsImap ? form.imapHost : form.smtpHost;
      const user =
        kind === "imap"
          ? form.imapUser
          : form.smtpSameAsImap
            ? form.imapUser
            : form.smtpUser || form.imapUser;
      const password =
        kind === "imap"
          ? form.imapPassword
          : form.smtpSameAsImap
            ? form.imapPassword
            : form.smtpPassword;
      if (!host || !user || !password) {
        pushToast({ tone: "warn", title: `${kind.toUpperCase()} host, user, password required to test` });
        return;
      }
      const result = await emailAccountsApi.testEphemeral({
        kind,
        host,
        port,
        user,
        password,
        tls: kind === "imap" ? form.imapTls : undefined,
        secure: kind === "smtp" ? form.smtpSecure : undefined,
      });
      if (result.ok) {
        pushToast({ title: `${kind.toUpperCase()} connection OK` });
      } else {
        pushToast({ tone: "warn", title: `${kind.toUpperCase()} failed`, body: result.error });
      }
    } catch (err) {
      pushToast({ tone: "warn", title: "Test failed", body: (err as Error).message });
    } finally {
      setFormTestingKind(null);
    }
  }

  async function testConnection(account: EmailAccount) {
    setTestingId(account.id);
    try {
      const result = await emailAccountsApi.testConnection(account.id);
      if (result.ok) {
        pushToast({ title: `IMAP OK — ${account.label}` });
      } else {
        pushToast({ tone: "warn", title: `IMAP failed — ${account.label}`, body: result.error });
      }
    } catch (err) {
      pushToast({ tone: "warn", title: "Test failed", body: (err as Error).message });
    } finally {
      setTestingId(null);
    }
  }

  async function testSmtp(account: EmailAccount) {
    setTestingSmtpId(account.id);
    try {
      const result = await emailAccountsApi.testSmtp(account.id);
      if (result.ok) {
        pushToast({ title: `SMTP OK — ${account.label}` });
      } else {
        pushToast({ tone: "warn", title: `SMTP failed — ${account.label}`, body: result.error });
      }
    } catch (err) {
      pushToast({ tone: "warn", title: "Test failed", body: (err as Error).message });
    } finally {
      setTestingSmtpId(null);
    }
  }

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (accountsQuery.isLoading) return <PageSkeleton />;
  const accounts = accountsQuery.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Mail className="h-6 w-6" /> Email Accounts
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            IMAP mailboxes monitored for inbound emails. Passwords encrypted at rest.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <Card className="p-8 text-center">
          <Mail className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No email accounts yet.</p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {accounts.map((account) => (
            <Card key={account.id} className="p-4 hover:border-border/80 transition-colors">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                  aria-hidden
                >
                  <Mail className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{account.label}</span>
                    <span
                      className={`h-2 w-2 rounded-full ${account.active ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      title={account.active ? "Active" : "Paused"}
                    />
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                      <Timer className="h-3 w-3" />
                      {account.pollIntervalSec}s
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{account.fromEmail}</div>
                  {account.lastErrorText && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-destructive truncate">
                      <XCircle className="h-3 w-3 shrink-0" />
                      <span className="truncate">{account.lastErrorText}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => testConnection(account)}
                    disabled={testingId === account.id}
                  >
                    <Plug className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">{testingId === account.id ? "…" : "IMAP"}</span>
                  </Button>
                  {account.smtpHost && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => testSmtp(account)}
                      disabled={testingSmtpId === account.id}
                    >
                      <Plug className="h-4 w-4 sm:mr-1" />
                      <span className="hidden sm:inline">{testingSmtpId === account.id ? "…" : "SMTP"}</span>
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(account)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteConfirm(account)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit email account" : "New email account"}</DialogTitle>
            <DialogDescription>
              Credentials encrypted before storage.
              {editing && " Leave passwords blank to keep existing."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <section className="grid grid-cols-2 gap-3">
              <Field label="Label" value={form.label} onChange={(v) => setForm({ ...form, label: v })} />
              <Field label="Folder" value={form.folder} onChange={(v) => setForm({ ...form, folder: v })} />
              <Field label="From name" value={form.fromName} onChange={(v) => setForm({ ...form, fromName: v })} />
              <Field label="From email" value={form.fromEmail} onChange={(v) => setForm({ ...form, fromEmail: v })} />
              <Field label="Reply-To (optional)" value={form.replyTo} onChange={(v) => setForm({ ...form, replyTo: v })} />
              <Field
                label="Poll interval (sec)"
                value={form.pollIntervalSec}
                onChange={(v) => setForm({ ...form, pollIntervalSec: v })}
              />
              <Toggle label="Active" value={form.active} onChange={(v) => setForm({ ...form, active: v })} />
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Incoming mail (IMAP)</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => testFormConnection("imap")}
                  disabled={formTestingKind !== null}
                >
                  <Plug className="h-4 w-4 mr-1" />
                  {formTestingKind === "imap" ? "Testing…" : "Test IMAP"}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="IMAP host" value={form.imapHost} onChange={(v) => setForm({ ...form, imapHost: v })} />
                <Field label="IMAP port" value={form.imapPort} onChange={(v) => setForm({ ...form, imapPort: v })} />
                <Field label="IMAP user" value={form.imapUser} onChange={(v) => setForm({ ...form, imapUser: v })} />
                <Field
                  label={editing ? "IMAP password (blank = keep)" : "IMAP password"}
                  value={form.imapPassword}
                  type="password"
                  onChange={(v) => setForm({ ...form, imapPassword: v })}
                />
                <Toggle label="TLS" value={form.imapTls} onChange={(v) => setForm({ ...form, imapTls: v })} />
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Outgoing mail (SMTP)</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => testFormConnection("smtp")}
                  disabled={formTestingKind !== null}
                >
                  <Plug className="h-4 w-4 mr-1" />
                  {formTestingKind === "smtp" ? "Testing…" : "Test SMTP"}
                </Button>
              </div>
              <Toggle
                label="Same server as IMAP"
                value={form.smtpSameAsImap}
                onChange={(v) => setForm({ ...form, smtpSameAsImap: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                {!form.smtpSameAsImap && (
                  <>
                    <Field
                      label="SMTP host"
                      value={form.smtpHost}
                      onChange={(v) => setForm({ ...form, smtpHost: v })}
                    />
                    <Field
                      label="SMTP user (blank = IMAP user)"
                      value={form.smtpUser}
                      onChange={(v) => setForm({ ...form, smtpUser: v })}
                    />
                    <Field
                      label={editing ? "SMTP password (blank = keep)" : "SMTP password (blank = reuse IMAP)"}
                      value={form.smtpPassword}
                      type="password"
                      onChange={(v) => setForm({ ...form, smtpPassword: v })}
                    />
                  </>
                )}
                <Field label="SMTP port" value={form.smtpPort} onChange={(v) => setForm({ ...form, smtpPort: v })} />
                <Toggle
                  label="Secure (implicit TLS, port 465)"
                  value={form.smtpSecure}
                  onChange={(v) => setForm({ ...form, smtpSecure: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Port 587 + Secure off = STARTTLS. Port 465 + Secure on = implicit TLS.
              </p>
            </section>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete email account?</DialogTitle>
            <DialogDescription>
              Removes <strong>{deleteConfirm?.label}</strong>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
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
