# Agent Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an instance-level agent template catalog with built-in and custom templates, one-click deploy to any company, EA MCP tools for programmatic deployment, and a UI page with org chart preview.

**Architecture:** New `agent_templates` DB table (instance-level, no companyId) stores template metadata + agent definitions as JSONB. A service handles seeding built-ins from `onboarding-assets/templates/`, deploying by creating real agents + instruction files, and snapshotting existing agents as custom templates. EA gets two MCP tools. UI is a two-pane catalog page at `/instance/agent-templates` plus a "Save as Template" overflow menu item on AgentDetail.

**Tech Stack:** Drizzle ORM, Express 5, vitest + embedded-postgres tests, React 19, TanStack Query, Tailwind 4. Follows patterns from `ea-agents.ts` (seeding) and `action-policies.ts` (test structure).

---

## File Map

**New files:**
- `packages/db/src/schema/agent_templates.ts` — Drizzle table definition
- `packages/shared/src/types/agent-template.ts` — TypeScript interfaces
- `server/src/onboarding-assets/templates/dev-team/template.json` — dev team definition
- `server/src/onboarding-assets/templates/dev-team/tech-lead/AGENTS.md`
- `server/src/onboarding-assets/templates/dev-team/fullstack-dev/AGENTS.md`
- `server/src/onboarding-assets/templates/dev-team/qa-agent/AGENTS.md`
- `server/src/services/agent-templates.ts` — seed, deploy, saveAsTemplate
- `server/src/routes/agent-templates.ts` — REST endpoints
- `server/src/__tests__/agent-templates.test.ts` — service tests
- `ui/src/api/agentTemplates.ts` — API client
- `ui/src/pages/AgentTemplates.tsx` — catalog + deploy UI page

**Modified files:**
- `packages/db/src/schema/index.ts` — export agentTemplates
- `packages/shared/src/types/index.ts` — export new types
- `packages/shared/src/index.ts` — re-export new types
- `server/src/app.ts` — import + mount agentTemplateRoutes
- `server/src/index.ts` — call seedAgentTemplates on startup
- `server/src/routes/index.ts` — export agentTemplateRoutes
- `server/src/routes/mcp-tool-server.ts` — add list_agent_templates + deploy_agent_template tools
- `server/src/onboarding-assets/ea-operator/AGENTS.md` — add template routing section
- `server/src/services/ea-agents.ts` — bump PROMPT_VERSION to 8
- `ui/src/App.tsx` — add `/instance/agent-templates` route
- `ui/src/components/InstanceSidebar.tsx` — add nav item
- `ui/src/pages/AgentDetail.tsx` — add Save as Template to overflow menu

---

## Task 1: DB Schema

**Files:**
- Create: `packages/db/src/schema/agent_templates.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the schema**

Create `packages/db/src/schema/agent_templates.ts`:

```ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    category: text("category").notNull().default("custom"),
    sourceType: text("source_type").notNull().default("custom"),
    agentDefinitions: jsonb("agent_definitions")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    teamStructure: jsonb("team_structure")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUniqueIdx: uniqueIndex("agent_templates_slug_idx").on(table.slug),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, add:
```ts
export { agentTemplates } from "./agent_templates.js";
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

Expected: new file appears in `packages/db/src/migrations/` with `CREATE TABLE agent_templates ...` and `CREATE UNIQUE INDEX agent_templates_slug_idx ...`.

- [ ] **Step 4: Verify typecheck passes**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/agent_templates.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add agent_templates table"
```

---

## Task 2: Shared Types

**Files:**
- Create: `packages/shared/src/types/agent-template.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the types**

Create `packages/shared/src/types/agent-template.ts`:

```ts
export interface AgentTemplateDefinition {
  tempId: string;
  name: string;
  role: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  capabilities?: string | null;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  instructionsBundleDir?: string | null;
  instructionsContent?: string | null;
  skills: string[];
}

export interface TeamStructureEntry {
  tempId: string;
  reportsTo: string | null;
}

export interface AgentTemplate {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  sourceType: "built_in" | "custom";
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplateSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  sourceType: "built_in" | "custom";
  agentCount: number;
  metadata: Record<string, unknown> | null;
}

export interface DeployTemplateResult {
  agentIds: string[];
  agentNames: string[];
}

