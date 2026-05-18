# Founder Overview Redesign — Implementation Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Founder Overview tab into a two-column dashboard — left shows enhanced company cards (with active topics + running agent chips) and the needs-attention table; right shows a live conversation feed — giving the founder one place to see all company state, agents, and recent interactions.

**Architecture:** Pure UI change plus one small server filter addition. No new DB tables. Reuses existing `/ecc/topics`, `/ecc/conversations`, and `/companies/:companyId/workflow-runs` endpoints. The right panel is a condensed version of `FounderConversations` embedded inline.

**Tech Stack:** React 19, TanStack Query, Tailwind 4, existing Express routes.

---

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Founder Overview  [Overview] [Topics] [Conversations] ...   │
├───────────────────────────────────┬─────────────────────────┤
│  COMPANIES                        │  LIVE CONVERSATIONS      │
│  ┌──────────────────────────────┐ │  ┌─────────────────────┐│
│  │ ● Innotrack    21 open ⚠1   │ │  │ ✅ [Tender] [Inno]  ││
│  │ Topics: Tender, AssetX       │ │  │ New tender from...  ││
│  │ [🟢 CEO Agent · processing] │ │  │ ↳ Issue created.    ││
│  │ [⚫ Dev Agent  · idle]       │ │  └─────────────────────┘│
│  └──────────────────────────────┘ │  ┌─────────────────────┐│
│  ┌──────────────────────────────┐ │  │ ✅ [Tender] [Inno]  ││
│  │ ● Develtech     9 open ⚠1   │ │  │ Bug from Michelle...││
│  │ Topics: Paperclip v3         │ │  └─────────────────────┘│
│  │ [🟢 CEO Agent · reviewing]  │ │                          │
│  └──────────────────────────────┘ │  Show all conversations→ │
│                                   │                          │
│  NEEDS ATTENTION                  │                          │
│  Company | Issue | Title | Status │                          │
│  ...                              │                          │
└───────────────────────────────────┴─────────────────────────┘
```

Left column: 60% (`flex-[3]`). Right column: 40% (`flex-[2]`).

---

## Data Sources

| Section | Endpoint | Notes |
|---------|----------|-------|
| Company list | `CompanyContext` (already loaded) | No new fetch |
| Open/blocked counts | `GET /companies/:id/issues` (already fetched per company) | No change |
| Active topics | `GET /ecc/topics` (board) | Filter client-side by `companyId` |
| Running agents | `GET /companies/:id/workflow-runs?status=running&limit=5` | Needs `status` filter added to server |
| Conversations | `GET /ecc/conversations?limit=8` | Existing endpoint, add `limit` param support |

---

## Server Changes

### 1. `server/src/routes/workflow-runs.ts` — add `?status=running` filter

Current query builds `where` from `type` only. Add `status` filter alongside:

```typescript
// GET /api/companies/:companyId/workflow-runs?type=X&status=running&limit=50
const type = typeof req.query.type === "string" ? req.query.type : null;
const status = typeof req.query.status === "string" ? req.query.status : null;
const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

const conditions = [eq(workflowRuns.companyId, companyId)];
if (type) conditions.push(eq(workflowRuns.workflowType, type));
if (status) conditions.push(eq(workflowRuns.overallStatus, status));
const where = conditions.length === 1 ? conditions[0] : and(...conditions);
```

### 2. `server/src/routes/ecc-topics.ts` — support `?limit` on conversations list

```typescript
// GET /ecc/conversations?all=true&limit=8
const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
const conversations = showAll
  ? await convSvc.listAll(limit)
  : await convSvc.listAllActive(limit);
```

Update `eccConversationsService.listAllActive` signature: `async function listAllActive(limit = 100): Promise<EccConversation[]>` — add `.limit(limit)` to the Drizzle query. Default 100 preserves existing callers.

---

## UI Changes

### `ui/src/pages/founder/FounderOverview.tsx` — full rewrite

**New data fetches added to `FounderOverview`:**
```typescript
// Topics — fetch once, group by companyId client-side
const topicsQuery = useQuery({
  queryKey: ["ecc-topics"],
  queryFn: () => api.get<EccTopic[]>("/ecc/topics"),
  staleTime: 30_000,
});

