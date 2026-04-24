// v3: plan-gate policy service — per-scope action rules with resolution
// order (agent → project → client → company). paramsJson is opaque data
// for the action-specific agent logic; the gate only honours the
// requiresApproval + immediateEmail flags on the resolved row.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { actionPolicies } from "@paperclipai/db";

export type ActionPolicyRow = typeof actionPolicies.$inferSelect;

export type PolicyScope = "company" | "client" | "project" | "agent";
export const POLICY_SCOPES: readonly PolicyScope[] = ["company", "client", "project", "agent"];

// Resolution order: most specific first.
const RESOLUTION_ORDER: PolicyScope[] = ["agent", "project", "client", "company"];

export interface DefaultPolicy {
  actionType: string;
  requiresApproval: boolean;
  immediateEmail: boolean;
  paramsJson?: Record<string, unknown>;
}

export const DEFAULT_POLICIES: DefaultPolicy[] = [
  { actionType: "send_email", requiresApproval: true, immediateEmail: false },
  { actionType: "deploy", requiresApproval: true, immediateEmail: true },
  { actionType: "delete_data", requiresApproval: true, immediateEmail: true },
  { actionType: "create_issue_external", requiresApproval: true, immediateEmail: false },
  {
    actionType: "spend_over_cents",
    requiresApproval: true,
    immediateEmail: true,
    paramsJson: { thresholdCents: 5000 },
  },
];

export interface CreatePolicyInput {
  scope: PolicyScope;
  scopeRefId: string;
  actionType: string;
  requiresApproval?: boolean;
  immediateEmail?: boolean;
  paramsJson?: Record<string, unknown>;
}

export interface UpdatePolicyInput {
  requiresApproval?: boolean;
  immediateEmail?: boolean;
  paramsJson?: Record<string, unknown>;
}

export interface EvaluateContext {
  companyId: string;
  actionType: string;
  clientId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
}

export interface PolicyResolution {
  policy: ActionPolicyRow | null;
  matchedScope: PolicyScope | null;
}

export function actionPolicyService(db: Db) {
  // Seeds the standard five at company scope for a given company. Idempotent.
  async function seedDefaults(companyId: string): Promise<void> {
    const existing = await db
      .select({ actionType: actionPolicies.actionType })
      .from(actionPolicies)
      .where(
        and(
          eq(actionPolicies.companyId, companyId),
          eq(actionPolicies.scope, "company"),
          eq(actionPolicies.scopeRefId, companyId),
        ),
      );
    const have = new Set(existing.map((r) => r.actionType));
    const missing = DEFAULT_POLICIES.filter((p) => !have.has(p.actionType));
    if (missing.length === 0) return;
    await db.insert(actionPolicies).values(
      missing.map((p) => ({
        companyId,
        scope: "company" as PolicyScope,
        scopeRefId: companyId,
        actionType: p.actionType,
        requiresApproval: p.requiresApproval,
        immediateEmail: p.immediateEmail,
        paramsJson: p.paramsJson ?? {},
        updatedAt: new Date(),
      })),
    );
  }

  async function list(companyId: string): Promise<ActionPolicyRow[]> {
    return db
      .select()
      .from(actionPolicies)
      .where(eq(actionPolicies.companyId, companyId))
      .orderBy(asc(actionPolicies.scope), asc(actionPolicies.actionType));
  }

  async function getById(id: string): Promise<ActionPolicyRow | null> {
    const [row] = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id)).limit(1);
    return row ?? null;
  }

  async function create(companyId: string, input: CreatePolicyInput): Promise<ActionPolicyRow> {
    const [row] = await db
      .insert(actionPolicies)
      .values({
        companyId,
        scope: input.scope,
        scopeRefId: input.scopeRefId,
        actionType: input.actionType,
        requiresApproval: input.requiresApproval ?? true,
        immediateEmail: input.immediateEmail ?? false,
        paramsJson: input.paramsJson ?? {},
        updatedAt: new Date(),
      })
      .returning();
    return row!;
  }

  async function update(id: string, input: UpdatePolicyInput): Promise<ActionPolicyRow | null> {
    const updates: Partial<ActionPolicyRow> & { updatedAt: Date } = { updatedAt: new Date() };
    if (input.requiresApproval !== undefined) updates.requiresApproval = input.requiresApproval;
    if (input.immediateEmail !== undefined) updates.immediateEmail = input.immediateEmail;
    if (input.paramsJson !== undefined) updates.paramsJson = input.paramsJson;
    const [row] = await db
      .update(actionPolicies)
      .set(updates)
      .where(eq(actionPolicies.id, id))
      .returning();
    return row ?? null;
  }

  async function remove(id: string): Promise<void> {
    await db.delete(actionPolicies).where(eq(actionPolicies.id, id));
  }

  // Resolution: walk the scope hierarchy from most specific to least, return
  // the first policy row that matches actionType. Missing everywhere → null
  // (caller interprets as "no rule" — typically PASS).
  async function resolvePolicy(ctx: EvaluateContext): Promise<PolicyResolution> {
    const candidates: Array<{ scope: PolicyScope; ref: string }> = [];
    if (ctx.agentId) candidates.push({ scope: "agent", ref: ctx.agentId });
    if (ctx.projectId) candidates.push({ scope: "project", ref: ctx.projectId });
    if (ctx.clientId) candidates.push({ scope: "client", ref: ctx.clientId });
    candidates.push({ scope: "company", ref: ctx.companyId });

    const rows = await db
      .select()
      .from(actionPolicies)
      .where(
        and(
          eq(actionPolicies.companyId, ctx.companyId),
          eq(actionPolicies.actionType, ctx.actionType),
          inArray(
            actionPolicies.scopeRefId,
            candidates.map((c) => c.ref),
          ),
        ),
      );
    if (rows.length === 0) return { policy: null, matchedScope: null };

    // Pick the highest-priority scope present in rows.
    const byScopeRef = new Map<string, ActionPolicyRow>();
    for (const r of rows) byScopeRef.set(`${r.scope}:${r.scopeRefId}`, r);
    for (const preferred of RESOLUTION_ORDER) {
      const match = candidates.find((c) => c.scope === preferred);
      if (!match) continue;
      const row = byScopeRef.get(`${preferred}:${match.ref}`);
      if (row) return { policy: row, matchedScope: preferred };
    }
    return { policy: null, matchedScope: null };
  }

  return { seedDefaults, list, getById, create, update, remove, resolvePolicy };
}

export type ActionPolicyService = ReturnType<typeof actionPolicyService>;