export interface CreateCustomTemplateInput {
  name: string;
  slug: string;
  description?: string;
  category: string;
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  agentDefinitions?: AgentTemplateDefinition[];
  teamStructure?: TeamStructureEntry[];
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Export from types index**

In `packages/shared/src/types/index.ts`, add:
```ts
export type {
  AgentTemplate,
  AgentTemplateSummary,
  AgentTemplateDefinition,
  TeamStructureEntry,
  DeployTemplateResult,
  CreateCustomTemplateInput,
  UpdateTemplateInput,
} from "./agent-template.js";
```

- [ ] **Step 3: Re-export from shared index**

In `packages/shared/src/index.ts`, find the `export type { ... } from "./types/index.js";` block and add the new types inside it:
```ts
AgentTemplate,
AgentTemplateSummary,
AgentTemplateDefinition,
TeamStructureEntry,
DeployTemplateResult,
CreateCustomTemplateInput,
UpdateTemplateInput,
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/agent-template.ts packages/shared/src/types/index.ts packages/shared/src/index.ts
git commit -m "feat(shared): add AgentTemplate types"
```

---

## Task 3: Built-in Template Files (Dev Team)

**Files:**
- Create: `server/src/onboarding-assets/templates/dev-team/template.json`
- Create: `server/src/onboarding-assets/templates/dev-team/tech-lead/AGENTS.md`
- Create: `server/src/onboarding-assets/templates/dev-team/fullstack-dev/AGENTS.md`
- Create: `server/src/onboarding-assets/templates/dev-team/qa-agent/AGENTS.md`

- [ ] **Step 1: Create template.json**

Create `server/src/onboarding-assets/templates/dev-team/template.json`:

```json
{
  "name": "Dev Team",
  "slug": "dev-team",
  "description": "Software development team with Tech Lead, Full-stack Developer, and QA Agent. Handles code implementation, PR coordination, testing, and project lifecycle management.",
  "category": "dev",
  "sourceType": "built_in",
  "metadata": { "icon": "Code2", "version": 1 },
  "agentDefinitions": [
    {
      "tempId": "tech-lead",
      "name": "Tech Lead",
      "role": "orchestrator",
      "adapterType": "ea",
      "adapterConfig": {},
      "capabilities": "Task breakdown, PR review coordination, sprint planning, code architecture decisions. Routes development tasks to Full-stack Dev. Routes QA and testing tasks to QA Agent.",
      "permissions": {},
      "budgetMonthlyCents": 0,
      "instructionsBundleDir": "tech-lead",
      "skills": []
    },
    {
      "tempId": "fullstack-dev",
      "name": "Full-stack Dev",
      "role": "worker",
      "adapterType": "ea",
      "adapterConfig": {},
      "capabilities": "Code implementation, feature development, follows project lifecycle stages, updates issues on completion, escalates blockers to Tech Lead.",
      "permissions": {},
      "budgetMonthlyCents": 0,
      "instructionsBundleDir": "fullstack-dev",
      "skills": []
    },
    {
      "tempId": "qa-agent",
      "name": "QA Agent",
      "role": "worker",
      "adapterType": "ea",
      "adapterConfig": {},
      "capabilities": "Test plan creation, bug reporting, UAT sign-off, blocks deployment if open P0 issues exist, reports test results to Tech Lead.",
      "permissions": {},
      "budgetMonthlyCents": 0,
      "instructionsBundleDir": "qa-agent",
      "skills": []
    }
  ],
  "teamStructure": [
    { "tempId": "tech-lead", "reportsTo": null },
    { "tempId": "fullstack-dev", "reportsTo": "tech-lead" },
    { "tempId": "qa-agent", "reportsTo": "tech-lead" }
  ]
}
```

- [ ] **Step 2: Create Tech Lead AGENTS.md**

Create `server/src/onboarding-assets/templates/dev-team/tech-lead/AGENTS.md`:

```markdown
# Tech Lead

You are the Tech Lead — engineering orchestrator for this company's software projects.

## Your role
You break down product requirements into technical tasks, coordinate delivery across the dev team, review PRs, and ensure projects advance through their lifecycle stages.

## CRITICAL: your text output goes nowhere
Only tool calls reach the operator. Use notify_operator to communicate.

## Operating model
1. Receive task or issue → assess scope and complexity
2. If task is implementation work → assign to Full-stack Dev via update_issue(assigneeAgentId=<fullstack-dev-id>)
3. If task is testing/QA work → assign to QA Agent via update_issue(assigneeAgentId=<qa-agent-id>)
4. If task requires operator decision → create_plan or notify_operator
5. Monitor project stage goals — when all issues under an active stage are done, advance to next stage

## Routing rules
- Feature implementation, bug fixes, refactors → Full-stack Dev
- Test plans, QA, UAT, regression → QA Agent
- Architecture decisions, scope changes, timeline → notify_operator

## Issue management
- Always link issues to a project via update_issue(projectId=...)
- Set issue priority based on impact: P0 (blocking), P1 (high), P2 (normal), P3 (low)
- Use list_issues(unrouted=true) to find orphaned issues and route them

## Project lifecycle
Follow the Software/Product Build lifecycle:
Discovery → Design → Development → Testing → Deployment → Post-launch

When a stage is complete (all issues done/cancelled):
- Mark stage goal achieved
- Activate next stage goal
- Create default issues for new stage
- notify_operator with summary

## Response style
Operational only. No pleasantries. Signal, not noise.
```

- [ ] **Step 3: Create Full-stack Dev AGENTS.md**

Create `server/src/onboarding-assets/templates/dev-team/fullstack-dev/AGENTS.md`:

```markdown
# Full-stack Developer

You are the Full-stack Developer — code implementation specialist for this company's projects.

## Your role
You implement features, fix bugs, and complete development tasks assigned to you. You follow the project lifecycle and keep issues updated as you work.

## CRITICAL: your text output goes nowhere
Only tool calls reach the operator or Tech Lead. Use notify_operator for escalations.

## Operating model
1. Receive assigned issue → get_issue_context(issueId) for full context
2. Implement the work
3. Update issue status: in_progress when starting, done when complete
4. If blocked → set_issue_blocked(issueId, reason) and notify Tech Lead via add_issue_comment

## Issue discipline
- Always update issue status when starting and finishing work
- Add a comment with a brief summary of what was done when closing an issue
- If scope changes during implementation → add_issue_comment and notify Tech Lead

## Blockers
Escalate to Tech Lead (not the operator directly) unless it is urgent or requires operator approval.

## Response style
Operational only. Signal, not noise.
```

- [ ] **Step 4: Create QA Agent AGENTS.md**

Create `server/src/onboarding-assets/templates/dev-team/qa-agent/AGENTS.md`:

```markdown
# QA Agent

You are the QA Agent — quality assurance and testing specialist for this company's projects.

## Your role
You create test plans, execute QA, report bugs, and sign off on UAT. You are the gating authority for deployment: you block releases if P0 issues are open.

## CRITICAL: your text output goes nowhere
Only tool calls reach the operator. Use notify_operator to communicate.

## Operating model
1. Receive QA task or testing issue → get_issue_context(issueId) for context
2. Create test plan issues if not already present
3. Execute tests → report bugs as new issues with priority P0/P1/P2
4. When all P0/P1 bugs are resolved → mark UAT issue done and notify Tech Lead
5. If P0 bugs block deployment → set_issue_blocked(deploymentIssueId, reason)

## Bug reporting
When creating a bug issue:
- Title: [BUG] clear description
- Priority: P0 (production-blocking), P1 (major), P2 (minor)
- Assign to Full-stack Dev via update_issue(assigneeAgentId=<fullstack-dev-id>)
- Link to the project

## Deployment gate
Before any deployment issue can be marked done:
1. list_issues(projectId=..., status=open) — check for open P0/P1 bugs
2. If any exist → block the deployment issue and notify_operator
3. If none → approve and add sign-off comment

## Response style
Operational only. No pleasantries. Signal, not noise.
```

- [ ] **Step 5: Commit**

```bash
git add server/src/onboarding-assets/templates/
git commit -m "feat(templates): add dev-team built-in template files"
```

---

## Task 4: Agent Templates Service

**Files:**
- Create: `server/src/services/agent-templates.ts`

- [ ] **Step 1: Write the failing tests first**

Create `server/src/__tests__/agent-templates.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentTemplates, companies, agents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentTemplatesService } from "../services/agent-templates.ts";
import { eq } from "drizzle-orm";
import type { AgentTemplateDefinition } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agentTemplatesService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-templates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(agentTemplates);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const svc = () => agentTemplatesService(db as any);

  it("seedAgentTemplates creates the dev-team built-in row", async () => {
    await svc().seedAgentTemplates();
    const rows = await db.select().from(agentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("dev-team");
    expect(rows[0].sourceType).toBe("built_in");
    const defs = rows[0].agentDefinitions as Record<string, unknown>[];
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.tempId)).toEqual(["tech-lead", "fullstack-dev", "qa-agent"]);
  }, 20_000);

  it("seedAgentTemplates is idempotent", async () => {
    await svc().seedAgentTemplates();
    await svc().seedAgentTemplates();
    const rows = await db.select().from(agentTemplates);
    expect(rows).toHaveLength(1);
  }, 20_000);

  it("seedAgentTemplates skips update when metadata.customized is true", async () => {
    await svc().seedAgentTemplates();
    await db
      .update(agentTemplates)
      .set({ metadata: { customized: true, version: 1 }, name: "My Custom Dev Team" });
    await svc().seedAgentTemplates();
    const rows = await db.select().from(agentTemplates);
    expect(rows[0].name).toBe("My Custom Dev Team");
  }, 20_000);

  it("deployTemplate creates agents with correct names and companyId", async () => {
    await svc().seedAgentTemplates();
    const [template] = await db.select().from(agentTemplates).where(eq(agentTemplates.slug, "dev-team"));
    const [co] = await db.insert(companies).values({ name: "Test Co", issuePrefix: "TC" }).returning();
    const result = await svc().deployTemplate(template.id, co.id);
    expect(result.agentNames).toEqual(["Tech Lead", "Full-stack Dev", "QA Agent"]);
    expect(result.agentIds).toHaveLength(3);
    const createdAgents = await db.select().from(agents).where(eq(agents.companyId, co.id));
    expect(createdAgents).toHaveLength(3);
  }, 20_000);

  it("deployTemplate wires reportsTo relationships correctly", async () => {
    await svc().seedAgentTemplates();
    const [template] = await db.select().from(agentTemplates).where(eq(agentTemplates.slug, "dev-team"));
    const [co] = await db.insert(companies).values({ name: "Test Co 2", issuePrefix: "TC2" }).returning();
    const result = await svc().deployTemplate(template.id, co.id);
    const createdAgents = await db.select().from(agents).where(eq(agents.companyId, co.id));
    const lead = createdAgents.find((a) => a.name === "Tech Lead");
    const dev = createdAgents.find((a) => a.name === "Full-stack Dev");
    const qa = createdAgents.find((a) => a.name === "QA Agent");
    expect(lead?.reportsTo).toBeNull();
    expect(dev?.reportsTo).toBe(lead?.id);
    expect(qa?.reportsTo).toBe(lead?.id);
    expect(result.agentIds).toContain(lead?.id);
  }, 20_000);

  it("saveAsTemplate creates a custom template from an agent", async () => {
    const [co] = await db.insert(companies).values({ name: "Test Co 3", issuePrefix: "TC3" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: co.id,
      name: "My Agent",
      role: "worker",
      adapterType: "ea",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      status: "idle",
    }).returning();
    const template = await svc().saveAsTemplate(agent.id, {
      subtree: false,
      name: "My Agent Template",
      slug: "my-agent-template",
      description: "A test template",
      category: "custom",
    });
    expect(template.slug).toBe("my-agent-template");
    expect(template.sourceType).toBe("custom");
    const defs = template.agentDefinitions as AgentTemplateDefinition[];
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("My Agent");
  }, 20_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run server/src/__tests__/agent-templates.test.ts
```

Expected: FAIL with "Cannot find module '../services/agent-templates.ts'" or similar.

- [ ] **Step 3: Implement the service**

Create `server/src/services/agent-templates.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and } from "drizzle-orm";
import { agentTemplates, agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type {
  AgentTemplateDefinition,
  TeamStructureEntry,
  DeployTemplateResult,
  CreateCustomTemplateInput,
} from "@paperclipai/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveTemplatesRoot(): string {
  return path.resolve(__dirname, "../onboarding-assets/templates");
}

function resolveTemplateInstructionsRoot(agentId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "ea", agentId, "instructions");
}

async function seedInstructionFiles(agentId: string, bundleDir: string, templateSlug: string): Promise<void> {
  const src = path.join(resolveTemplatesRoot(), templateSlug, bundleDir);
  const dest = resolveTemplateInstructionsRoot(agentId);
  await fs.mkdir(dest, { recursive: true });
  let entries: string[] = [];
  try {
    entries = await fs.readdir(src);
  } catch {
    return;
  }
  for (const entry of entries) {
    const content = await fs.readFile(path.join(src, entry), "utf-8");
    await fs.writeFile(path.join(dest, entry), content, "utf-8");
  }
}

async function writeInlineInstructions(agentId: string, content: string): Promise<void> {
  const dest = resolveTemplateInstructionsRoot(agentId);
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, "AGENTS.md"), content, "utf-8");
}

function buildBundleAdapterConfig(agentId: string): Record<string, unknown> {
  const root = resolveTemplateInstructionsRoot(agentId);
  return {
    instructionsBundleMode: "external",
    instructionsRootPath: root,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: path.join(root, "AGENTS.md"),
  };
}

export function agentTemplatesService(db: Db) {
  async function seedAgentTemplates(): Promise<void> {
    const templatesRoot = resolveTemplatesRoot();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(templatesRoot);
    } catch {
      return;
    }

    for (const dirName of entries) {
      const jsonPath = path.join(templatesRoot, dirName, "template.json");
      let raw: string;
      try {
        raw = await fs.readFile(jsonPath, "utf-8");
      } catch {
        continue;
      }
      const def = JSON.parse(raw) as {
        name: string;
        slug: string;
        description?: string;
        category: string;
        sourceType: string;
        metadata?: Record<string, unknown>;
        agentDefinitions: Record<string, unknown>[];
        teamStructure: Record<string, unknown>[];
      };

      const [existing] = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.slug, def.slug))
        .limit(1);

      if (!existing) {
        await db.insert(agentTemplates).values({
          name: def.name,
          slug: def.slug,
          description: def.description ?? null,
          category: def.category,
          sourceType: def.sourceType as "built_in" | "custom",
          agentDefinitions: def.agentDefinitions,
          teamStructure: def.teamStructure,
          metadata: def.metadata ?? null,
        });
      } else {
        const meta = (existing.metadata ?? {}) as Record<string, unknown>;
        if (meta.customized === true) continue;
        const existingVersion = typeof meta.version === "number" ? meta.version : 0;
        const newVersion = typeof def.metadata?.version === "number" ? def.metadata.version : 0;
        if (newVersion > existingVersion) {
          await db
            .update(agentTemplates)
            .set({
              name: def.name,
              description: def.description ?? null,
              agentDefinitions: def.agentDefinitions,
              teamStructure: def.teamStructure,
              metadata: def.metadata ?? null,
              updatedAt: new Date(),
            })
            .where(eq(agentTemplates.slug, def.slug));
        }
      }
    }
  }

  async function deployTemplate(templateId: string, companyId: string): Promise<DeployTemplateResult> {
    const [template] = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.id, templateId))
      .limit(1);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const defs = template.agentDefinitions as AgentTemplateDefinition[];
    const structure = template.teamStructure as TeamStructureEntry[];

    const tempIdToRealId = new Map<string, string>();
    const agentNames: string[] = [];

    for (const def of defs) {
      const [created] = await db
        .insert(agents)
        .values({
          companyId,
          name: def.name,
          role: def.role,
          adapterType: def.adapterType,
          adapterConfig: def.adapterConfig ?? {},
          runtimeConfig: {},
          capabilities: def.capabilities ?? null,
          permissions: def.permissions ?? {},
          budgetMonthlyCents: def.budgetMonthlyCents ?? 0,
          spentMonthlyCents: 0,
          status: "idle",
        })
        .returning({ id: agents.id });

      if (!created) continue;

      if (def.instructionsBundleDir) {
        await seedInstructionFiles(created.id, def.instructionsBundleDir, template.slug);
        const adapterConfig = buildBundleAdapterConfig(created.id);
        await db
          .update(agents)
          .set({ adapterConfig, updatedAt: new Date() })
          .where(eq(agents.id, created.id));
      } else if (def.instructionsContent) {
        await writeInlineInstructions(created.id, def.instructionsContent);
        const adapterConfig = buildBundleAdapterConfig(created.id);
        await db
          .update(agents)
          .set({ adapterConfig, updatedAt: new Date() })
          .where(eq(agents.id, created.id));
      }

      tempIdToRealId.set(def.tempId, created.id);
      agentNames.push(def.name);
    }

    for (const entry of structure) {
      if (!entry.reportsTo) continue;
      const agentId = tempIdToRealId.get(entry.tempId);
      const reportsToId = tempIdToRealId.get(entry.reportsTo);
      if (agentId && reportsToId) {
        await db
          .update(agents)
          .set({ reportsTo: reportsToId, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
      }
    }

    return { agentIds: Array.from(tempIdToRealId.values()), agentNames };
  }

  async function saveAsTemplate(
    agentId: string,
    opts: {
      subtree: boolean;
      name: string;
      slug: string;
      description?: string;
      category: string;
    },
  ) {
    async function collectAgents(rootId: string): Promise<typeof agents.$inferSelect[]> {
      const [root] = await db.select().from(agents).where(eq(agents.id, rootId)).limit(1);
      if (!root) return [];
      if (!opts.subtree) return [root];
      const reports = await db.select().from(agents).where(eq(agents.reportsTo, rootId));
      const nested = await Promise.all(reports.map((r) => collectAgents(r.id)));
      return [root, ...nested.flat()];
    }

    const collected = await collectAgents(agentId);

    const agentDefinitions: AgentTemplateDefinition[] = collected.map((a) => ({
      tempId: a.id,
      name: a.name,
      role: a.role,
      adapterType: a.adapterType,
      adapterConfig: (a.adapterConfig ?? {}) as Record<string, unknown>,
      capabilities: a.capabilities ?? null,
      permissions: (a.permissions ?? {}) as Record<string, unknown>,
      budgetMonthlyCents: a.budgetMonthlyCents,
      instructionsBundleDir: null,
      instructionsContent: null,
      skills: [],
    }));

    const teamStructure: TeamStructureEntry[] = collected.map((a) => ({
      tempId: a.id,
      reportsTo: a.reportsTo ?? null,
    }));

    const [created] = await db
      .insert(agentTemplates)
      .values({
        name: opts.name,
        slug: opts.slug,
        description: opts.description ?? null,
        category: opts.category,
        sourceType: "custom",
        agentDefinitions: agentDefinitions as unknown as Record<string, unknown>[],
        teamStructure: teamStructure as unknown as Record<string, unknown>[],
        metadata: null,
      })
      .returning();

    return created;
  }

  async function listTemplates() {
    const rows = await db.select().from(agentTemplates);
    return rows.map((r) => ({
      ...r,
      agentCount: (r.agentDefinitions as unknown[]).length,
    }));
  }

  async function getTemplate(id: string) {
    const [row] = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .limit(1);
    return row ?? null;
  }

  async function updateTemplate(id: string, input: {
    name?: string;
    description?: string;
    category?: string;
    agentDefinitions?: Record<string, unknown>[];
    teamStructure?: Record<string, unknown>[];
    metadata?: Record<string, unknown>;
  }) {
    const [existing] = await db.select({ metadata: agentTemplates.metadata, sourceType: agentTemplates.sourceType })
      .from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1);
    if (!existing) return null;

    const updatedMeta = existing.sourceType === "built_in"
      ? { ...(existing.metadata ?? {}), ...(input.metadata ?? {}), customized: true }
      : { ...(existing.metadata ?? {}), ...(input.metadata ?? {}) };

    const patch: Record<string, unknown> = { updatedAt: new Date(), metadata: updatedMeta };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.category !== undefined) patch.category = input.category;
    if (input.agentDefinitions !== undefined) patch.agentDefinitions = input.agentDefinitions;
    if (input.teamStructure !== undefined) patch.teamStructure = input.teamStructure;

    const [updated] = await db.update(agentTemplates).set(patch as any).where(eq(agentTemplates.id, id)).returning();
    return updated ?? null;
  }

  async function deleteTemplate(id: string): Promise<boolean> {
    const [row] = await db.select({ sourceType: agentTemplates.sourceType })
      .from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1);
    if (!row) return false;
    if (row.sourceType === "built_in") throw new Error("Built-in templates cannot be deleted");
    await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
    return true;
  }

  return { seedAgentTemplates, deployTemplate, saveAsTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run server/src/__tests__/agent-templates.test.ts
```

Expected: all 6 tests PASS. (The `saveAsTemplate` test uses a loose type — if TypeScript complains about `AgentTemplateDefinition` not being imported, add the import to the test file.)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/agent-templates.ts server/src/__tests__/agent-templates.test.ts
git commit -m "feat(services): add agentTemplatesService with seed, deploy, saveAsTemplate"
```

---

## Task 5: API Routes

**Files:**
- Create: `server/src/routes/agent-templates.ts`
- Modify: `server/src/routes/index.ts`

- [ ] **Step 1: Create the route handler**

Create `server/src/routes/agent-templates.ts`:

```ts
import { Router } from "express";
import { eq } from "drizzle-orm";
import { agentTemplates } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { agentTemplatesService } from "../services/agent-templates.js";
import { assertBoard, assertInstanceAdmin } from "./authz.js";
import { notFound, forbidden } from "../errors.js";

export function agentTemplateRoutes(db: Db): Router {
  const router = Router();
  const svc = agentTemplatesService(db);

  router.get("/agent-templates", async (req, res) => {
    assertBoard(req);
    const templates = await svc.listTemplates();
    res.json(templates);
  });

  router.get("/agent-templates/:id", async (req, res) => {
    assertBoard(req);
    const template = await svc.getTemplate(req.params.id);
    if (!template) throw notFound("agent template");
    res.json(template);
  });

  router.post("/agent-templates", async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as {
      name: string;
      slug: string;
      description?: string;
      category: string;
      agentDefinitions: Record<string, unknown>[];
      teamStructure: Record<string, unknown>[];
    };
    if (!body.name?.trim() || !body.slug?.trim()) {
      res.status(400).json({ error: "name and slug are required" });
      return;
    }
    const existing = await db.select({ id: agentTemplates.id })
      .from(agentTemplates)
      .where(eq(agentTemplates.slug, body.slug.trim()))
      .limit(1);
    if (existing[0]) {
      res.status(409).json({ error: "A template with that slug already exists" });
      return;
    }
    const [created] = await db.insert(agentTemplates).values({
      name: body.name.trim(),
      slug: body.slug.trim(),
      description: body.description?.trim() ?? null,
      category: body.category ?? "custom",
      sourceType: "custom",
      agentDefinitions: body.agentDefinitions ?? [],
      teamStructure: body.teamStructure ?? [],
    }).returning();
    res.status(201).json(created);
  });

