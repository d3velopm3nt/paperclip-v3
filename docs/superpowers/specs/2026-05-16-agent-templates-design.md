# Agent Templates — Design Spec

**Date:** 2026-05-16
**Branch:** feature/storage-agent-file-access
**Status:** Approved

---

## Overview

Agent Templates lets operators deploy pre-built or custom agent teams to any company with one click. Templates bundle agent configs, instruction prompts, skills, and org-chart structure. The EA can also deploy templates programmatically via MCP tools.

---

## Data Model

### New table: `agent_templates`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | e.g. "Dev Team" |
| `slug` | text unique | e.g. "dev-team" |
| `description` | text | |
| `category` | text | `dev` \| `sales` \| `finance` \| `support` \| `custom` |
| `sourceType` | text | `built_in` \| `custom` |
| `agentDefinitions` | jsonb | Array of agent config objects |
| `teamStructure` | jsonb | Tree of `{ tempId, reportsTo }` |
| `metadata` | jsonb | `{ icon, tags, version, customized: boolean }` |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

No `companyId` — templates are instance-level. Any company can use any template.

### `agentDefinitions` entry shape

```jsonc
{
  "tempId": "tech-lead",           // used by teamStructure for wiring reportsTo
  "name": "Tech Lead",
  "role": "orchestrator",
  "adapterType": "ea",
  "adapterConfig": { ... },
  "capabilities": "...",
  "permissions": { ... },
  "budgetMonthlyCents": 0,
  "instructionsBundleDir": "tech-lead",  // relative to onboarding-assets/templates/<slug>/
  "skills": []                    // skill slugs to attach post-deploy (custom templates inline content)
}
```

### `teamStructure` shape

```jsonc
[
  { "tempId": "tech-lead", "reportsTo": null },
  { "tempId": "fullstack-dev", "reportsTo": "tech-lead" },
  { "tempId": "qa-agent", "reportsTo": "tech-lead" }
]
```

---

## File Layout

```
server/src/onboarding-assets/
  templates/
    dev-team/
      template.json          ← metadata + agentDefinitions + teamStructure
      tech-lead/
        AGENTS.md
      fullstack-dev/
        AGENTS.md
      qa-agent/
        AGENTS.md
```

Custom templates store instruction content inline in `agentDefinitions.instructionsContent` — no files needed.

---

## Seeding (Built-in Templates)

Service: `server/src/services/agent-templates.ts` — `seedAgentTemplates(db)`

- Runs at server startup alongside `seedEaAgents()`
- Reads `onboarding-assets/templates/*/template.json`
- Upserts into `agent_templates` by `slug`
- Skips update if `metadata.customized === true` (operator has customized it)
- Bumping `metadata.version` in `template.json` forces re-seed only if not customized

---

## Deploy Service

`deployTemplate(db, templateId, companyId): Promise<{ agentIds: string[] }>`

1. Load template row from DB
2. For each agent definition (in order):
   - Insert `agents` row with `companyId`
   - Seed instruction files: copy from `onboarding-assets/templates/<slug>/<agentDir>/` → `~/.paperclip/instances/default/ea/<newAgentId>/instructions/`
   - Attach any skills listed in definition
   - Build `tempId → realId` map
3. Second pass: set `reportsTo` using the map
4. `logActivity(db, { type: "template.deployed", templateId, companyId, agentIds })`
5. Broadcast `company:agents:updated` WebSocket event
6. Return `{ agentIds }`

---

## Save as Template Service

`saveAsTemplate(db, agentId, opts: { subtree: boolean }): Promise<AgentTemplate>`

- If `subtree: false` — snapshot single agent only
- If `subtree: true` — recursively walk `reportsTo` tree from root agent down
- For each agent: read config + instruction files
- Write `agent_templates` row with `sourceType: "custom"`, instructions content inlined
- Returns the new template

---

## API Routes

