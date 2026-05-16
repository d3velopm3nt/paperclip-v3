# AI Workforce Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator types a natural-language prompt in the Agent Templates right pane → Claude API generates a workforce → operator reviews org chart + agents → saves as template or deploys.

**Architecture:** New `workforce-generator.ts` service calls the Anthropic SDK and returns a `GeneratedWorkforce` typed object. A new `POST /api/agent-templates/generate` route (operator-only) calls the service. The UI adds a `GenerationWizard` component to `AgentTemplates.tsx` that cycles through prompt → loading → preview steps, reusing the existing org chart SVG rendering. "Deploy" does a create-then-deploy two-step since the generated workforce isn't persisted until the operator commits.

**Tech Stack:** `@anthropic-ai/sdk` (new server dep), Zod for response validation, React local state + TanStack Query mutations for UI.

---

## File Structure

| File | Change |
|---|---|
| `server/src/services/workforce-generator.ts` | New — `generateWorkforce(prompt, apiKey)` function |
| `server/src/__tests__/workforce-generator.test.ts` | New — unit tests for generator (mocked Anthropic) |
| `server/src/routes/agent-templates.ts` | Modify — add `POST /agent-templates/generate` route |
| `server/package.json` | Modify — add `@anthropic-ai/sdk` dependency |
| `ui/src/api/agentTemplates.ts` | Modify — add `generate(prompt)` method |
| `ui/src/pages/AgentTemplates.tsx` | Modify — add `GenerationWizard` component, update `EditorMode` type, update empty state |
| `.env.example` | Modify — document `ANTHROPIC_API_KEY` |

---

## Task 1: Anthropic SDK + workforce generator service

**Files:**
- Create: `server/src/services/workforce-generator.ts`
- Create: `server/src/__tests__/workforce-generator.test.ts`
- Modify: `server/package.json`

- [ ] **Step 1: Add `@anthropic-ai/sdk` to server package**

```bash
cd server && pnpm add @anthropic-ai/sdk
```

Expected: `@anthropic-ai/sdk` appears in `server/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

Create `server/src/__tests__/workforce-generator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateWorkforce } from "../services/workforce-generator.js";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const VALID_RESPONSE = {
  name: "Sales Team",
  slug: "sales-team",
  description: "A B2B sales team.",
  category: "sales",
  agents: [
    {
      tempId: "manager-a1b2",
      name: "Sales Manager",
      role: "orchestrator",
      adapterType: "ea",
      reportsTo: null,
      instructions: "Manage the sales team and set strategy.",
    },
    {
      tempId: "rep-c3d4",
      name: "Account Executive",
      role: "worker",
      adapterType: "ea",
      reportsTo: "manager-a1b2",
      instructions: "Close deals and maintain customer relationships.",
    },
  ],
};

describe("generateWorkforce", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns agentDefinitions and teamStructure from valid Claude response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(VALID_RESPONSE) }],
    });

    const result = await generateWorkforce("A B2B sales team", "sk-test");

    expect(result.name).toBe("Sales Team");
    expect(result.slug).toBe("sales-team");
    expect(result.category).toBe("sales");
    expect(result.agentDefinitions).toHaveLength(2);
    expect(result.agentDefinitions[0].tempId).toBe("manager-a1b2");
    expect(result.agentDefinitions[0].instructionsContent).toBe(
      "Manage the sales team and set strategy.",
    );
    expect(result.agentDefinitions[0].adapterConfig).toEqual({});
    expect(result.agentDefinitions[0].skills).toEqual([]);
    expect(result.agentDefinitions[0].budgetMonthlyCents).toBe(0);
    expect(result.teamStructure[0]).toEqual({ tempId: "manager-a1b2", reportsTo: null });
    expect(result.teamStructure[1]).toEqual({ tempId: "rep-c3d4", reportsTo: "manager-a1b2" });
  });

  it("throws when Claude returns invalid JSON", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "not json at all" }],
    });

    await expect(generateWorkforce("prompt", "sk-test")).rejects.toThrow();
  });

  it("throws when Claude returns JSON failing schema (invalid role)", async () => {
    const bad = { ...VALID_RESPONSE, agents: [{ ...VALID_RESPONSE.agents[0], role: "CEO" }] };
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(bad) }],
    });

    await expect(generateWorkforce("prompt", "sk-test")).rejects.toThrow();
  });

  it("throws when Claude returns non-text content block", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });

    await expect(generateWorkforce("prompt", "sk-test")).rejects.toThrow("Unexpected response");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm vitest run server/src/__tests__/workforce-generator.test.ts
