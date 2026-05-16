# Agent Template Editor — Design Spec

**Date:** 2026-05-16
**Branch:** feature/agent-templates
**Status:** Approved

---

## Overview

Add a template editor to the Agent Templates page. Operators can create new templates or edit existing ones directly in the right pane. Each template agent can be defined from scratch or imported from an existing agent in the system (copies name/role/adapterType only — deep editing happens on the deployed agent via Agent Detail).

---

## Scope

**In scope:**
- New Template editor (replaces toast stub)
- Edit existing template (custom only; built-ins become customized on save)
- Per-agent fields: name, role, adapter type, "reports to"
- "From existing agent" picker — copies basic config from any agent in the system
- Delete agent row from template

**Out of scope:**
- Editing instructions content inline (done post-deploy in Agent Detail)
- Skills management in template editor
- Drag-and-drop org chart builder

---

## UI — Right Pane Edit Mode

### Triggering edit mode

- **New template:** "New Template" button in left pane header → right pane shows blank editor
- **Edit existing:** "Edit" button in right pane detail header (visible to admin users; present for custom templates and built-ins alike)
- **Cancel:** returns right pane to detail/empty state, discards changes

### Editor layout

```
┌────────────────────────────────────────────────────────┐
│  Template Details                                       │
│  Name: [________________]  Slug: [________________]    │
│  Description: [________________________________________]│
│  Category: [dev ▼]                                     │
├────────────────────────────────────────────────────────┤
│  Agents                                    [+ Add ▼]   │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Name       Role         Adapter   Reports To  [×]│  │
│  │ Tech Lead  orchestrator  ea        —            │  │
│  │ Dev        worker        ea        Tech Lead    │  │
│  └──────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────┤
│                            [Cancel]  [Save Template]   │
└────────────────────────────────────────────────────────┘
```

### Template fields

| Field | Type | Notes |
|---|---|---|
| `name` | text input | required |
| `slug` | text input | auto-generated from name (`toSlug(name)`), user can override; validated `[a-z0-9-]+` |
| `description` | textarea | optional |
| `category` | select | `dev`, `sales`, `finance`, `support`, `custom` |

### Agent row fields

| Field | Type | Notes |
|---|---|---|
| `name` | text input | required |
| `role` | select | `orchestrator`, `worker`, `observer` |
| `adapterType` | select | `ea`, `claude_local`, `codex_local`, `gemini_local`, `cursor`, `opencode_local` |
| `reportsTo` | select | picks from other agents in this template (by `tempId`); null = root |

Each agent row has a delete (×) button. `tempId` is auto-generated as slugified name + short random suffix on add.

### "+ Add agent" button

Split-style button with dropdown:
- **New agent** — adds a blank row with defaults (role: worker, adapterType: ea, reportsTo: first root agent or null)
- **From existing agent** — opens picker modal

---

## "From Existing Agent" Picker Modal

- Fetches agents for each company using `agentsApi.list(companyId)` for all companies in `useCompany().companies`
- Displays a searchable flat list: agent name, company name, role, adapterType
- Single-select; confirm button copies the selected agent's name/role/adapterType into a new agent row (reportsTo defaults to null)
- Instructions are NOT copied

---

## State Management

Local component state in `AgentTemplates.tsx`:

```ts
type EditorAgent = {
  tempId: string;
  name: string;
  role: string;
  adapterType: string;
  reportsTo: string | null;  // tempId of parent, or null
};

type EditorState = {
  mode: "view" | "edit";
  editingId: string | null;  // null = new template
  name: string;
  slug: string;
  description: string;
  category: string;
  agents: EditorAgent[];
};
```

On save:
- Map `EditorAgent[]` → `AgentTemplateDefinition[]` (fill defaults: `adapterConfig: {}`, `permissions: {}`, `budgetMonthlyCents: 0`, `skills: []`)
- Map `EditorAgent[]` → `TeamStructureEntry[]` (using `tempId` + `reportsTo`)
- New: `POST /api/agent-templates`
- Edit: `PUT /api/agent-templates/:id`
- On success: invalidate `queryKeys.agentTemplates.all`, switch back to view mode, select the saved template

---

## API

Existing endpoints used (no new server routes needed):
- `agentTemplatesApi.create(input)` — POST `/api/agent-templates`
- `agentTemplatesApi.update(id, input)` — PUT `/api/agent-templates/:id`
- `agentsApi.list(companyId)` — for existing agent picker

---

## Validation

- Name required; slug required and must match `[a-z0-9-]+`
- At least one agent required to save
- Slug uniqueness checked server-side (409 → show inline error)
- Duplicate `tempId` not possible (generated on add)

---

## Error Handling

- 409 on slug collision → inline error below slug field
- Other save errors → error toast
- Picker fetch error → show "Failed to load agents" in modal

---

## Files

| File | Change |
|---|---|
| `ui/src/pages/AgentTemplates.tsx` | Add editor state, editor form, picker modal, edit/save/cancel logic |

No new files needed — all editor UI lives inline in the existing page component.

---

## Out of Scope

- Delete template from editor (already on detail view for custom templates)
- Template versioning
- Instructions editing inline
