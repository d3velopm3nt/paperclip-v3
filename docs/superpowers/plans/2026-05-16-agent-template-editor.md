# Agent Template Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Use the API" toast stub with a real inline template editor in the Agent Templates right pane — operators can create and edit templates, adding agents from scratch or importing from existing ones.

**Architecture:** All changes are in `ui/src/pages/AgentTemplates.tsx`. The right pane switches between view mode (existing `TemplateDetail`) and edit mode (new `TemplateEditor` component). No new server routes — `POST /api/agent-templates` and `PUT /api/agent-templates/:id` already exist.

**Tech Stack:** React 19, TanStack Query, TypeScript, Tailwind 4, lucide-react, `@paperclipai/shared` types

---

## Context: existing file structure

`ui/src/pages/AgentTemplates.tsx` (~500 lines) currently has:
- Layout helpers: `subtreeWidth`, `layoutTree`, `layoutForest`, `flattenLayout`, `collectEdges`, `buildOrgTree`
- Components: `CategoryBadge`, `TemplateCard`, `TemplateDetail`, `TemplateDetailContent`
- Main export: `AgentTemplates` — two-pane layout with left catalog + right detail
- "New Template" button at line ~468 shows a toast (replace this)
- Right pane at line ~487 renders `<TemplateDetail key={selectedId} templateId={selectedId} />`

Existing imports to keep/extend:
```typescript
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate } from "lucide-react";
import { agentTemplatesApi } from "../api/agentTemplates";
import type { AgentTemplateSummaryWithCount } from "../api/agentTemplates";
import type { AgentTemplate, AgentTemplateDefinition, TeamStructureEntry } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
```

New imports to add:
```typescript
import { agentsApi } from "../api/agents";
import type { Agent } from "@paperclipai/shared";
import { Plus, Trash2, X, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
```

---

## File

**Modify only:** `ui/src/pages/AgentTemplates.tsx`

---

## Task 1: Editor types + `toSlug` helper + editor state in `AgentTemplates`

**Files:**
- Modify: `ui/src/pages/AgentTemplates.tsx`

- [ ] **Step 1: Add `EditorAgent` type and `toSlug` helper** after the existing `buildOrgTree` function (around line 140):

```typescript
interface EditorAgent {
  tempId: string;
  name: string;
  role: string;
  adapterType: string;
  reportsTo: string | null;
}

type EditorMode = { kind: "new" } | { kind: "edit"; templateId: string } | null;

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function makeTempId(name: string): string {
  const slug = toSlug(name) || "agent";
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}
```

- [ ] **Step 2: Add editor state to `AgentTemplates` component** — after `const [selectedId, setSelectedId] = useState<string | null>(null);`:

```typescript
const [editorMode, setEditorMode] = useState<EditorMode>(null);
const [editorName, setEditorName] = useState("");
const [editorSlug, setEditorSlug] = useState("");
const [editorDescription, setEditorDescription] = useState("");
const [editorCategory, setEditorCategory] = useState("custom");
const [editorAgents, setEditorAgents] = useState<EditorAgent[]>([]);
const [editorSlugError, setEditorSlugError] = useState<string | null>(null);
```

- [ ] **Step 3: Change "New Template" button** — replace the `onClick` toast handler (~line 468):

```typescript
onClick={() => {
  setEditorMode({ kind: "new" });
  setEditorName("");
  setEditorSlug("");
  setEditorDescription("");
  setEditorCategory("custom");
  setEditorAgents([]);
  setEditorSlugError(null);
}}
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "AgentTemplates\|agent-templates" | grep -v "AgentPerformanceTab\|Analytics"
```

Expected: no new errors in AgentTemplates.tsx

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add template editor state types and toSlug helper

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `TemplateEditor` component — header fields + save/cancel

**Files:**
- Modify: `ui/src/pages/AgentTemplates.tsx`

Add `TemplateEditor` as a new component after `TemplateDetailContent`. It receives editor state as props and renders the form header fields (name, slug, description, category) plus a placeholder for the agent list (Task 3) and save/cancel buttons.

- [ ] **Step 1: Add new imports** at top of file (merge with existing imports):