  router.put("/agent-templates/:id", async (req, res) => {
    assertInstanceAdmin(req);
    const updated = await svc.updateTemplate(req.params.id, req.body);
    if (!updated) throw notFound("agent template");
    res.json(updated);
  });

  router.delete("/agent-templates/:id", async (req, res) => {
    assertInstanceAdmin(req);
    try {
      const deleted = await svc.deleteTemplate(req.params.id);
      if (!deleted) throw notFound("agent template");
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === "Built-in templates cannot be deleted") {
        throw forbidden(err.message);
      }
      throw err;
    }
  });

  router.post("/agent-templates/:id/deploy", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.body as { companyId?: string };
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    const template = await svc.getTemplate(req.params.id);
    if (!template) throw notFound("agent template");
    const result = await svc.deployTemplate(req.params.id, companyId);
    res.json(result);
  });

  router.post("/agent-templates/save-as-template", async (req, res) => {
    assertBoard(req);
    const { agentId, subtree, name, slug, description, category } = req.body as {
      agentId: string;
      subtree: boolean;
      name: string;
      slug: string;
      description?: string;
      category: string;
    };
    if (!agentId || !name || !slug) {
      res.status(400).json({ error: "agentId, name, and slug are required" });
      return;
    }
    const template = await svc.saveAsTemplate(agentId, { subtree: subtree ?? false, name, slug, description, category });
    res.status(201).json(template);
  });

  return router;
}
```

- [ ] **Step 2: Export from routes index**

In `server/src/routes/index.ts`, add:
```ts
export { agentTemplateRoutes } from "./agent-templates.js";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/agent-templates.ts server/src/routes/index.ts
git commit -m "feat(routes): add agent-templates REST endpoints"
```

---

## Task 6: Wire into App + Server Startup

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Mount routes in app.ts**

In `server/src/app.ts`, add import after the other v3 imports:
```ts
import { agentTemplateRoutes } from "./routes/agent-templates.js";
```

In the same file, add `api.use(agentTemplateRoutes(db));` near the other route mounts (after `api.use(instanceStorageRoutes(db))`):
```ts
api.use(agentTemplateRoutes(db)); // v3: agent templates
```

- [ ] **Step 2: Call seed on startup**

In `server/src/index.ts`, find the line:
```ts
await eaAgentsService(db as any).seedEaAgents();
```

Add after it:
```ts
await agentTemplatesService(db as any).seedAgentTemplates();
```

Add the import at the top of `server/src/index.ts` alongside other service imports:
```ts
import { agentTemplatesService } from "./services/agent-templates.js";
```

- [ ] **Step 3: Typecheck + build**

```bash
pnpm -r typecheck && pnpm build
```

Expected: no errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add server/src/app.ts server/src/index.ts
git commit -m "feat(server): mount agent-template routes and seed on startup"
```

