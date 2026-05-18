# ECC Agents — Founder Visibility & Agent Infrastructure

**Date:** 2026-05-09  
**Branch:** feature/founder-overview-redesign  
**Status:** Design approved, pending implementation

---

## Goal

Make the ECC orchestrator visible as two registered agents — Executive Control Agent and Client Control Agent — surfaced at the founder level (not company-scoped). These agents appear in the Founder Overview, are always visible regardless of activity, and have full agent detail pages where their system prompts are editable from the UI.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema model | Nullable `companyId` in existing `agents` table | Reuses all agent infrastructure, minimal migration |
| Agent granularity | Two agents (Executive + Client) | Mirrors orchestrator's dual role |
| UI placement | New "ECC Agents" section, top of FounderOverview left panel | Founder-level, above Companies |
| Agent detail page | Full existing AgentDetail — same tabs | No divergence from existing infrastructure |
| System prompt storage | `adapterConfig.systemPrompt` in DB | Editable from UI; orchestrator reads from DB |
| Workflow run ownership | Operator runs → Executive, client runs → Client Control | Mirrors actual processing split |

---

## Schema Changes

### 1. `packages/db/src/schema/agents.ts`

Make `companyId` nullable:

```ts
companyId: uuid("company_id")
  // .notNull() — REMOVED
  .references(() => companies.id),
```

New Drizzle migration required (`pnpm db:generate`).

No new columns. Existing `adapterConfig` JSONB stores the system prompt. Existing `lastHeartbeatAt` is used as last-active time. Existing `metadata` JSONB stores current processing context.

### 2. `adapterConfig` shape for ECC agents

```ts
{
  systemPrompt: string;      // editable ECC system prompt
  promptVersion: number;     // incremented on save (for auditing)
}
```

### 3. `metadata` shape during processing

```ts
{
  currentTopicId: string;
  currentTopicName: string;
  lastMessagePreview: string;  // first 120 chars
}
```

---

## Agent Seeding

Two agents auto-seeded on server startup (in `server/src/index.ts` or a dedicated `ecc-agents.ts` seeder) if not already present:

| Field | Executive Control Agent | Client Control Agent |
|-------|------------------------|---------------------|
| `name` | "Executive Control Agent" | "Client Control Agent" |
| `role` | "orchestrator" | "orchestrator" |
| `adapterType` | "ecc" | "ecc" |
| `companyId` | `null` | `null` |
| `adapterConfig.systemPrompt` | `ECC_SYSTEM_PROMPT` (current hardcoded string) | `CLIENT_SYSTEM_PROMPT` (current hardcoded string) |
| `status` | "idle" | "idle" |

Seeder is idempotent — queries `WHERE adapterType = 'ecc' AND name = '...'` before inserting.

---

## Orchestrator Changes (`server/src/services/orchestrator.ts`)

### System prompt — read from DB

```ts
// New helper in ecc-agents service:
async function getEccAgent(role: "operator" | "client"): Promise<Agent | null>

// In orchestrator, replace:
const systemPrompt = isOperator ? ECC_SYSTEM_PROMPT : CLIENT_SYSTEM_PROMPT;

// With:
const eccAgent = await eccAgentsService.getEccAgent(isOperator ? "operator" : "client");
const systemPrompt = (eccAgent?.adapterConfig as any)?.systemPrompt
  ?? (isOperator ? ECC_SYSTEM_PROMPT : CLIENT_SYSTEM_PROMPT);
```

### Status lifecycle

On spawn start (before CLI subprocess):
```ts
await eccAgentsService.setProcessing(eccAgent.id, topicId, topicName, messagePreview);
// updates: status="processing", metadata={currentTopicId, currentTopicName, lastMessagePreview}
```

On spawn end (after appendMessage, whether success or error):
```ts
await eccAgentsService.setIdle(eccAgent.id);
// updates: status="idle", lastHeartbeatAt=now, metadata={}
```

Both agents set to processing/idle on every spawn (they both participate in every orchestrator run).

### Workflow run ownership

`resolve_conversation` creates a `workflow_runs` row. Pass `agentId` to it:

```ts
// isOperator spawn → Executive Control Agent ID
// !isOperator spawn → Client Control Agent ID
const agentId = isOperator ? execAgentId : clientAgentId;
// pass agentId into resolve_conversation call / workflow_runs insert
```

This requires `workflow_runs.agentId` to be set — check if column already exists or add it.

---

## New Service: `server/src/services/ecc-agents.ts`

```ts
eccAgentsService = {
  getEccAgent(role: "operator" | "client"): Promise<Agent | null>
  setProcessing(id, topicId, topicName, messagePreview): Promise<void>
  setIdle(id): Promise<void>
  listEccAgents(): Promise<Agent[]>  // returns both ECC agents
}
```

---

## New API Route

### `GET /api/ecc/agents`

Returns both ECC agents (no auth beyond board):

```ts
router.get("/ecc/agents", boardAuth, async (req, res) => {
  const agents = await eccAgentsService.listEccAgents();
  res.json(agents);
});
```

