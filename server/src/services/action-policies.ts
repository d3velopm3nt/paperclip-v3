// v3: plan-gate policy service — per-company action rules + default seed.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { actionPolicies } from "@paperclipai/db";

export type ActionPolicyRow = typeof actionPolicies.$inferSelect;

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

export function actionPolicyService(db: Db) {
  // Inserts missing default policies for a company. Existing rows by
  // actionType are left untouched — safe to re-run.
  async function seedDefaults(companyId: string, tx = db): Promise<void> {
    const existing = await tx
      .select({ actionType: actionPolicies.actionType })
      .from(actionPolicies)
      .where(eq(actionPolicies.companyId, companyId));
    const have = new Set(existing.map((r) => r.actionType));
    const missing = DEFAULT_POLICIES.filter((p) => !have.has(p.actionType));
    if (missing.length === 0) return;
    await tx.insert(actionPolicies).values(
      missing.map((p) => ({
        companyId,
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
      .orderBy(asc(actionPolicies.actionType));
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

  // Gate primitive — used by plan-gate service later. Missing row → treat as
  // "no policy, no approval required" (caller may override per action).
  async function evaluatePolicy(
    companyId: string,
    actionType: string,
  ): Promise<ActionPolicyRow | null> {
    const [row] = await db
      .select()
      .from(actionPolicies)
      .where(and(eq(actionPolicies.companyId, companyId), eq(actionPolicies.actionType, actionType)))
      .limit(1);
    return row ?? null;
  }

  return { seedDefaults, list, getById, create, update, remove, evaluatePolicy };
}

export type ActionPolicyService = ReturnType<typeof actionPolicyService>;