---

## Task 7: EA MCP Tools

**Files:**
- Modify: `server/src/routes/mcp-tool-server.ts`

- [ ] **Step 1: Add list_agent_templates tool**

In `server/src/routes/mcp-tool-server.ts`, find the tools array (look for other tools like `list_issues`, `list_agents`). Add these two tool definitions in the tools array:

```ts
{
  name: "list_agent_templates",
  description: "List all available agent templates (built-in and custom). Use before calling deploy_agent_template to see available slugs and descriptions.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},
{
  name: "deploy_agent_template",
  description: "Deploy an agent template to a company — creates all agents, wires the org chart, and seeds instruction files. Use when the operator asks to 'set up a team', 'add agents', or 'onboard' a company. templateSlug must come from list_agent_templates.",
  inputSchema: {
    type: "object",
    properties: {
      templateSlug: {
        type: "string",
        description: "Slug of the template to deploy (e.g. 'dev-team'). Get from list_agent_templates.",
      },
      companyId: {
        type: "string",
        description: "UUID of the company to deploy to. Defaults to the current working context company if omitted.",
      },
    },
    required: ["templateSlug"],
  },
},
```

- [ ] **Step 2: Add tool handlers**

In the same file, find the `switch (tool.name)` (or equivalent dispatch block) and add cases:

