# Founder Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Founder Overview tab into a two-column dashboard — left has enhanced company cards (active topics + running agent chips) and a needs-attention table; right has a live conversation feed.

**Architecture:** Three small server changes (status filter on workflow runs, limit on active conversations, `listAllActive` limit param) plus a full rewrite of `FounderOverview.tsx` into a two-column flex layout that fetches topics, running agents, and conversations in parallel.

**Tech Stack:** Express 5, Drizzle ORM, React 19, TanStack Query (`useQueries`), Tailwind 4.

---

## File Map

| File | Change |
|------|--------|
| `server/src/routes/workflow-runs.ts` | Add `?status` filter to `/companies/:companyId/workflow-runs` |
| `server/src/services/ecc-conversations.ts` | Add `limit` param to `listAllActive` |
| `server/src/routes/ecc-topics.ts` | Pass `?limit` query param to `listAllActive` |
| `ui/src/api/workflowRuns.ts` | Add optional `status` param to `listForCompany` |
| `ui/src/pages/founder/FounderOverview.tsx` | Full rewrite — two-column layout |

---

## Task 1: Server — add `?status` filter to workflow-runs endpoint

**Files:**
- Modify: `server/src/routes/workflow-runs.ts:25-37`

- [ ] **Step 1: Replace the `type`-only where clause with a multi-condition builder**

Open `server/src/routes/workflow-runs.ts`. The current handler at line 22 builds `where` from `type` only. Replace lines 25-36 with:

```typescript
    const type = typeof req.query.type === "string" ? req.query.type : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const conditions: ReturnType<typeof eq>[] = [eq(workflowRuns.companyId, companyId)];
    if (type) conditions.push(eq(workflowRuns.workflowType, type));
    if (status) conditions.push(eq(workflowRuns.overallStatus, status));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(where)
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);
    res.json(rows);
```

The `and` import is already present at the top of the file. `overallStatus` is a column on `workflowRuns` (check `packages/db/src/schema/` if unsure — it's the `overall_status` column aliased as `overallStatus` by Drizzle).

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter server typecheck 2>&1 | grep -v "whatsapp.ts" | grep -E "error|warning" | head -20
```

Expected: no new errors (the `whatsapp.ts` error is pre-existing, ignore it).

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/workflow-runs.ts
git commit -m "feat: add status filter to company workflow-runs endpoint"
```

---

## Task 2: Server — add `limit` to `listAllActive` + wire `?limit` in route

**Files:**
- Modify: `server/src/services/ecc-conversations.ts:138-150`
- Modify: `server/src/routes/ecc-topics.ts:118-125`

- [ ] **Step 1: Update `listAllActive` to accept a limit param**

In `server/src/services/ecc-conversations.ts`, replace the `listAllActive` function (lines 138-150):

```typescript
  async function listAllActive(limit = 100): Promise<EccConversation[]> {
    const now = new Date();
    return db
      .select()
      .from(eccConversations)
      .where(
        and(
          eq(eccConversations.status, "active"),
          gt(eccConversations.expiresAt, now),
        ),
      )
      .orderBy(desc(eccConversations.lastMessageAt))
      .limit(limit) as Promise<EccConversation[]>;
  }
```

- [ ] **Step 2: Wire `?limit` in the conversations route**

In `server/src/routes/ecc-topics.ts`, replace the `GET /ecc/conversations` handler (lines 118-125):

```typescript
  router.get("/ecc/conversations", async (req, res) => {
    assertBoard(req);
    const convSvc = eccConversationsService(db);
    const showAll = req.query.all === "true";
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
    const conversations = showAll ? await convSvc.listAll(limit) : await convSvc.listAllActive(limit);
    const enriched = (await Promise.all(conversations.map(enrichConv))).filter(Boolean);
    res.json(enriched);
  });
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter server typecheck 2>&1 | grep -v "whatsapp.ts" | grep -E "error|warning" | head -20
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/ecc-conversations.ts server/src/routes/ecc-topics.ts
git commit -m "feat: add limit param to listAllActive and conversations route"
```

---

## Task 3: UI — add `status` param to `workflowRunsApi.listForCompany`

**Files:**
- Modify: `ui/src/api/workflowRuns.ts:38-45`

- [ ] **Step 1: Update `listForCompany` to accept optional `status`**

In `ui/src/api/workflowRuns.ts`, replace the `listForCompany` function (lines 38-45):

```typescript
  listForCompany: (companyId: string, type?: string, limit = 50, status?: string) => {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (status) qs.set("status", status);
    qs.set("limit", String(limit));
    return api.get<WorkflowRun[]>(
      `/companies/${encodeURIComponent(companyId)}/workflow-runs?${qs.toString()}`,
    );
  },
```

- [ ] **Step 2: Typecheck UI**

```bash
pnpm --filter ui typecheck 2>&1 | grep -E "error|warning" | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/workflowRuns.ts
git commit -m "feat: add status filter param to workflowRunsApi.listForCompany"
```

---

## Task 4: UI — rewrite `FounderOverview.tsx` as two-column dashboard

**Files:**
- Modify: `ui/src/pages/founder/FounderOverview.tsx` (full rewrite)

This is the main task. The existing file has `CompanyCard` and `FounderOverview`. We keep `CompanyCard` but extend it. We add a `ConvCard` for the right panel. We change `FounderOverview` to a two-column layout.

- [ ] **Step 1: Replace the entire file with the new implementation**

```typescript
// v3: founder overview — two-column dashboard (companies + agents left, conversations right).
import { useNavigate } from "@/lib/router";
import { useQuery, useQueries } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, XCircle, Clock, Activity, MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useCompany } from "../../context/CompanyContext";
import { issuesApi } from "../../api/issues";
import { workflowRunsApi, type WorkflowRun } from "../../api/workflowRuns";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { api } from "../../api/client";
import type { Company } from "@paperclipai/shared";
import type { Issue } from "@paperclipai/shared";

// ── Types ────────────────────────────────────────────────────────────────────

interface EccTopic {
  id: string;
  name: string;
  companyId: string | null;
  currentState: string | null;
  status: string;
}

interface LinkedIssue {
  id: string;
  identifier: string;
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
  linkedIssues: LinkedIssue[];
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

// ── Badge ────────────────────────────────────────────────────────────────────

function Badge({ label, tone = "default" }: { label: string; tone?: "default" | "blue" | "green" | "amber" | "violet" }) {
  const colors: Record<string, string> = {
    default: "bg-muted text-muted-foreground",
    blue: "bg-blue-500/10 text-blue-700",
    green: "bg-emerald-500/10 text-emerald-700",
    amber: "bg-amber-500/10 text-amber-700",
    violet: "bg-violet-500/10 text-violet-700",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[tone]}`}>
      {label}
    </span>
  );
}

