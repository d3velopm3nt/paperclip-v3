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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Mail, Plus, Pencil, Trash2, Plug, CheckCircle2, XCircle } from "lucide-react";

interface FormState {
  label: string;
  imapHost: string;
  imapPort: string;
  imapUser: string;
  imapPassword: string;
  imapTls: boolean;
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
  folder: "INBOX",
  fromName: "",
  fromEmail: "",
  replyTo: "",
  pollIntervalSec: "60",
  active: true,
};

function accountToForm(account: EmailAccount): FormState {
  return {
    label: account.label,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapUser: account.imapUser,
    imapPassword: "",
    imapTls: account.imapTls,
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

  function submit() {
    const port = parseInt(form.imapPort, 10);
    const pollInterval = parseInt(form.pollIntervalSec, 10);
    if (!Number.isInteger(port)) {
      pushToast({ tone: "warn", title: "imapPort must be a number" });
      return;
    }
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
      };
      if (form.imapPassword) data.imapPassword = form.imapPassword;
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
      });
    }
  }

  async function testConnection(account: EmailAccount) {
    setTestingId(account.id);
    try {
      const result = await emailAccountsApi.testConnection(account.id);
      if (result.ok) {
        pushToast({ title: `Connection OK — ${account.label}` });
      } else {
        pushToast({ tone: "warn", title: `Connection failed — ${account.label}`, body: result.error });
      }
    } catch (err) {
      pushToast({ tone: "warn", title: "Test failed", body: (err as Error).message });
    } finally {
      setTestingId(null);
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
            <Card key={account.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{account.label}</span>
                    <Badge variant={account.active ? "default" : "secondary"}>
                      {account.active ? "active" : "paused"}
                    </Badge>
                    {account.imapTls && <Badge variant="outline">TLS</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1 space-y-0.5">
                    <div>
                      {account.imapUser}@{account.imapHost}:{account.imapPort} · {account.folder}
                    </div>
                    <div>
                      From: {account.fromName} &lt;{account.fromEmail}&gt;
                      {account.replyTo ? ` · Reply-To: ${account.replyTo}` : ""}
                    </div>
                    <div>Poll every {account.pollIntervalSec}s</div>
                    {account.lastPolledAt && (
                      <div className="flex items-center gap-1 text-xs">
                        <CheckCircle2 className="h-3 w-3" />
                        Last poll: {new Date(account.lastPolledAt).toLocaleString()}
                      </div>
                    )}
                    {account.lastErrorText && (
                      <div className="flex items-center gap-1 text-xs text-destructive">
                        <XCircle className="h-3 w-3" />
                        {account.lastErrorText}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => testConnection(account)}
                    disabled={testingId === account.id}
                  >
                    <Plug className="h-4 w-4 mr-1" />
                    {testingId === account.id ? "Testing…" : "Test"}
                  </Button>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit email account" : "New email account"}</DialogTitle>
            <DialogDescription>
              IMAP credentials are encrypted before storage.
              {editing && " Leave password blank to keep existing."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label" value={form.label} onChange={(v) => setForm({ ...form, label: v })} />
            <Field label="Folder" value={form.folder} onChange={(v) => setForm({ ...form, folder: v })} />
            <Field label="IMAP host" value={form.imapHost} onChange={(v) => setForm({ ...form, imapHost: v })} />
            <Field label="IMAP port" value={form.imapPort} onChange={(v) => setForm({ ...form, imapPort: v })} />
            <Field label="IMAP user" value={form.imapUser} onChange={(v) => setForm({ ...form, imapUser: v })} />
            <Field
              label={editing ? "IMAP password (blank = keep)" : "IMAP password"}
              value={form.imapPassword}
              type="password"
              onChange={(v) => setForm({ ...form, imapPassword: v })}
            />
            <Field label="From name" value={form.fromName} onChange={(v) => setForm({ ...form, fromName: v })} />
            <Field label="From email" value={form.fromEmail} onChange={(v) => setForm({ ...form, fromEmail: v })} />
            <Field label="Reply-To (optional)" value={form.replyTo} onChange={(v) => setForm({ ...form, replyTo: v })} />
            <Field
              label="Poll interval (sec)"
              value={form.pollIntervalSec}
              onChange={(v) => setForm({ ...form, pollIntervalSec: v })}
            />
            <Toggle label="TLS" value={form.imapTls} onChange={(v) => setForm({ ...form, imapTls: v })} />
            <Toggle label="Active" value={form.active} onChange={(v) => setForm({ ...form, active: v })} />
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