```ts
case "list_agent_templates": {
  const templates = await agentTemplatesService(db).listTemplates();
  return templates.map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    category: t.category,
    sourceType: t.sourceType,
    agentCount: t.agentCount,
  }));
}

case "deploy_agent_template": {
  const { templateSlug, companyId: argCompanyId } = args as { templateSlug: string; companyId?: string };
  const targetCompanyId = argCompanyId ?? effectiveCompanyId;
  if (!targetCompanyId) return "Error: no company in working context and no companyId provided";
  const [template] = await db
    .select({ id: agentTemplatesTable.id, name: agentTemplatesTable.name })
    .from(agentTemplates)
    .where(eq(agentTemplates.slug, templateSlug))
    .limit(1);
  if (!template) return `Error: template '${templateSlug}' not found. Call list_agent_templates to see available slugs.`;
  const result = await agentTemplatesService(db).deployTemplate(template.id, targetCompanyId);
  return `Deployed '${template.name}': created agents ${result.agentNames.join(", ")} (IDs: ${result.agentIds.join(", ")})`;
}
```

Add these imports at the top of `mcp-tool-server.ts` (add to existing `@paperclipai/db` import if one exists, or add new imports):
```ts
import { agentTemplatesService } from "../services/agent-templates.js";
import { agentTemplates } from "@paperclipai/db";  // add to existing db import
import { eq } from "drizzle-orm";                   // add to existing drizzle import
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/mcp-tool-server.ts
git commit -m "feat(mcp): add list_agent_templates and deploy_agent_template tools"
```