// ── ConvCard (right panel) ────────────────────────────────────────────────────

const CONV_STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  active: CheckCircle2,
  extended: CheckCircle2,
  expired: XCircle,
  running: Activity,
};
const CONV_STATUS_COLOR: Record<string, string> = {
  active: "text-emerald-600",
  extended: "text-emerald-600",
  expired: "text-muted-foreground",
  running: "text-blue-600",
};

function ConvCard({ conv, onClick }: { conv: EccConversation; onClick: () => void }) {
  const isExpired = conv.status === "expired" || daysUntil(conv.expiresAt) <= 0;
  const expiring = !isExpired && conv.status === "active" && daysUntil(conv.expiresAt) <= 3;
  const statusKey = isExpired ? "expired" : conv.status;
  const Icon = CONV_STATUS_ICON[statusKey] ?? Clock;
  const iconColor = CONV_STATUS_COLOR[statusKey] ?? "text-muted-foreground";

  return (
    <Card
      className={`p-3 cursor-pointer hover:bg-accent/30 transition-colors ${isExpired ? "opacity-55" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${iconColor}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {conv.topicName && <Badge label={conv.topicName} tone="violet" />}
            {conv.companyName && <Badge label={conv.companyName} tone="blue" />}
            {conv.linkedIssues.map((i) => (
              <Badge key={i.id} label={i.identifier} tone="green" />
            ))}
            {expiring && <Badge label={`exp ${daysUntil(conv.expiresAt)}d`} tone="amber" />}
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 ml-auto">
              <MessageSquare className="h-2.5 w-2.5" />{conv.messageCount}
            </span>
          </div>
          {conv.lastUserMessage ? (
            <p className="text-sm mt-0.5 line-clamp-1 text-foreground">{conv.lastUserMessage}</p>
          ) : (
            <p className="text-sm mt-0.5 text-muted-foreground italic">No messages yet</p>
          )}
          {conv.lastAssistantMessage && (
            <p className="text-xs mt-0.5 text-muted-foreground line-clamp-1">↳ {conv.lastAssistantMessage}</p>
          )}
        </div>
        <div className="text-xs text-muted-foreground shrink-0">{relativeTime(conv.lastMessageAt)}</div>
      </div>
    </Card>
  );
}

// ── CompanyCard (left panel) ──────────────────────────────────────────────────

function CompanyCard({
  company,
  issues,
  isLoading,
  isPersonal,
  topics,
  runningAgents,
}: {
  company: Company;
  issues: Issue[] | undefined;
  isLoading: boolean;
  isPersonal: boolean;
  topics: EccTopic[];
  runningAgents: WorkflowRun[];
}) {
  const navigate = useNavigate();
  const openIssues = issues?.filter((i) => ["backlog", "todo", "in_progress"].includes(i.status)) ?? [];
  const blockedIssues = issues?.filter((i) => i.status === "blocked") ?? [];
  const topicNames = topics.filter((t) => t.companyId === company.id && t.status === "active").map((t) => t.name).slice(0, 3);

  return (
    <button
      onClick={() => navigate(`/${company.issuePrefix}/dashboard`)}
      className="text-left rounded-lg border border-border bg-card p-4 hover:border-foreground/20 transition-colors w-full"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 mb-2">
        {company.brandColor && (
          <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: company.brandColor }} />
        )}
        <span className="font-medium text-sm">{company.name}</span>
        {isPersonal && (
          <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">Personal</span>
        )}
      </div>

      {/* Issue counts */}
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <div className="flex gap-4 text-xs text-muted-foreground mb-2">
          <span>{openIssues.length} open</span>
          {blockedIssues.length > 0 && (
            <span className="text-red-500 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {blockedIssues.length} blocked
            </span>
          )}
        </div>
      )}

      {/* Active topics */}
      {topicNames.length > 0 && (
        <p className="text-[11px] text-muted-foreground line-clamp-1 mb-2">
          {topicNames.join(" · ")}
        </p>
      )}

      {/* Running agent chips */}
      {runningAgents.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {runningAgents.map((run) => (
            <span
              key={run.id}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-blue-500/10 border border-blue-500/20 text-blue-400"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              {run.workflowType.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// ── FounderOverview ───────────────────────────────────────────────────────────

export function FounderOverview() {
  const navigate = useNavigate();
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");
  const personalCompanyId = localStorage.getItem("founder.personalCompanyId") ?? "";

  // Issues per company
  const issueQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.issues.list(company.id),
      queryFn: () => issuesApi.list(company.id),
      staleTime: 30_000,
    })),
  });

  // Active ECC topics (for all companies)
  const topicsQuery = useQuery({
    queryKey: ["ecc-topics", "active"],
    queryFn: () => api.get<EccTopic[]>("/ecc/topics?status=active"),
    staleTime: 30_000,
  });

  // Running workflow agents per company
  const agentQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: ["workflow-runs", "running", company.id],
      queryFn: () => workflowRunsApi.listForCompany(company.id, undefined, 5, "running"),
      refetchInterval: 10_000,
      staleTime: 5_000,
    })),
  });

  // Live conversations (top 8 active)
  const convsQuery = useQuery({
    queryKey: ["ecc-conversations", "overview"],
    queryFn: () => api.get<EccConversation[]>("/ecc/conversations?limit=8"),
    refetchInterval: 15_000,
  });

  const allIssues = activeCompanies.flatMap((_, i) => issueQueries[i]?.data ?? []);
  const blockedIssues = allIssues.filter((i) => i.status === "blocked");
  const needsAttention = [...blockedIssues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);
  const companyById = new Map(activeCompanies.map((c) => [c.id, c]));
  const topics = topicsQuery.data ?? [];
  const conversations = convsQuery.data ?? [];

  return (
    <div className="flex flex-col lg:flex-row gap-0 h-full min-h-0">
      {/* LEFT: Companies + Needs Attention */}
      <div className="flex-[3] pr-6 space-y-8 overflow-auto">
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Companies
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {activeCompanies.map((company, i) => (
              <CompanyCard
                key={company.id}
                company={company}
                issues={issueQueries[i]?.data}
                isLoading={issueQueries[i]?.isLoading ?? false}
                isPersonal={company.id === personalCompanyId}
                topics={topics}
                runningAgents={agentQueries[i]?.data ?? []}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Needs Attention
          </h2>
          {needsAttention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing blocked across your companies.</p>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs">
                  <tr>
                    <th className="text-left px-4 py-2">Company</th>
                    <th className="text-left px-4 py-2">Issue</th>
                    <th className="text-left px-4 py-2">Title</th>
                    <th className="text-left px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {needsAttention.map((issue) => {
                    const company = companyById.get(issue.companyId);
                    return (
                      <tr
                        key={issue.id}
                        className={cn("border-t border-border hover:bg-muted/30 cursor-pointer")}
                        onClick={() => navigate(`/${company?.issuePrefix ?? ""}/issues/${issue.id}`)}
                      >
                        <td className="px-4 py-2 text-muted-foreground">{company?.name ?? "—"}</td>
                        <td className="px-4 py-2 font-mono text-xs">{issue.identifier}</td>
                        <td className="px-4 py-2">{issue.title}</td>
                        <td className="px-4 py-2">
                          <span className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-1.5 py-0.5 rounded">
                            {issue.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* RIGHT: Conversations */}
      <div className="flex-[2] border-l border-border pl-6 overflow-auto space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Live Conversations
          </h2>
        </div>

        {convsQuery.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}

        {!convsQuery.isLoading && conversations.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
            No active conversations.
          </div>
        )}

        {conversations.map((conv) => (
          <ConvCard
            key={conv.id}
            conv={conv}
            onClick={() => navigate(`/founder/conversations/${conv.id}`)}
          />
        ))}

        {conversations.length > 0 && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline underline-offset-2 w-full text-center pt-1"
            onClick={() => navigate("/founder/conversations")}
          >
            Show all conversations →
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck UI**

```bash
pnpm --filter ui typecheck 2>&1 | grep -E "error|warning" | head -20
```

Expected: no errors. Common pitfall: `workflowRunsApi.listForCompany` signature must match — `(companyId, type?, limit?, status?)`. The `type` param is `string | undefined` so pass `undefined` explicitly when omitting it.

- [ ] **Step 3: Check `FounderView.tsx` scroll behaviour**

The `FounderView.tsx` wrapper is:
```tsx
<div className="flex-1 overflow-auto p-6">
  <Outlet />
</div>
```

The new `FounderOverview` uses `h-full` and `overflow-auto` on each column. This works only if the parent has a defined height. `flex-1` on a flex child gives it a height, so `h-full` inside resolves correctly. Verify visually in browser — both columns should scroll independently.

If columns don't scroll independently, the fix is to change the wrapper in `FounderView.tsx` from `overflow-auto` to `overflow-hidden` (the columns handle their own scroll):

```tsx
<div className="flex-1 overflow-hidden p-6">
  <Outlet />
</div>
```

Only apply this fix if the independent scroll is broken.

- [ ] **Step 4: Verify in browser**

Start dev server:
```bash
pnpm dev
```

Navigate to `http://localhost:3100` → Founder → Overview tab.

Check:
- [ ] Company cards show topic names (e.g. "Tender pipeline · AssetX development")
- [ ] Running agent chips appear (blue pill with green dot) when an ECC orchestrator is active — send a Telegram message and reload within 60s to see it
- [ ] Right panel shows conversations with topic/company badges
- [ ] "Show all conversations →" navigates to `/founder/conversations`
- [ ] Clicking a conversation card navigates to `/founder/conversations/:id`
- [ ] Clicking a company card navigates to that company dashboard
- [ ] Blocked issues appear in Needs Attention table

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/founder/FounderOverview.tsx
git commit -m "feat: founder overview two-column layout — company agents + live conversations panel"
```

---

## Task 5: Full verification

- [ ] **Step 1: Typecheck all**

```bash
pnpm -r typecheck 2>&1 | grep -v "whatsapp.ts" | grep "error" | head -20
```

Expected: no new errors beyond the pre-existing `whatsapp.ts` one.

- [ ] **Step 2: Run tests**

```bash
pnpm test:run 2>&1 | tail -20
```

Expected: all tests pass (no tests touch these files directly, but confirm no regressions).

- [ ] **Step 3: Build**

```bash
pnpm build 2>&1 | tail -20
```

Expected: clean build.

- [ ] **Step 4: Final commit if anything left unstaged**

```bash
git status
```

If clean — done. If not:

```bash
git add -p
git commit -m "chore: founder overview redesign cleanup"
```