File: `server/src/routes/agent-templates.ts`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/agent-templates` | board | List all (built-in + custom) |
| `GET` | `/api/agent-templates/:id` | board | Full detail with definitions |
| `POST` | `/api/agent-templates` | admin | Create custom template |
| `PUT` | `/api/agent-templates/:id` | admin | Update template; sets `metadata.customized=true` for built-ins |
| `DELETE` | `/api/agent-templates/:id` | admin | Custom only — built-ins return 403 |
| `POST` | `/api/agent-templates/:id/deploy` | board | Body: `{ companyId }`. Calls deploy service. |

---

## EA MCP Tools

Added to `server/src/routes/mcp-tool-server.ts`:

### `list_agent_templates`
- No params
- Returns array of `{ id, slug, name, category, agentCount, description }`
- EA uses before deploying to know available slugs

### `deploy_agent_template`
- Params: `templateSlug: string`, `companyId?: string`
- `companyId` defaults to working context company
- Calls deploy service
- Returns `{ agentNames: string[], agentIds: string[] }`
- EA follows with `notify_operator` summary

### EA AGENTS.md addition

Small routing section appended:

```
## Agent Templates

When the operator asks to "set up a team", "add agents", or "onboard a new company":
1. `list_agent_templates` — see available templates
2. Pick best match for company type
3. `deploy_agent_template(slug, companyId)` — creates all agents + wires org chart
4. `notify_operator` with summary of what was deployed
```

---

## UI

### Page: Agent Templates

**Route:** `/instance/agent-templates`
**Nav:** Instance Settings sidebar, below GitHub

**Layout: two-pane**

Left pane — catalog:
- Cards: name, category badge, agent count, Built-in / Custom badge
- Filter by category
- "New Template" button (admin)

Right pane — detail (selected template):
- Name, description, category, source badge
- **Org chart preview** using existing `OrgChartSvg` component, rendered from `teamStructure` + `agentDefinitions`
- Agent list: expandable rows showing role, adapter type, capabilities, instructions preview
- **Deploy** button → company picker dropdown → confirm → spinner → success toast
- **Edit** / **Delete** for custom templates (admin only)
- Built-in templates show "Customized" badge if `metadata.customized` is true

### "Save as Template" on Agent Detail

**Location:** `ui/src/pages/AgentDetail.tsx` — context menu or actions section

Flow:
1. Click "Save as Template"
2. If agent has direct reports: prompt "This agent only, or full team?"
3. Confirm modal: template name (pre-filled), description, category
4. POST to `/api/agent-templates` with saveAsTemplate payload
5. Success toast linking to `/instance/agent-templates`

---

## Built-in Templates (V1)

### Dev Team

| Agent | Role | Adapter | Reports to |
|---|---|---|---|
| Tech Lead | orchestrator | ea | — (root) |
| Full-stack Dev | worker | ea | Tech Lead |
| QA Agent | worker | ea | Tech Lead |

Instructions cover:
- **Tech Lead:** task breakdown, PR review coordination, sprint planning, routes dev tasks to Full-stack Dev, QA issues to QA Agent
- **Full-stack Dev:** code implementation, follows project lifecycle, updates issues on completion
- **QA Agent:** test plan creation, bug reporting, UAT sign-off, blocks deployment if open P0s

---

## Error Handling

- Deploy with non-existent `companyId` → 404
- Deploy built-in with missing instruction files → 500 with clear message
- Delete built-in template → 403 "Built-in templates cannot be deleted"
- Duplicate slug on create → 409
- `saveAsTemplate` on agent with no instructions → creates template with empty instructions, operator edits post-creation

---

## Activity Log Events

| Type | Fired when |
|---|---|
| `template.deployed` | Deploy succeeds |
| `template.created` | Custom template created or saved from agent |
| `template.updated` | Template edited |
| `template.deleted` | Custom template deleted |

---

## Out of Scope (V1)

- Template versioning / changelog
- Marketplace / remote template registry
- Per-company template restrictions
- Template preview without deploying (org chart preview covers the need)
