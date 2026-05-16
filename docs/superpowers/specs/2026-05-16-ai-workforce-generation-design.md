# AI Workforce Generation — Design Spec

**Date:** 2026-05-16
**Branch:** feature/agent-templates
**Status:** Approved

---

## Overview

Operators type a natural-language prompt describing a team they need (e.g., "I need a sales team for a B2B SaaS company with a manager and 3 reps"). Claude API generates a full agent workforce with names, roles, adapter types, org hierarchy, and instruction prompts. Operator reviews the org chart preview, then saves as a template or deploys directly to a company.

---

## Scope

**In scope:**
- Prompt input UI in right pane of Agent Templates page
- Server-side Claude API call returning structured workforce JSON
- Org chart preview using existing `OrgChartView` component
- "Save as Template" and "Deploy to Company" actions after preview
- "Try Again" to regenerate with same or edited prompt

**Out of scope:**
- Per-agent step-by-step approval (one approval for the full generation)
- Streaming token output
- MCP tool version (UI only for now)
- Editing individual agents inline during preview (use template editor post-save)

---

## UI Flow

### Entry point

Right pane **empty state** (nothing selected in left catalog) shows two buttons:
- "New Template" (existing)
- "Generate with AI" (new)

### Step 1: Prompt view

Right pane replaces empty state with:

```
┌────────────────────────────────────────────────────────┐
│  Generate Workforce with AI                             │
│                                                         │
│  Describe the team you need:                            │
│  ┌─────────────────────────────────────────────────┐   │
│  │ e.g. "A sales team for B2B SaaS with a manager  │   │
│  │ and 3 account executives"                        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│                              [Cancel]  [Generate →]     │
└────────────────────────────────────────────────────────┘
```

### Step 2: Loading

Spinner fills right pane while server calls Claude API. "Cancel" aborts.

### Step 3: Preview

Right pane shows generated workforce using existing components:

```
┌────────────────────────────────────────────────────────┐
│  [Generated name]  [category badge]                     │
│  [Generated description]                                │
│                                                         │
│  ORG CHART                                              │
│  [existing OrgChartView component]                      │
│                                                         │
│  AGENTS (N)                                             │
│  [existing agents list from TemplateDetailContent]      │
│                                                         │
│  [Try Again]  [Cancel]  [Save as Template] [Deploy →]  │
└────────────────────────────────────────────────────────┘
```

"Try Again" returns to Step 1 with the same prompt pre-filled.

---

## State Management

New `EditorMode` variant added:

```ts
type EditorMode =
  | { kind: "new" }
  | { kind: "edit"; templateId: string }
  | { kind: "generate" }
  | null;
```

Generation wizard local state:

```ts
type GenerationState = {
  step: "prompt" | "loading" | "preview";
  prompt: string;
  result: GeneratedWorkforce | null;
  error: string | null;
};

type GeneratedWorkforce = {
  name: string;
  slug: string;
  description: string;
  category: string;
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
};
```

---

## API

### New endpoint

`POST /api/agent-templates/generate`

- **Auth:** operator-only (board JWT, `isOperator` check)
- **Body:** `{ prompt: string }`
- **Response 200:** `GeneratedWorkforce` (see shape above)
- **Response 400:** `{ error: "prompt required" }`
- **Response 500:** `{ error: "generation failed" }`

### Server implementation

- Add `@anthropic-ai/sdk` to `server` package dependencies
- Call `anthropic.messages.create` with structured system prompt
- System prompt instructs Claude to return valid JSON only, matching `GeneratedWorkforce` shape
- Parse and validate response JSON before returning (Zod schema)
- `agentDefinitions` filled with defaults: `adapterConfig: {}`, `permissions: {}`, `budgetMonthlyCents: 0`, `skills: []`
- `teamStructure` uses agent names as IDs (mapped to slugs)

### Claude prompt strategy

System prompt specifies:
- Return only valid JSON, no prose
- Schema definition (field names, types, valid values for role/adapterType/category)
- Valid roles: `orchestrator`, `worker`, `observer`
- Valid adapterTypes: `ea`, `claude_local`, `codex_local`, `gemini_local`, `cursor`, `opencode_local`
- Valid categories: `dev`, `sales`, `finance`, `support`, `custom`
- Each agent must have `instructions` field (non-empty string)
- First agent in list is root (reportsTo: null); others reference parent by name

### New UI API client method

```ts
agentTemplatesApi.generate(prompt: string): Promise<GeneratedWorkforce>
// POST /api/agent-templates/generate
```

---

## Post-preview Actions

### Save as Template

Calls existing `agentTemplatesApi.create(input)` with the `GeneratedWorkforce` data. On success: invalidates `queryKeys.agentTemplates.all`, switches to detail view for new template.

### Deploy to Company

Uses existing deploy flow (company picker dropdown + "Deploy" button), same as `TemplateDetailContent`. Calls existing `agentTemplatesApi.deploy(templateId, companyId)` — but since generation result is not yet saved, **save first then deploy** (two-step: create → deploy).

---

## Error Handling

- Claude API failure → error message in right pane, "Try Again" button
- JSON parse failure → same as API failure (retry)
- 401/403 → "You must be an operator to use AI generation"
- Network error → generic error toast

---

## Files

| File | Change |
|---|---|
| `server/src/routes/agent-templates.ts` | Add `POST /generate` handler |
| `server/package.json` | Add `@anthropic-ai/sdk` dependency |
| `ui/src/pages/AgentTemplates.tsx` | Add `EditorMode "generate"`, `GenerationWizard` component, update empty state |
| `ui/src/lib/api.ts` | Add `agentTemplatesApi.generate()` method |

---

## Out of Scope

- Per-agent inline editing during preview (edit post-save in template editor)
- Streaming token output
- MCP tool trigger
- Saving prompt history
