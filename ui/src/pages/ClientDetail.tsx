import { useEffect, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clientsApi, type Client } from "../api/clients";
import { contactsApi, contactDisplayName, type Contact } from "../api/contacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  UsersRound, Building2, AtSign, Mail, Pencil, Trash2,
  Plus, User, Phone, Briefcase, ArrowLeft, ShieldCheck,
} from "lucide-react";

type ClientTab = "overview" | "contacts";

// ── Contact form ─────────────────────────────────────────────────────────────

interface ContactFormState {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: string;
  notes: string;
}

const emptyContact: ContactFormState = { email: "", firstName: "", lastName: "", phone: "", role: "", notes: "" };

function toContactForm(c: Contact): ContactFormState {
  return {
    email: c.email,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    phone: c.phone ?? "",
    role: c.role ?? "",
    notes: c.notes ?? "",
  };
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({ client, onEdit }: { client: Client; onEdit: () => void }) {
  return (
    <div className="space-y-4 max-w-xl">
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            {client.name}
            {client.isMyCompany && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                <ShieldCheck className="h-3 w-3" /> My company
              </span>
            )}
          </h2>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
          </Button>
        </div>
        <div className="grid gap-2 text-sm text-muted-foreground">
          {client.emailDomain && (
            <span className="inline-flex items-center gap-1.5">
              <AtSign className="h-3.5 w-3.5" />
              <span className="font-mono">{client.emailDomain}</span>
            </span>
          )}
          {client.extraEmails?.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {client.extraEmails.join(", ")}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Trust: {client.trustLevel}
          </span>
        </div>
        {client.notes && (
          <p className="text-sm text-muted-foreground border-t pt-3">{client.notes}</p>
        )}
      </Card>
    </div>
  );
}

// ── Contacts tab ─────────────────────────────────────────────────────────────

function ContactsTab({ client }: { client: Client }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [form, setForm] = useState<ContactFormState>(emptyContact);
  const [deleteConfirm, setDeleteConfirm] = useState<Contact | null>(null);

  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts.forClient(client.id),
    queryFn: () => contactsApi.listForClient(client.id),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.contacts.forClient(client.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.contacts.team(client.companyId) });
  }

  const createMutation = useMutation({
    mutationFn: () => contactsApi.create(client.id, {
      email: form.email,
      firstName: form.firstName || null,
      lastName: form.lastName || null,
      phone: form.phone || null,
      role: form.role || null,
      notes: form.notes || null,
    }),
    onSuccess: () => { invalidate(); pushToast({ title: "Contact added" }); setDialogOpen(false); },
    onError: (e: Error) => pushToast({ tone: "warn", title: "Failed", body: e.message }),
  });

  const updateMutation = useMutation({
    mutationFn: (id: string) => contactsApi.update(id, {
      firstName: form.firstName || null,
      lastName: form.lastName || null,
      phone: form.phone || null,
      role: form.role || null,
      notes: form.notes || null,
    }),
    onSuccess: () => { invalidate(); pushToast({ title: "Contact updated" }); setDialogOpen(false); },
    onError: (e: Error) => pushToast({ tone: "warn", title: "Failed", body: e.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => contactsApi.delete(id),
    onSuccess: () => { invalidate(); pushToast({ title: "Contact removed" }); setDeleteConfirm(null); },
    onError: (e: Error) => pushToast({ tone: "warn", title: "Failed", body: e.message }),
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyContact);
    setDialogOpen(true);
  }

  function openEdit(c: Contact) {
    setEditing(c);
    setForm(toContactForm(c));
    setDialogOpen(true);
  }

  function submit() {
    if (!form.email.trim() && !editing) {
      pushToast({ tone: "warn", title: "Email required" });
      return;
    }
    if (editing) updateMutation.mutate(editing.id);
    else createMutation.mutate();
  }

  const contacts = contactsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add contact
        </Button>
      </div>

      {contacts.length === 0 ? (
        <Card className="p-8 text-center">
          <User className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No contacts yet. Add people who work at {client.name}.</p>
        </Card>
      ) : (
        <div className="grid gap-2">
          {contacts.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {c.firstName || c.lastName
                        ? contactDisplayName(c)
                        : <span className="text-muted-foreground italic">Unnamed</span>}
                    </span>
                    {c.role && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {c.role}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-mono">
                      <Mail className="h-3 w-3" />{c.email}
                    </span>
                    {c.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3 w-3" />{c.phone}
                      </span>
                    )}
                  </div>
                  {c.notes && <p className="text-xs text-muted-foreground mt-1">{c.notes}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(c)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteConfirm(c)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit contact" : "Add contact"}</DialogTitle>
            <DialogDescription>Person at {client.name}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {!editing && (
              <Labeled label="Email *">
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="koneill@example.com" />
              </Labeled>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="First name">
                <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </Labeled>
              <Labeled label="Last name">
                <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </Labeled>
            </div>
            <Labeled label="Role / title">
              <Input value={form.role} placeholder="Sales Manager" onChange={(e) => setForm({ ...form, role: e.target.value })} />
            </Labeled>
            <Labeled label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Labeled>
            <Labeled label="Notes">
              <Textarea value={form.notes} rows={2} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Labeled>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove contact?</DialogTitle>
            <DialogDescription>
              Remove <strong>{deleteConfirm ? contactDisplayName(deleteConfirm) : ""}</strong> from {client.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)} disabled={deleteMutation.isPending}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Client edit dialog ────────────────────────────────────────────────────────

interface ClientFormState {
  name: string;
  emailDomain: string;
  extraEmails: string;
  trustLevel: string;
  isMyCompany: boolean;
  notes: string;
}

function toClientForm(c: Client): ClientFormState {
  return {
    name: c.name,
    emailDomain: c.emailDomain ?? "",
    extraEmails: (c.extraEmails ?? []).join(", "),
    trustLevel: c.trustLevel,
    isMyCompany: c.isMyCompany,
    notes: c.notes ?? "",
  };
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<ClientTab>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<ClientFormState | null>(null);

  const clientQuery = useQuery({
    queryKey: queryKeys.clients.detail(clientId!),
    queryFn: () => clientsApi.get(clientId!),
    enabled: !!clientId,
  });

  const client = clientQuery.data;

  useEffect(() => {
    if (client) {
      setBreadcrumbs([
        { label: "Clients", href: "/clients" },
        { label: client.name },
      ]);
    }
  }, [client, setBreadcrumbs]);

  const updateMutation = useMutation({
    mutationFn: (data: ClientFormState) =>
      clientsApi.update(clientId!, {
        name: data.name,
        emailDomain: data.emailDomain || null,
        extraEmails: data.extraEmails.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        trustLevel: data.trustLevel,
        isMyCompany: data.isMyCompany,
        notes: data.notes || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.detail(clientId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(selectedCompanyId!) });
      pushToast({ title: "Client updated" });
      setEditOpen(false);
    },
    onError: (e: Error) => pushToast({ tone: "warn", title: "Update failed", body: e.message }),
  });

  if (clientQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (!client) return <div className="p-6 text-sm text-muted-foreground">Client not found.</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate("/clients")} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-1" /> Clients
        </Button>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <UsersRound className="h-5 w-5" />
          {client.name}
          {client.isMyCompany && (
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              <ShieldCheck className="h-3 w-3" /> My company
            </span>
          )}
        </h1>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ClientTab)}>
        <PageTabBar
          items={[
            { value: "overview", label: "Overview" },
            { value: "contacts", label: "Contacts" },
          ]}
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as ClientTab)}
          align="start"
        />
      </Tabs>

      <div className="mt-2">
        {activeTab === "overview" && (
          <OverviewTab
            client={client}
            onEdit={() => {
              setForm(toClientForm(client));
              setEditOpen(true);
            }}
          />
        )}
        {activeTab === "contacts" && <ContactsTab client={client} />}
      </div>

      {/* Edit client dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {client.name}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="grid gap-3">
              <Labeled label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Labeled>
              <Labeled label="Email domain (e.g. acme.com)">
                <Input value={form.emailDomain} placeholder="acme.com" onChange={(e) => setForm({ ...form, emailDomain: e.target.value })} />
              </Labeled>
              <Labeled label="Extra email addresses (comma-separated)">
                <Input value={form.extraEmails} onChange={(e) => setForm({ ...form, extraEmails: e.target.value })} />
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
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isMyCompany}
                  onChange={(e) => setForm({ ...form, isMyCompany: e.target.checked })}
                  className="rounded border-border"
                />
                <span>This is my company / internal team</span>
              </label>
              <Labeled label="Notes">
                <Textarea value={form.notes} rows={3} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Labeled>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={() => form && updateMutation.mutate(form)} disabled={updateMutation.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