```typescript
import { useQueryClient } from "@tanstack/react-query"; // add to existing useQuery, useMutation import
import { Plus, Trash2, X, Search } from "lucide-react";  // add to existing LayoutTemplate import
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
```

- [ ] **Step 2: Add `TemplateEditor` component** after `TemplateDetailContent` (before `// ── Main page`):

```typescript
function TemplateEditor({
  mode,
  name, setName,
  slug, setSlug,
  description, setDescription,
  category, setCategory,
  agents, setAgents,
  slugError, setSlugError,
  onCancel,
  onSaved,
}: {
  mode: { kind: "new" } | { kind: "edit"; templateId: string };
  name: string; setName: (v: string) => void;
  slug: string; setSlug: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  category: string; setCategory: (v: string) => void;
  agents: EditorAgent[]; setAgents: (v: EditorAgent[]) => void;
  slugError: string | null; setSlugError: (v: string | null) => void;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: () => {
      const agentDefinitions: AgentTemplateDefinition[] = agents.map((a) => ({
        tempId: a.tempId,
        name: a.name,
        role: a.role,
        adapterType: a.adapterType,
        adapterConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        skills: [],
      }));
      const teamStructure: TeamStructureEntry[] = agents.map((a) => ({
        tempId: a.tempId,
        reportsTo: a.reportsTo,
      }));
      if (mode.kind === "new") {
        return agentTemplatesApi.create({ name, slug, description: description || undefined, category, agentDefinitions, teamStructure });
      }
      return agentTemplatesApi.update(mode.templateId, { name, description: description || undefined, category, agentDefinitions, teamStructure });
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.detail(saved.id) });
      pushToast({ tone: "success", title: "Template saved" });
      setSlugError(null);
      onSaved(saved.id);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to save template";
      if (msg.toLowerCase().includes("slug")) {
        setSlugError(msg);
      } else {
        pushToast({ tone: "error", title: "Save failed", body: msg });
      }
    },
  });

  return (
    <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">
          {mode.kind === "new" ? "New Template" : "Edit Template"}
        </h2>
        <Button variant="ghost" size="icon-xs" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Template metadata */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name *</label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (mode.kind === "new") setSlug(toSlug(e.target.value));
              }}
              placeholder="Dev Team"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Slug *</label>
            <Input
              value={slug}
              onChange={(e) => { setSlug(e.target.value); setSlugError(null); }}
              placeholder="dev-team"
              pattern="[a-z0-9-]+"
              className="h-8 text-sm font-mono"
              readOnly={mode.kind === "edit"}
            />
            {slugError && <p className="text-xs text-destructive">{slugError}</p>}
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this team does…"
            rows={2}
            className="text-sm resize-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {["dev", "sales", "finance", "support", "custom"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Agent list — populated in Task 3 */}
      <AgentEditorList agents={agents} setAgents={setAgents} />

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saveMutation.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saveMutation.isPending || !name.trim() || !slug.trim() || agents.length === 0}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving…" : "Save Template"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add stub `AgentEditorList`** (so TypeScript doesn't error — Task 3 will fill it in):

```typescript
function AgentEditorList({
  agents,
  setAgents,
}: {
  agents: EditorAgent[];
  setAgents: (v: EditorAgent[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agents ({agents.length})
        </h3>
      </div>
      {agents.length === 0 && (
        <p className="text-xs text-muted-foreground">No agents yet.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire `TemplateEditor` into the right pane** of `AgentTemplates`. Replace the right pane section (~line 487):

```typescript
{/* Right pane */}
<div className="flex-1 min-w-0 flex flex-col h-full min-h-0">
  {editorMode ? (
    <TemplateEditor
      mode={editorMode}
      name={editorName} setName={setEditorName}
      slug={editorSlug} setSlug={setEditorSlug}
      description={editorDescription} setDescription={setEditorDescription}
      category={editorCategory} setCategory={setEditorCategory}
      agents={editorAgents} setAgents={setEditorAgents}
      slugError={editorSlugError} setSlugError={setEditorSlugError}
      onCancel={() => setEditorMode(null)}
      onSaved={(id) => { setEditorMode(null); setSelectedId(id); }}
    />
  ) : selectedId ? (
    <TemplateDetail key={selectedId} templateId={selectedId} onEdit={(template) => {
      setEditorMode({ kind: "edit", templateId: template.id });
      setEditorName(template.name);
      setEditorSlug(template.slug);
      setEditorDescription(template.description ?? "");
      setEditorCategory(template.category);
      setEditorAgents(
        template.agentDefinitions.map((def) => {
          const entry = template.teamStructure.find((e) => e.tempId === def.tempId);
          return {
            tempId: def.tempId,
            name: def.name,
            role: def.role,
            adapterType: def.adapterType,
            reportsTo: entry?.reportsTo ?? null,
          };
        })
      );
      setEditorSlugError(null);
    }} />
  ) : (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">Select a template to view details.</p>
    </div>
  )}
</div>
```

- [ ] **Step 5: Add `onEdit` prop to `TemplateDetail` and `TemplateDetailContent`** — add the prop signature and an Edit button in the header:

In `TemplateDetail`:
```typescript
function TemplateDetail({ templateId, onEdit }: { templateId: string; onEdit: (template: AgentTemplate) => void }) {
  // ... existing code ...
  if (!template) return null;
  return <TemplateDetailContent template={template} companies={companies} deployCompanyId={deployCompanyId} setDeployCompanyId={setDeployCompanyId} deploy={deploy} onEdit={onEdit} />;
}
```

In `TemplateDetailContent`, add `onEdit` to props and add Edit button next to the template name in the header div:
```typescript
function TemplateDetailContent({
  template,
  companies,
  deployCompanyId,
  setDeployCompanyId,
  deploy,
  onEdit,
}: {
  template: AgentTemplate;
  companies: Array<{ id: string; name: string }>;
  deployCompanyId: string;
  setDeployCompanyId: (id: string) => void;
  deploy: { mutate: () => void; isPending: boolean };
  onEdit: (template: AgentTemplate) => void;
}) {
```

Add an Edit button at the end of the header `<div className="flex items-start justify-between gap-4">`:
```tsx
<Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => onEdit(template)}>
  Edit
</Button>
```

- [ ] **Step 6: Run typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "AgentTemplates\|agent-templates" | grep -v "AgentPerformanceTab\|Analytics"
```

Expected: no errors in AgentTemplates.tsx

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add TemplateEditor form with header fields and save mutation

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `AgentEditorList` — agent rows with name, role, adapterType, reportsTo

**Files:**
- Modify: `ui/src/pages/AgentTemplates.tsx`

Replace the stub `AgentEditorList` from Task 2 with the full implementation.

- [ ] **Step 1: Replace `AgentEditorList` stub** with full implementation:

```typescript
const TEMPLATE_ROLES = ["orchestrator", "worker", "observer"] as const;
const TEMPLATE_ADAPTERS = ["ea", "claude_local", "codex_local", "gemini_local", "cursor", "opencode_local"] as const;

function AgentEditorList({
  agents,
  setAgents,
  onPickExisting,
}: {
  agents: EditorAgent[];
  setAgents: (v: EditorAgent[]) => void;
  onPickExisting: () => void;
}) {
  function addBlank() {
    const tempId = makeTempId("agent");
    const rootExists = agents.some((a) => a.reportsTo === null);
    setAgents([
      ...agents,
      {
        tempId,
        name: "",
        role: rootExists ? "worker" : "orchestrator",
        adapterType: "ea",
        reportsTo: rootExists ? (agents.find((a) => a.reportsTo === null)?.tempId ?? null) : null,
      },
    ]);
  }

  function updateAgent(tempId: string, patch: Partial<EditorAgent>) {
    setAgents(agents.map((a) => (a.tempId === tempId ? { ...a, ...patch } : a)));
  }

  function removeAgent(tempId: string) {
    setAgents(
      agents
        .filter((a) => a.tempId !== tempId)
        .map((a) => (a.reportsTo === tempId ? { ...a, reportsTo: null } : a)),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agents ({agents.length})
        </h3>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={addBlank}>
            <Plus className="h-3 w-3" />
            New
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onPickExisting}>
            <Plus className="h-3 w-3" />
            From existing
          </Button>
        </div>
      </div>

      {agents.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">Add at least one agent.</p>
      )}

      <div className="space-y-1.5">
        {agents.map((agent) => (
          <div key={agent.tempId} className="rounded-md border border-border bg-card px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={agent.name}
                onChange={(e) => {
                  const newName = e.target.value;
                  updateAgent(agent.tempId, {
                    name: newName,
                    tempId: agent.tempId,
                  });
                }}
                placeholder="Agent name"
                className="h-7 text-xs flex-1"
              />
              <button
                type="button"
                onClick={() => removeAgent(agent.tempId)}
                className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Role</label>
                <select
                  value={agent.role}
                  onChange={(e) => updateAgent(agent.tempId, { role: e.target.value })}
                  className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none"
                >
                  {TEMPLATE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Adapter</label>
                <select
                  value={agent.adapterType}
                  onChange={(e) => updateAgent(agent.tempId, { adapterType: e.target.value })}
                  className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none"
                >
                  {TEMPLATE_ADAPTERS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Reports to</label>
                <select
                  value={agent.reportsTo ?? ""}
                  onChange={(e) => updateAgent(agent.tempId, { reportsTo: e.target.value || null })}
                  className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none"
                >
                  <option value="">— root —</option>
                  {agents
                    .filter((a) => a.tempId !== agent.tempId)
                    .map((a) => (
                      <option key={a.tempId} value={a.tempId}>
                        {a.name || a.tempId}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `TemplateEditor` to pass `onPickExisting` to `AgentEditorList`**

Inside `TemplateEditor`, add state for picker modal:
```typescript
const [pickerOpen, setPickerOpen] = useState(false);
```

Replace `<AgentEditorList agents={agents} setAgents={setAgents} />` with:
```tsx
<>
  <AgentEditorList
    agents={agents}
    setAgents={setAgents}
    onPickExisting={() => setPickerOpen(true)}
  />
  {/* ExistingAgentPicker wired in Task 4 */}
  {pickerOpen && (
    <ExistingAgentPicker
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onPick={(agent) => {
        const tempId = makeTempId(agent.name);
        const rootExists = agents.some((a) => a.reportsTo === null);
        setAgents([
          ...agents,
          {
            tempId,
            name: agent.name,
            role: agent.role,
            adapterType: agent.adapterType,
            reportsTo: rootExists ? (agents.find((a) => a.reportsTo === null)?.tempId ?? null) : null,
          },
        ]);
        setPickerOpen(false);
      }}
    />
  )}
</>
```

- [ ] **Step 3: Add stub `ExistingAgentPicker`** (so TypeScript is happy — Task 4 fills it in):

```typescript
function ExistingAgentPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (agent: Pick<Agent, "name" | "role" | "adapterType">) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pick an existing agent</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </DialogContent>
    </Dialog>
  );
}
```

This stub requires the Dialog import — add to imports:
```typescript
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Agent } from "@paperclipai/shared";
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "AgentTemplates\|agent-templates" | grep -v "AgentPerformanceTab\|Analytics"
```

Expected: no errors in AgentTemplates.tsx

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add agent editor list rows with role/adapter/reportsTo dropdowns

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ExistingAgentPicker` modal — fetch all agents, search, pick

**Files:**
- Modify: `ui/src/pages/AgentTemplates.tsx`

Replace the stub `ExistingAgentPicker` with the full implementation.

- [ ] **Step 1: Add `agentsApi` import** at top of file:

```typescript
import { agentsApi } from "../api/agents";
```

- [ ] **Step 2: Add `Search` icon to lucide import** (merge into existing lucide-react import):

```typescript
import { LayoutTemplate, Plus, Trash2, X, Search } from "lucide-react";
```

- [ ] **Step 3: Replace stub `ExistingAgentPicker`** with full implementation:

```typescript
function ExistingAgentPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (agent: Pick<Agent, "name" | "role" | "adapterType">) => void;
}) {
  const { companies } = useCompany();
  const [search, setSearch] = useState("");

  const queries = companies.map((company) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useQuery({
      queryKey: queryKeys.agents.list(company.id),
      queryFn: () => agentsApi.list(company.id),
      enabled: open,
    })
  );

  const allAgents: Array<Agent & { companyName: string }> = queries.flatMap((q, i) =>
    (q.data ?? []).map((a) => ({ ...a, companyName: companies[i]!.name }))
  );

  const isLoading = queries.some((q) => q.isLoading);

  const filtered = allAgents.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.companyName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pick an existing agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents…"
              className="pl-8 h-8 text-sm"
            />
          </div>
          {isLoading && <p className="text-sm text-muted-foreground text-center py-4">Loading agents…</p>}
          {!isLoading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No agents found.</p>
          )}
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {filtered.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onPick({ name: agent.name, role: agent.role, adapterType: agent.adapterType })}
                className="w-full text-left flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent/50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{agent.name}</div>
                  <div className="text-xs text-muted-foreground">{agent.companyName}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="text-[10px] text-muted-foreground font-mono">{agent.adapterType}</span>
                  <span className="text-[10px] text-muted-foreground">{agent.role}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Note:** The `useQuery` calls inside a `.map()` violate React hooks rules. To avoid this, restructure the component to use a single combined query. Replace the `queries` + `allAgents` section with this pattern instead:

```typescript
const [allAgents, setAllAgents] = useState<Array<Agent & { companyName: string }>>([]);
const [isLoading, setIsLoading] = useState(false);

useEffect(() => {
  if (!open || companies.length === 0) return;
  setIsLoading(true);
  Promise.all(
    companies.map((c) =>
      agentsApi.list(c.id).then((agents) =>
        agents.map((a) => ({ ...a, companyName: c.name }))
      )
    )
  ).then((results) => {
    setAllAgents(results.flat());
    setIsLoading(false);
  }).catch(() => {
    setIsLoading(false);
  });
}, [open, companies]);
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "AgentTemplates\|agent-templates" | grep -v "AgentPerformanceTab\|Analytics"
```

Expected: no errors in AgentTemplates.tsx

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add ExistingAgentPicker modal with search across all companies

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final wiring + empty-state edge case

**Files:**
- Modify: `ui/src/pages/AgentTemplates.tsx`

- [ ] **Step 1: Fix empty-state guard** — currently `AgentTemplates` returns `<EmptyState>` when there are no templates, which hides the "New Template" button. Remove that early return and instead show the empty state only in the right pane:

Find and remove:
```typescript
if (!templates || templates.length === 0) {
  return <EmptyState icon={LayoutTemplate} message="No agent templates found." />;
}
```

Replace the right pane's fallback (when no `selectedId` and no `editorMode`) with:
```tsx
<div className="flex-1 flex flex-col items-center justify-center gap-3">
  {(!templates || templates.length === 0) ? (
    <EmptyState icon={LayoutTemplate} message="No templates yet. Create one to get started." />
  ) : (
    <p className="text-sm text-muted-foreground">Select a template to view details.</p>
  )}
</div>
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm -r typecheck 2>&1 | grep "AgentTemplates\|agent-templates" | grep -v "AgentPerformanceTab\|Analytics"
```

Expected: no errors

- [ ] **Step 3: Run all tests** (agent templates service tests should still pass)

```bash
pnpm vitest run server/src/__tests__/agent-templates.test.ts
```

Expected: 10/10 pass

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx
git commit -m "$(cat <<'EOF'
fix(ui): show empty state in right pane so New Template button is always visible

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| New Template button opens editor in right pane | Task 1 + 2 |
| Template fields: name, slug, description, category | Task 2 |
| Slug auto-generated from name (new), read-only (edit) | Task 2 |
| Agent list with Add new + Add from existing | Task 3 |
| Agent row: name, role, adapterType, reportsTo | Task 3 |
| Delete agent row | Task 3 |
| "From existing" picker: all agents across companies, search | Task 4 |
| Picker imports name/role/adapterType only | Task 4 |
| Save → POST (new) / PUT (edit) | Task 2 |
| On save: invalidate queries, switch to view, select template | Task 2 |
| Slug collision → inline error | Task 2 |
| Edit button on detail pane | Task 2 |
| Edit pre-populates editor from template data | Task 2 |
| Empty-state when no templates | Task 5 |

All requirements covered. No placeholders. No TBD.