// Running agents — one query per company (useQueries)
const agentQueries = useQueries({
  queries: activeCompanies.map((c) => ({
    queryKey: ["workflow-runs", "running", c.id],
    queryFn: () => api.get<WorkflowRun[]>(
      `/companies/${c.id}/workflow-runs?status=running&limit=5`
    ),
    refetchInterval: 10_000,
    staleTime: 5_000,
  })),
});

// Conversations — top 8 active
const convsQuery = useQuery({
  queryKey: ["ecc-conversations", "overview"],
  queryFn: () => api.get<EccConversation[]>("/ecc/conversations?limit=8"),
  refetchInterval: 15_000,
});
```

**Layout wrapper** (replaces current `<div className="space-y-8 max-w-4xl">`):
```tsx
<div className="flex gap-0 h-full">
  <div className="flex-[3] pr-6 space-y-6 overflow-auto">
    {/* Companies + Needs Attention */}
  </div>
  <div className="flex-[2] border-l border-border pl-6 overflow-auto">
    {/* Conversations panel */}
  </div>
</div>
```

**Enhanced `CompanyCard`** — extends current card with two new rows:

```tsx
// Below the existing open/blocked counts:

{/* Topic summary row */}
{topicNames.length > 0 && (
  <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
    {topicNames.join(" · ")}
  </p>
)}

{/* Agent chips */}
{agents.length > 0 && (
  <div className="flex gap-1.5 flex-wrap mt-2">
    {agents.map((run) => (
      <span key={run.id} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-blue-500/10 border border-blue-500/20 text-blue-300">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        {run.workflowType}
      </span>
    ))}
  </div>
)}
```

`topicNames` = topics from `topicsQuery.data` filtered by `companyId`, take first 3 names.  
`agents` = running workflow runs for this company from `agentQueries[i].data ?? []`.

**Conversations right panel** — inline component (not a separate file), reuses same card design as `FounderConversations`:

```tsx
function MiniConvPanel({ conversations, navigate }: { conversations: EccConversation[]; navigate: (p: string) => void }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Live Conversations
      </h2>
      <div className="space-y-2">
        {conversations.slice(0, 8).map((conv) => (
          <ConvCard key={conv.id} conv={conv} onClick={() => navigate(`/founder/conversations/${conv.id}`)} />
        ))}
      </div>
      <button
        type="button"
        className="text-xs text-muted-foreground hover:underline w-full text-center pt-1"
        onClick={() => navigate("/founder/conversations")}
      >
        Show all conversations →
      </button>
    </div>
  );
}
```

`ConvCard` is the same card markup already in `FounderConversations.tsx` — extract it as a local function or duplicate inline (YAGNI — don't create a shared component until it's used in 3+ places).

---

## Types needed in FounderOverview.tsx

```typescript
interface EccTopic {
  id: string;
  name: string;
  companyId: string | null;
  currentState: string | null;
}

interface WorkflowRun {
  id: string;
  workflowType: string;
  overallStatus: string;
  startedAt: string;
}

interface EccConversation {
  id: string;
  topicName: string | null;
  companyName: string | null;
  companyId: string | null;
  topicState: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string;
  expiresAt: string;
  linkedIssues: { id: string; identifier: string }[];
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
}
```

---

## What Does NOT Change

- `FounderView.tsx` tabs — keep Overview, Topics, Conversations, Settings tabs as-is
- `FounderConversations.tsx` — unchanged (full conversation list still accessible via tab)
- `FounderConversationDetail.tsx` — unchanged
- DB schema — no migrations

---

## Behaviour Details

- **Polling:** agent queries refetch every 10s. Conversations refetch every 15s. Issues refetch every 30s.
- **Empty agents:** if no running runs for a company, show nothing (no "No active agents" placeholder — keep card compact).
- **Topic names:** show max 3 topic names, truncate with `line-clamp-1`.
- **Conversations panel:** shows active only (no "show all" toggle inline — that's the full tab).
- **Responsive:** on narrow screens (< lg), right panel stacks below left column (`flex-col lg:flex-row`).