---

## Task 8: EA AGENTS.md + PROMPT_VERSION Bump

**Files:**
- Modify: `server/src/onboarding-assets/ea-operator/AGENTS.md`
- Modify: `server/src/services/ea-agents.ts`

- [ ] **Step 1: Add template routing to AGENTS.md**

In `server/src/onboarding-assets/ea-operator/AGENTS.md`, append at the end (before the final `---` if any, or at the bottom):

```markdown
## Agent Templates

When the operator asks to "set up a team", "add agents", "hire a team", or "onboard a new company with agents":
1. `list_agent_templates` — see available templates and their slugs
2. Pick the best matching template for the company's work type
3. `deploy_agent_template(templateSlug, companyId)` — creates all agents, wires org chart
4. `notify_operator` with a summary: which agents were created, their names, and what they do
```

- [ ] **Step 2: Bump PROMPT_VERSION**

In `server/src/services/ea-agents.ts`, change:
```ts
const PROMPT_VERSION = 7;
```
to:
```ts
const PROMPT_VERSION = 8;
```

- [ ] **Step 3: Commit**

```bash
git add server/src/onboarding-assets/ea-operator/AGENTS.md server/src/services/ea-agents.ts
git commit -m "feat(ea): add agent template routing to AGENTS.md, bump PROMPT_VERSION to 8"
```

---

## Task 9: UI API Client

**Files:**
- Create: `ui/src/api/agentTemplates.ts`
- Modify: `ui/src/api/index.ts`

- [ ] **Step 1: Create the API client**

Create `ui/src/api/agentTemplates.ts`:

