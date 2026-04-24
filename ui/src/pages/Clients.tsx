// v3: clients CRUD page — first-class external parties per company
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clientsApi, type Client } from "../api/clients";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UsersRound, Plus, Pencil, Trash2, Mail, AtSign } from "lucide-react";

interface ClientFormState {
  name: string;
  emailDomain: string;
  extraEmails: string; // comma-separated in the UI
  trustLevel: string;
  notes: string;
}

const empty: ClientFormState = {
  name: "",
  emailDomain: "",
  extraEmails: "",
  trustLevel: "standard",
  notes: "",
};

function toForm(c: Client): ClientFormState {
  return {
    name: c.name,
    emailDomain: c.emailDomain ?? "",
    extraEmails: (c.extraEmails ?? []).join(", "),
    trustLevel: c.trustLevel,
    notes: c.notes ?? "",
  };
}

export function Clients() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId!;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [form, setForm] = useState<ClientFormState>(empty);
  const [deleteConfirm, setDeleteConfirm] = useState<Client | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Clients" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: queryKeys.clients.list(companyId),
    queryFn: () => clientsApi.list(companyId),
    enabled: !!companyId,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(companyId) });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      clientsApi.create(companyId, {
        name: form.name,
        emailDomain: form.emailDomain || null,
        extraEmails: parseList(form.extraEmails),
        trustLevel: form.trustLevel,
        notes: form.notes || null,
      }),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Client created" });
      setDialogOpen(false);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Create failed", body: err.message }),
  });

  const updateMutation = useMutation({
    mutationFn: (id: string) =>
      clientsApi.update(id, {
        name: form.name,
        emailDomain: form.emailDomain || null,
        extraEmails: parseList(form.extraEmails),
        trustLevel: form.trustLevel,
        notes: form.notes || null,
      }),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Client updated" });
      setDialogOpen(false);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Update failed", body: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => clientsApi.delete(id),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Client deleted" });
      setDeleteConfirm(null);
    },
    onError: (err: Error) => pushToast({ tone: "warn", title: "Delete failed", body: err.message }),
  });

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setDialogOpen(true);
  }

  function openEdit(c: Client) {
    setEditing(c);
    setForm(toForm(c));
    setDialogOpen(true);
  }

  function submit() {
    if (!form.name.trim()) {
      pushToast({ tone: "warn", title: "Name required" });
      return;
    }
    if (editing) updateMutation.mutate(editing.id);
    else createMutation.mutate();
  }

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (listQuery.isLoading) return <PageSkeleton />;
  const clientsList = listQuery.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <UsersRound className="h-6 w-6" /> Clients
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-xl">
            External parties whose email and projects flow through this company. Sender
            domains auto-match inbound email to a client, enabling per-client policies
            and routing.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New client
        </Button>
      </div>

      {clientsList.length === 0 ? (
        <Card className="p-8 text-center">
          <UsersRound className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No clients yet.</p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {clientsList.map((c) => (
            <Card key={c.id} className="p-4 hover:border-border/80 transition-colors">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {c.trustLevel}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                    {c.emailDomain && (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <AtSign className="h-3 w-3" />
                        {c.emailDomain}
                      </span>
                    )}
                    {c.extraEmails?.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        {c.extraEmails.length} extra address{c.extraEmails.length === 1 ? "" : "es"}
                      </span>
                    )}
                  </div>
                  {c.notes && <p className="text-xs text-muted-foreground mt-1">{c.notes}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(c)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteConfirm(c)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit client" : "New client"}</DialogTitle>
            <DialogDescription>
              Inbound mail whose sender matches the email domain or extra addresses will
              auto-associate with this client.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Labeled label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Labeled>
            <Labeled label="Email domain (e.g. acme.com)">
              <Input
                value={form.emailDomain}
                placeholder="acme.com"
                onChange={(e) => setForm({ ...form, emailDomain: e.target.value })}
              />
            </Labeled>
            <Labeled label="Extra email addresses (comma-separated)">
              <Input
                value={form.extraEmails}
                placeholder="alice@partner.com, bob@contractor.co"
                onChange={(e) => setForm({ ...form, extraEmails: e.target.value })}
              />
            </Labeled>
            <Labeled label="Trust level">
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.trustLevel}
                onChange={(e) => setForm({ ...form, trustLevel: e.target.value })}
              >
                <option value="low">low</option>
                <option value="standard">standard</option>
                <option value="high">high</option>
              </select>
            </Labeled>
            <Labeled label="Notes">
              <Textarea
                value={form.notes}
                rows={3}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Labeled>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete client?</DialogTitle>
            <DialogDescription>
              Removes <strong>{deleteConfirm?.name}</strong>. Projects and emails linked to
              this client will have their clientId cleared but remain.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
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

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