Response shape reuses existing `Agent` type from `@paperclipai/shared`. Fields used by UI: `id`, `name`, `status`, `lastHeartbeatAt`, `metadata`.

---

## UI Changes

### 1. `FounderOverview.tsx` — new ECC Agents section

New query at top of component:
```ts
const eccAgentsQuery = useQuery({
  queryKey: ["ecc-agents"],
  queryFn: () => api.get<Agent[]>("/ecc/agents"),
  refetchInterval: (data) =>
    data?.some(a => a.status === "processing") ? 5_000 : 15_000,
});
```

New `EccAgentCard` component:
- **Processing state**: blue border, pulsing dot, topic name (violet badge), message preview
- **Idle state**: gray border, dim dot, "last active X ago"
- **Error/paused state**: red border
- `onClick`: `navigate("/agents/" + agent.id + "/instructions")`

New section rendered before Companies grid:
```tsx
<section>
  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
    ECC Agents
  </h2>
  <div className="grid grid-cols-2 gap-3">
    {eccAgents.map(agent => <EccAgentCard key={agent.id} agent={agent} />)}
  </div>
</section>
```

### 2. `AgentDetail.tsx` — PromptsTab ECC case

In `PromptsTab`, add ECC adapter detection alongside `isLocal`:

```ts
const isEcc = agent.adapterType === "ecc";
```

When `isEcc`:
- Skip file browser entirely
- Render single `<textarea>` bound to `agent.adapterConfig.systemPrompt`
- Save via existing `PATCH /api/agents/:id` → updates `adapterConfig`
- Add note: "Orchestrator reads this prompt on the next spawn"

### 3. `AgentDetail.tsx` — tab visibility for ECC agents

No tabs hidden (use same infrastructure). Natural behavior:
- **Instructions** — shows editable textarea (as above)
- **Skills** — shows empty (no paperclip skills; agent uses MCP)
- **MCPs** — shows Paperclip MCP server config
- **Runs** — shows `ecc_conversation` workflow runs owned by this agent
- **Dashboard, Memory, Performance, Budget, Emails** — render as normal; company-dependent queries gracefully degrade if `companyId` is null (most already check `!!resolvedCompanyId`)

### 4. Route — no changes needed

`/agents/:agentId/instructions` already works without a company prefix. ECC agent cards navigate there directly.

---

## Auth Guard — Null CompanyId

`assertCompanyAccess(req, companyId: string)` is typed `string`, not `string | null`. ECC agents have `companyId = null` — passing null will TypeScript error.

Fix in `server/src/routes/agents.ts` auth helpers (`assertCanReadAgent`, `assertCanUpdateAgent`, `assertCanReadConfigurations`, `assertCanManageInstructionsPath`):

```ts
// If companyId is null → ECC/founder-level agent → board access only
if (!targetAgent.companyId) {
  assertBoard(req);
  return;
}
assertCompanyAccess(req, targetAgent.companyId);
```

`assertBoard` already exists in `authz.ts`.

---

## workflow_runs — agentId Column

`workflow_runs` currently has no `agentId` column. Add it:

```ts
// packages/db/src/schema/workflow_runs.ts
agentId: uuid("agent_id").references(() => agents.id),  // nullable
```

Orchestrator passes `agentId` when inserting the workflow run row. Existing runs (without agentId) remain valid — nullable column.

---

## Affected Files

| File | Change |
|------|--------|
| `packages/db/src/schema/agents.ts` | `companyId` → nullable |
| `packages/db/src/schema/workflow_runs.ts` | Add nullable `agentId` column |
| `server/src/routes/agents.ts` | Null-guard in auth helpers for null-companyId agents |
| `server/src/services/ecc-agents.ts` | **New** — seeder + status helpers |
| `server/src/services/orchestrator.ts` | Read prompt from DB, set agent status, pass agentId to workflow run |
| `server/src/routes/ecc-topics.ts` | Add `GET /ecc/agents` route |
| `ui/src/pages/founder/FounderOverview.tsx` | New ECC Agents section + `EccAgentCard` component |
| `ui/src/pages/AgentDetail.tsx` | `PromptsTab` ECC case (textarea) |

---

## Out of Scope

- Agent appearing in company sidebar (ECC agents are founder-level only)
- Separate `/founder/agents/:id` route (use existing `/agents/:id`)
- Budget enforcement for ECC agents (can be added later)
- Per-turn prompt versioning / audit log

---

## Verification

```sh
pnpm db:generate   # migration for nullable companyId
pnpm -r typecheck
pnpm test:run
pnpm build
```

Manual checks:
1. ECC agents auto-seeded on server start
2. FounderOverview shows ECC Agents section above Companies
3. Agent card status updates to "processing" during Telegram message handling
4. Clicking agent card → agent detail page, Instructions tab, shows editable prompt
5. Edit + save prompt → next Telegram message uses updated prompt
6. Runs tab on each agent shows only its type of runs (operator vs client)