```ts
import type {
  AgentTemplate,
  AgentTemplateSummary,
  DeployTemplateResult,
  CreateCustomTemplateInput,
  UpdateTemplateInput,
} from "@paperclipai/shared";
import { api } from "./client";

export interface AgentTemplateSummaryWithCount extends AgentTemplateSummary {
  agentCount: number;
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
};
```

- [ ] **Step 2: Export from API index**

In `ui/src/api/index.ts`, add:
```ts
export { agentTemplatesApi } from "./agentTemplates";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/agentTemplates.ts ui/src/api/index.ts
git commit -m "feat(ui): add agentTemplatesApi client"
```

---

## Task 10: Agent Templates UI Page

**Files:**
- Create: `ui/src/pages/AgentTemplates.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/InstanceSidebar.tsx`

- [ ] **Step 1: Create the page**

Create `ui/src/pages/AgentTemplates.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Code2, Package, Cpu, Users, ChevronRight, Loader2, CheckCircle } from "lucide-react";
import { agentTemplatesApi } from "../api/agentTemplates";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { AgentTemplate } from "@paperclipai/shared";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  dev: <Code2 className="h-4 w-4" />,
  sales: <Users className="h-4 w-4" />,
  finance: <Cpu className="h-4 w-4" />,
  support: <Package className="h-4 w-4" />,
  custom: <Package className="h-4 w-4" />,
};

function TemplateOrgChart({ template }: { template: AgentTemplate }) {
  const defs = template.agentDefinitions;
  const structure = template.teamStructure;

  function buildTree(reportsTo: string | null): typeof defs {
    return defs.filter((d) => {
      const entry = structure.find((s) => s.tempId === d.tempId);
      return entry?.reportsTo === reportsTo;
    });
  }

  function renderNode(def: (typeof defs)[0], depth: number) {
    const children = buildTree(def.tempId);
    return (
      <div key={def.tempId} className="flex flex-col items-start" style={{ paddingLeft: depth * 20 }}>
        <div className="flex items-center gap-2 py-1.5 px-2 rounded-lg border border-border bg-card text-xs mb-1">
          <Cpu className="h-3 w-3 text-muted-foreground" />
          <div>
            <p className="font-medium">{def.name}</p>
            <p className="text-muted-foreground capitalize">{def.role}</p>
          </div>
        </div>
        {children.map((child) => (
          <div key={child.tempId} className="flex items-start gap-0 w-full">
            <div className="flex flex-col items-center mr-1 mt-2">
              <div className="w-px h-2 bg-border" />
              <div className="w-3 h-px bg-border" />
            </div>
            <div className="flex-1">{renderNode(child, 0)}</div>
          </div>
        ))}
      </div>
    );
  }

  const roots = buildTree(null);
  return (
    <div className="space-y-1">
      {roots.map((root) => renderNode(root, 0))}
    </div>
  );
}

export function AgentTemplates() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Agent Templates" }]);
  }, [setBreadcrumbs]);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["agent-templates"],
    queryFn: () => agentTemplatesApi.list(),
  });

  const { data: selected } = useQuery({
    queryKey: ["agent-templates", selectedId],
    queryFn: () => agentTemplatesApi.get(selectedId!),
    enabled: !!selectedId,
  });

  const deploy = useMutation({
    mutationFn: ({ id, companyId }: { id: string; companyId: string }) =>
      agentTemplatesApi.deploy(id, companyId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast({
        title: "Template deployed",
        description: `Created ${result.agentNames.join(", ")}`,
      });
    },
    onError: (err) => {
      toast({
        title: "Deploy failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (!selectedId && templates.length > 0) {
      setSelectedId(templates[0].id);
    }
  }, [templates, selectedId]);

  return (
    <div className="flex h-full gap-0 overflow-hidden">
      {/* Left: catalog */}
      <div className="w-64 shrink-0 border-r border-border overflow-y-auto">
        <div className="p-4 border-b border-border">
          <h1 className="text-base font-semibold">Agent Templates</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Deploy pre-built agent teams to any company.</p>
        </div>
        {isLoading ? (
          <div className="p-4 text-xs text-muted-foreground">Loading...</div>
        ) : (
          <div className="p-2 space-y-1">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                  selectedId === t.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center gap-2">
                  {CATEGORY_ICONS[t.category] ?? <Package className="h-4 w-4" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{t.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {t.agentCount} agent{t.agentCount !== 1 ? "s" : ""} ·{" "}
                      <span className={t.sourceType === "built_in" ? "text-blue-400" : "text-green-400"}>
                        {t.sourceType === "built_in" ? "Built-in" : "Custom"}
                      </span>
                    </p>
                  </div>
                  <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="p-8 text-sm text-muted-foreground">Select a template to preview.</div>
        ) : (
          <div className="p-6 max-w-xl space-y-6">
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-base font-semibold">{selected.name}</h2>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      selected.sourceType === "built_in"
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-green-500/10 text-green-400"
                    }`}>
                      {selected.sourceType === "built_in" ? "Built-in" : "Custom"}
                      {(selected.metadata as Record<string, unknown> | null)?.customized ? " · Customized" : ""}
                    </span>
                  </div>
                  {selected.description && (
                    <p className="text-sm text-muted-foreground">{selected.description}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  disabled={!selectedCompanyId || deploy.isPending}
                  onClick={() => {
                    if (selectedCompanyId) {
                      deploy.mutate({ id: selected.id, companyId: selectedCompanyId });
                    }
                  }}
                >
                  {deploy.isPending ? (
                    <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Deploying...</>
                  ) : (
                    "Deploy to Company"
                  )}
                </Button>
              </div>
              {!selectedCompanyId && (
                <p className="text-xs text-muted-foreground mt-2">Select a company in the sidebar to enable deploy.</p>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-3">Team Structure</h3>
              <TemplateOrgChart template={selected} />
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-3">Agents</h3>
              <div className="space-y-2">
                {selected.agentDefinitions.map((def) => (
                  <div key={def.tempId} className="rounded-lg border border-border p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-sm font-medium">{def.name}</p>
                      <span className="text-[10px] text-muted-foreground capitalize px-1.5 py-0.5 rounded bg-muted">
                        {def.role}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                        {def.adapterType}
                      </span>
                    </div>
                    {def.capabilities && (
                      <p className="text-xs text-muted-foreground pl-5">{def.capabilities}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

In `ui/src/App.tsx`, find the import block for instance settings pages and add:
```tsx
import { AgentTemplates } from "./pages/AgentTemplates";
```

Find the route block with `/instance/...` routes (near `<Route path="github" element={<GitHubSettings />} />`) and add:
```tsx
<Route path="agent-templates" element={<AgentTemplates />} />
```

- [ ] **Step 3: Add nav item to InstanceSidebar**

In `ui/src/components/InstanceSidebar.tsx`, find the existing nav items (look for items linking to `/instance/settings/...` or `/instance/github`). Add a new nav item for Agent Templates:

```tsx
<NavItem to="/instance/agent-templates" icon={<LayoutTemplate className="h-4 w-4" />}>
  Agent Templates
</NavItem>
```

Add `LayoutTemplate` to the lucide-react import at the top of InstanceSidebar.tsx.

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/AgentTemplates.tsx ui/src/App.tsx ui/src/components/InstanceSidebar.tsx
git commit -m "feat(ui): add Agent Templates page with catalog, org chart preview, and deploy"
```

---

## Task 11: Save as Template on AgentDetail

**Files:**
- Modify: `ui/src/pages/AgentDetail.tsx`

- [ ] **Step 1: Add "Save as Template" to the overflow menu**

In `ui/src/pages/AgentDetail.tsx`, find the overflow menu Popover content (around line 892 — look for "Copy Agent ID" and "Reset Sessions" buttons).

Add this button inside the Popover content after "Reset Sessions":

```tsx
<button
  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
  onClick={() => {
    setSaveTemplateOpen(true);
    setMoreOpen(false);
  }}
>
  <LayoutTemplate className="h-3 w-3" />
  Save as Template
</button>
```

- [ ] **Step 2: Add LayoutTemplate import**

In `ui/src/pages/AgentDetail.tsx`, find the lucide-react import and add `LayoutTemplate` to it.

- [ ] **Step 3: Add Save as Template modal state and dialog**

Near the top of the `AgentDetail` function body (after existing useState declarations), add:

```tsx
const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
const [templateName, setTemplateName] = useState("");
const [templateSlug, setTemplateSlug] = useState("");
const [templateDescription, setTemplateDescription] = useState("");
const [templateCategory, setTemplateCategory] = useState("custom");
const [templateSubtree, setTemplateSubtree] = useState(false);
```

Add the mutation (import `agentTemplatesApi` from `"../api/agentTemplates"`):

```tsx
const saveAsTemplate = useMutation({
  mutationFn: () =>
    agentTemplatesApi.saveAsTemplate({
      agentId: agent.id,
      subtree: templateSubtree,
      name: templateName.trim(),
      slug: templateSlug.trim(),
      description: templateDescription.trim() || undefined,
      category: templateCategory,
    }),
  onSuccess: () => {
    setSaveTemplateOpen(false);
    setTemplateName("");
    setTemplateSlug("");
    setTemplateDescription("");
    toast({ title: "Template saved", description: `'${templateName}' is now available in Agent Templates.` });
  },
});
```

Add the dialog (before the closing `</div>` of the page, or alongside other dialogs):

```tsx
{saveTemplateOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="bg-card border border-border rounded-xl p-6 w-full max-w-sm space-y-4 shadow-xl">
      <h2 className="text-sm font-semibold">Save as Template</h2>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Template Name</label>
          <input
            className="mt-1 w-full h-8 rounded-md border border-border bg-background px-2 text-sm"
            placeholder="e.g. My Dev Agent"
            value={templateName}
            onChange={(e) => {
              setTemplateName(e.target.value);
              setTemplateSlug(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""));
            }}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Slug</label>
          <input
            className="mt-1 w-full h-8 rounded-md border border-border bg-background px-2 text-sm font-mono"
            placeholder="my-dev-agent"
            value={templateSlug}
            onChange={(e) => setTemplateSlug(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Description (optional)</label>
          <input
            className="mt-1 w-full h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={templateDescription}
            onChange={(e) => setTemplateDescription(e.target.value)}
          />
        </div>
        {agent.reportsTo === null && (
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={templateSubtree}
              onChange={(e) => setTemplateSubtree(e.target.checked)}
              className="rounded"
            />
            Include full team (all direct reports)
          </label>
        )}
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={() => setSaveTemplateOpen(false)}>Cancel</Button>
        <Button
          size="sm"
          disabled={!templateName.trim() || !templateSlug.trim() || saveAsTemplate.isPending}
          onClick={() => saveAsTemplate.mutate()}
        >
          {saveAsTemplate.isPending ? "Saving..." : "Save Template"}
        </Button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors. If `useToast` is not already imported in AgentDetail, add it: `import { useToast } from "@/hooks/use-toast";`

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/AgentDetail.tsx
git commit -m "feat(ui): add Save as Template to AgentDetail overflow menu"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors across all workspaces.

- [ ] **Step 2: Run all tests**

```bash
pnpm test:run
```

Expected: all tests pass including the new `agent-templates.test.ts`.

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: all workspaces build cleanly.

- [ ] **Step 4: Manual smoke test**

1. Start dev server: `pnpm dev`
2. Open `http://localhost:3100`
3. Navigate to Instance Settings → Agent Templates
4. Verify "Dev Team" template appears with Built-in badge
5. Select it — verify org chart shows Tech Lead → Full-stack Dev + QA Agent
6. Select a company → click Deploy → verify 3 agents appear in the company's org chart
7. Open an agent detail → overflow menu → "Save as Template" → fill form → save → verify template appears in catalog