```

Expected: FAIL with "Cannot find module '../services/workforce-generator.js'"

- [ ] **Step 4: Create `server/src/services/workforce-generator.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentTemplateDefinition, TeamStructureEntry } from "@paperclipai/shared";

const GeneratedAgentSchema = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["orchestrator", "worker", "observer"]),
  adapterType: z.enum(["ea", "claude_local", "codex_local", "gemini_local", "cursor", "opencode_local"]),
  reportsTo: z.string().nullable(),
  instructions: z.string().min(1),
});

const GeneratedWorkforceSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  category: z.enum(["dev", "sales", "finance", "support", "custom"]),
  agents: z.array(GeneratedAgentSchema).min(1),
});

export interface GeneratedWorkforce {
  name: string;
  slug: string;
  description: string;
  category: string;
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
}

const SYSTEM_PROMPT = `You generate AI agent workforce configurations. Return ONLY valid JSON matching this exact schema:

{
  "name": "string",
  "slug": "string (lowercase letters, digits, hyphens only — e.g. 'sales-team')",
  "description": "string (one sentence)",
  "category": "dev" | "sales" | "finance" | "support" | "custom",
  "agents": [
    {
      "tempId": "string (slugified name + 4 random chars — e.g. 'tech-lead-a1b2')",
      "name": "string",
      "role": "orchestrator" | "worker" | "observer",
      "adapterType": "ea" | "claude_local" | "codex_local" | "gemini_local" | "cursor" | "opencode_local",
      "reportsTo": "tempId of parent" | null,
      "instructions": "string (2-4 sentences describing role responsibilities)"
    }
  ]
}

Rules:
- Exactly one agent must have reportsTo: null (the root orchestrator)
- All other reportsTo values must be a valid tempId in the same agents array
- Default adapterType is "ea" unless context strongly suggests otherwise
- Return valid JSON only — no markdown fences, no prose, no explanations`;

export async function generateWorkforce(
  prompt: string,
  apiKey: string,
): Promise<GeneratedWorkforce> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Claude API");

  const parsed = JSON.parse(block.text) as unknown;
  const validated = GeneratedWorkforceSchema.parse(parsed);

  const agentDefinitions: AgentTemplateDefinition[] = validated.agents.map((a) => ({
    tempId: a.tempId,
    name: a.name,
    role: a.role,
    adapterType: a.adapterType,
    adapterConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    skills: [],
    instructionsContent: a.instructions,
  }));

  const teamStructure: TeamStructureEntry[] = validated.agents.map((a) => ({
    tempId: a.tempId,
    reportsTo: a.reportsTo,
  }));

  return {
    name: validated.name,
    slug: validated.slug,
    description: validated.description,
    category: validated.category,
    agentDefinitions,
    teamStructure,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm vitest run server/src/__tests__/workforce-generator.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 6: TypeScript check**

```bash
cd server && pnpm typecheck
```

Expected: no errors in workforce-generator.ts

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/src/services/workforce-generator.ts server/src/__tests__/workforce-generator.test.ts
git commit -m "feat(server): add workforce-generator service with Anthropic SDK"
```

---

## Task 2: POST /agent-templates/generate route

**Files:**
- Modify: `server/src/routes/agent-templates.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the route to `server/src/routes/agent-templates.ts`**

Add this block **after** the `save-as-template` route (line 71) and **before** the `/:id` GET route (line 73). Also add the import at the top.

Add to imports at top of file:
```typescript
import { generateWorkforce } from "../services/workforce-generator.js";
```

Add after the `save-as-template` route and before `router.get("/agent-templates/:id", ...)`:

```typescript
  // Must be before /:id routes to avoid "generate" matching as an id param
  router.post("/agent-templates/generate", async (req, res) => {
    assertInstanceAdmin(req);
    const { prompt } = req.body as { prompt?: string };
    if (!prompt?.trim()) throw badRequest("prompt required");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on this server" });
      return;
    }
    try {
      const result = await generateWorkforce(prompt.trim(), apiKey);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "generation failed";
      res.status(500).json({ error: msg });
    }
  });
```

- [ ] **Step 2: Document env var in `.env.example`**

Add to `.env.example`:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

- [ ] **Step 3: TypeScript check**

```bash
cd server && pnpm typecheck
```

Expected: no errors

- [ ] **Step 4: Run all server tests to check nothing broke**

```bash
pnpm vitest run server/src/__tests__/agent-templates.test.ts server/src/__tests__/workforce-generator.test.ts
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/agent-templates.ts .env.example
git commit -m "feat(server): add POST /agent-templates/generate operator endpoint"
```

---

## Task 3: UI API client method

**Files:**
- Modify: `ui/src/api/agentTemplates.ts`

- [ ] **Step 1: Add `GeneratedWorkforce` interface and `generate` method**

Open `ui/src/api/agentTemplates.ts`. The current content imports from `@paperclipai/shared` and exports `agentTemplatesApi`. Add the `GeneratedWorkforce` interface and `generate` method.

Full updated file:

```typescript
import type {
  AgentTemplate,
  AgentTemplateSummary,
  DeployTemplateResult,
  CreateCustomTemplateInput,
  UpdateTemplateInput,
  AgentTemplateDefinition,
  TeamStructureEntry,
} from "@paperclipai/shared";
import { api } from "./client";

export interface AgentTemplateSummaryWithCount extends AgentTemplateSummary {
  agentCount: number;
}

export interface GeneratedWorkforce {
  name: string;
  slug: string;
  description: string;
  category: string;
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
}

export const agentTemplatesApi = {
  list: () => api.get<AgentTemplateSummaryWithCount[]>("/agent-templates"),
  get: (id: string) => api.get<AgentTemplate>(`/agent-templates/${id}`),
  deploy: (id: string, companyId: string) =>
    api.post<DeployTemplateResult>(`/agent-templates/${id}/deploy`, { companyId }),
  create: (input: CreateCustomTemplateInput) =>
    api.post<AgentTemplate>("/agent-templates", input),
  update: (id: string, input: UpdateTemplateInput) =>
    api.put<AgentTemplate>(`/agent-templates/${id}`, input),
  delete: (id: string) => api.delete<{ ok: boolean }>(`/agent-templates/${id}`),
  saveAsTemplate: (input: {
    agentId: string;
    subtree: boolean;
    name: string;
    slug: string;
    description?: string;
    category: string;
  }) => api.post<AgentTemplate>("/agent-templates/save-as-template", input),
  generate: (prompt: string) =>
    api.post<GeneratedWorkforce>("/agent-templates/generate", { prompt }),
};
```

- [ ] **Step 2: TypeScript check**

```bash
cd ui && pnpm typecheck 2>&1 | grep -v "Analytics\|AgentPerformanceTab\|email-processor\|email-plan-gate"
```

Expected: no new errors (pre-existing Analytics/email errors are on master and not caused by this change)

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/agentTemplates.ts
git commit -m "feat(ui): add agentTemplatesApi.generate() client method"
```

---

## Task 4: GenerationWizard component + wiring

**Files:**
- Modify: `ui/src/pages/AgentTemplates.tsx`

This task adds:
1. `{ kind: "generate" }` variant to `EditorMode` type
2. `GenerationWizard` component (prompt / loading / preview steps)
3. "Generate with AI" button in the right pane empty state
4. Wiring in the main `AgentTemplates` render

- [ ] **Step 1: Update `EditorMode` type (line 155 in AgentTemplates.tsx)**

Find:
```typescript
type EditorMode = { kind: "new" } | { kind: "edit"; templateId: string } | null;
```

Replace with:
```typescript
type EditorMode = { kind: "new" } | { kind: "edit"; templateId: string } | { kind: "generate" } | null;
```

- [ ] **Step 2: Add `GeneratedWorkforce` import to the imports section**

In the imports at the top of `AgentTemplates.tsx`, add `GeneratedWorkforce` to the agentTemplates import line:

```typescript
import { agentTemplatesApi } from "../api/agentTemplates";
import type { AgentTemplateSummaryWithCount, GeneratedWorkforce } from "../api/agentTemplates";
```

Also add `Sparkles` to the lucide-react import:
```typescript
import { LayoutTemplate, Plus, Trash2, X, Search, Sparkles } from "lucide-react";
```

And add `useQueryClient` to the tanstack import (if not already present — check line 2):
```typescript
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
```

- [ ] **Step 3: Add the `GenerationWizard` component**

Insert this component **after** the `TemplateEditor` component (after line 840, before the `// ── Main page` comment).

```typescript
// ── Generation wizard ────────────────────────────────────────────────────────
type GenStep = "prompt" | "loading" | "preview";

function GenerationWizard({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { companies, selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<GenStep>("prompt");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<GeneratedWorkforce | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [deployCompanyId, setDeployCompanyId] = useState<string>(selectedCompanyId ?? "");

  const orgRoots = useMemo(
    () => (result ? buildOrgTree(result.agentDefinitions, result.teamStructure) : []),
    [result],
  );
  const layout = useMemo(() => layoutForest(orgRoots), [orgRoots]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);
  const svgBounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 400, height: 200 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) { maxX = Math.max(maxX, n.x + CARD_W); maxY = Math.max(maxY, n.y + CARD_H); }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  const generateMutation = useMutation({
    mutationFn: () => agentTemplatesApi.generate(prompt),
    onSuccess: (data) => { setResult(data); setStep("preview"); setGenError(null); },
    onError: (err) => {
      setGenError(err instanceof Error ? err.message : "Generation failed. Please try again.");
      setStep("prompt");
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      agentTemplatesApi.create({
        name: result!.name,
        slug: result!.slug,
        description: result!.description || undefined,
        category: result!.category,
        agentDefinitions: result!.agentDefinitions,
        teamStructure: result!.teamStructure,
      }),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.all });
      pushToast({ tone: "success", title: "Template saved" });
      onSaved(saved.id);
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Save failed", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const deployMutation = useMutation({
    mutationFn: async () => {
      const saved = await agentTemplatesApi.create({
        name: result!.name,
        slug: result!.slug,
        description: result!.description || undefined,
        category: result!.category,
        agentDefinitions: result!.agentDefinitions,
        teamStructure: result!.teamStructure,
      });
      return agentTemplatesApi.deploy(saved.id, deployCompanyId);
    },
    onSuccess: (deployResult) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.all });
      pushToast({
        tone: "success",
        title: `Deployed ${deployResult.agentIds.length} agent${deployResult.agentIds.length !== 1 ? "s" : ""}`,
        body: deployResult.agentNames.join(", "),
      });
      onCancel();
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Deploy failed", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  if (step === "loading") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <div className="animate-spin h-6 w-6 rounded-full border-2 border-border border-t-foreground" />
        <p className="text-sm text-muted-foreground">Generating your workforce…</p>
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }

  if (step === "preview" && result) {
    return (
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{result.name}</h2>
              <CategoryBadge category={result.category} />
            </div>
            {result.description && <p className="text-sm text-muted-foreground">{result.description}</p>}
          </div>
        </div>

        {allNodes.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Org Chart</h3>
            <div className="border border-border rounded-lg bg-muted/20 overflow-auto" style={{ maxHeight: 280 }}>
              <svg width={svgBounds.width} height={svgBounds.height} style={{ display: "block" }}>
                {edges.map(({ parent, child }) => {
                  const x1 = parent.x + CARD_W / 2;
                  const y1 = parent.y + CARD_H;
                  const x2 = child.x + CARD_W / 2;
                  const y2 = child.y;
                  const midY = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${parent.tempId}-${child.tempId}`}
                      d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                      fill="none" stroke="var(--border)" strokeWidth={1.5}
                    />
                  );
                })}
                {allNodes.map((node) => (
                  <g key={node.tempId} transform={`translate(${node.x}, ${node.y})`}>
                    <rect width={CARD_W} height={CARD_H} rx={8} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
                    <text x={CARD_W / 2} y={26} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)">
                      {node.name.length > 20 ? node.name.slice(0, 18) + "…" : node.name}
                    </text>
                    <text x={CARD_W / 2} y={44} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                      {node.role.length > 24 ? node.role.slice(0, 22) + "…" : node.role}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Agents ({result.agentDefinitions.length})
          </h3>
          <div className="space-y-1">
            {result.agentDefinitions.map((def) => (
              <div key={def.tempId} className="rounded-md border border-border px-3 py-2 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{def.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">{def.role}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{def.adapterType}</span>
                  </div>
                </div>
                {def.instructionsContent && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{def.instructionsContent}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border flex-wrap">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("prompt")}>Try Again</Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={saveMutation.isPending || deployMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Saving…" : "Save as Template"}
            </Button>
            <select
              value={deployCompanyId}
              onChange={(e) => setDeployCompanyId(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {companies.length === 0 && <option value="">No companies</option>}
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Button
              size="sm"
              disabled={!deployCompanyId || deployMutation.isPending || saveMutation.isPending}
              onClick={() => deployMutation.mutate()}
            >
              {deployMutation.isPending ? "Deploying…" : "Deploy →"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // prompt step (default)
  return (
    <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Generate Workforce with AI</h2>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {genError && (
        <p className="text-sm text-destructive rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          {genError}
        </p>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Describe the team you need</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder='e.g. "A sales team for a B2B SaaS company with a manager and 3 account executives"'
          rows={4}
          className="text-sm resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) {
              setStep("loading");
              generateMutation.mutate();
            }
          }}
        />
        <p className="text-[11px] text-muted-foreground">Tip: Cmd+Enter to generate</p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          disabled={!prompt.trim() || generateMutation.isPending}
          onClick={() => { setStep("loading"); generateMutation.mutate(); }}
        >
          Generate →
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update the right pane in `AgentTemplates` to handle `editorMode.kind === "generate"`**

In the `AgentTemplates` main component, find the right pane render block (around line 902–944). Replace it with:

```typescript
      {/* Right pane */}
      <div className="flex-1 min-w-0 flex flex-col h-full min-h-0">
        {editorMode?.kind === "generate" ? (
          <GenerationWizard
            onCancel={() => setEditorMode(null)}
            onSaved={(id) => { setEditorMode(null); setSelectedId(id); }}
          />
        ) : editorMode ? (
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
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            {(!templates || templates.length === 0) ? (
              <EmptyState icon={LayoutTemplate} message="No templates yet. Create one to get started." />
            ) : (
              <p className="text-sm text-muted-foreground">Select a template to view details.</p>
            )}
            <div className="flex items-center gap-2 mt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setEditorMode({ kind: "new" });
                  setEditorName("");
                  setEditorSlug("");
                  setEditorDescription("");
                  setEditorCategory("custom");
                  setEditorAgents([]);
                  setEditorSlugError(null);
                }}
              >
                New Template
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => setEditorMode({ kind: "generate" })}
              >
                <Sparkles className="h-3 w-3" />
                Generate with AI
              </Button>
            </div>
          </div>
        )}
      </div>
```

- [ ] **Step 5: TypeScript check**

```bash
cd ui && pnpm typecheck 2>&1 | grep -v "Analytics\|AgentPerformanceTab\|email-processor\|email-plan-gate"
```

Expected: no new errors

- [ ] **Step 6: Run all tests**

```bash
pnpm test:run
```

Expected: same pass/fail ratio as before this change (no new failures). Pre-existing failures on master are: Analytics, AgentPerformanceTab TS errors, email-processor + email-plan-gate-e2e timeouts.

- [ ] **Step 7: Build check**

```bash
pnpm build 2>&1 | tail -20
```

Expected: successful build

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx
git commit -m "feat(ui): add GenerationWizard component for AI workforce generation"
```

---

## Final verification

- [ ] **Run full verification**

```bash
pnpm -r typecheck && pnpm test:run && pnpm build
```

Expected: passes (same pre-existing failures as master, no regressions)

- [ ] **Manual smoke test**

1. Run `pnpm dev`
2. Navigate to Instance Settings → Agent Templates
3. Right pane empty state shows "New Template" + "Generate with AI" buttons
4. Click "Generate with AI" → prompt textarea appears
5. Type a prompt → click "Generate →" → loading spinner
6. Preview shows org chart + agents list + Save/Deploy buttons
7. "Try Again" returns to prompt step with same prompt
8. "Save as Template" saves and switches to detail view
9. Verify: if `ANTHROPIC_API_KEY` not set, server returns 500 with friendly message shown in UI

**Note:** Step 5 requires `ANTHROPIC_API_KEY` in `.env`. Add it before testing the happy path. Without it, step 5 shows the error state (expected behavior).
