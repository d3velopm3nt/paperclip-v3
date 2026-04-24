// v3: plan-gate service.
//
// evaluateGate(ctx) — resolves the applicable policy (scope hierarchy in
// action-policies service), decides PASS or REQUIRES_PLAN.
// proposePlan(input) — writes a plans + approvals row for a REQUIRES_PLAN
// action, so the user can review + approve.
// executePlan(planId) — marks the plan executed; concrete dispatchers for
// create_issue / reply_to_sender / request_clarification will be added as
// downstream capabilities ship.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issues, plans, emailMessages } from "@paperclipai/db";
import { actionPolicyService, type ActionPolicyRow, type PolicyScope } from "./action-policies.js";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

export type Confidence = "low" | "medium" | "high";

export interface EvaluateInput {
  companyId: string;
  actionType: string;
  confidence?: Confidence;
  clientId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
}

export interface EvaluateResult {
  decision: "PASS" | "REQUIRES_PLAN";
  reason: string;
  policy: ActionPolicyRow | null;
  matchedScope: PolicyScope | null;
}

export interface ProposePlanInput {
  companyId: string;
  agentId: string;
  actionType: string;
  kind: string; // plans.kind — create_issue | reply_to_sender | ...
  proposalText: string;
  proposalMeta?: Record<string, unknown>;
  clientId?: string | null;
  projectId?: string | null;
  sourceEmailMessageId?: string | null;
  confidence?: Confidence;
}

export interface ProposedPlan {
  planId: string;
  approvalId: string;
  immediateEmail: boolean;
}

export function planGateService(db: Db) {
  const policies = actionPolicyService(db);

  async function evaluateGate(input: EvaluateInput): Promise<EvaluateResult> {
    const { policy, matchedScope } = await policies.resolvePolicy({
      companyId: input.companyId,
      actionType: input.actionType,
      clientId: input.clientId,
      projectId: input.projectId,
      agentId: input.agentId,
    });

    // confidence=low always forces a plan, overriding "requiresApproval=false"
    if (input.confidence === "low") {
      return {
        decision: "REQUIRES_PLAN",
        reason: "Agent reported low confidence — override to plan gate",
        policy,
        matchedScope,
      };
    }

    if (!policy) {
      return {
        decision: "PASS",
        reason: "No policy found for action at any scope",
        policy: null,
        matchedScope: null,
      };
    }

    if (policy.requiresApproval) {
      return {
        decision: "REQUIRES_PLAN",
        reason: `Policy at ${matchedScope} scope requires approval`,
        policy,
        matchedScope,
      };
    }

    return {
      decision: "PASS",
      reason: `Policy at ${matchedScope} scope allows without approval`,
      policy,
      matchedScope,
    };
  }

  // Writes plan + pending approval. Caller typically arrives here because
  // evaluateGate returned REQUIRES_PLAN, but proposePlan can also be called
  // unconditionally for explicitly gated actions.
  async function proposePlan(input: ProposePlanInput): Promise<ProposedPlan> {
    const evaluation = await evaluateGate({
      companyId: input.companyId,
      actionType: input.actionType,
      confidence: input.confidence,
      clientId: input.clientId,
      projectId: input.projectId,
      agentId: input.agentId,
    });

    return db.transaction(async (tx) => {
      const [plan] = await tx
        .insert(plans)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          clientId: input.clientId ?? null,
          projectId: input.projectId ?? null,
          actionType: input.actionType,
          kind: input.kind,
          sourceEmailMessageId: input.sourceEmailMessageId ?? null,
          proposalText: input.proposalText,
          proposalMeta: input.proposalMeta ?? {},
          confidence: input.confidence ?? "medium",
          updatedAt: new Date(),
        })
        .returning();

      const [approval] = await tx
        .insert(approvals)
        .values({
          companyId: input.companyId,
          type: "plan",
          planId: plan!.id,
          status: "pending",
          requestedByAgentId: input.agentId,
          payload: {
            summary: input.proposalText.slice(0, 200),
            actionType: input.actionType,
            kind: input.kind,
            proposalText: input.proposalText,
            proposalMeta: input.proposalMeta ?? {},
            sourceEmailMessageId: input.sourceEmailMessageId ?? null,
          },
          updatedAt: new Date(),
        })
        .returning();

      // Link the source email to the new approval/plan so the inbox shows
      // the "plan_proposed" state instead of staying at "pending".
      if (input.sourceEmailMessageId) {
        await tx
          .update(emailMessages)
          .set({
            processingState: "plan_proposed",
            processedAt: new Date(),
            approvalId: approval!.id,
            matchedClientId: input.clientId ?? null,
            matchedAgentId: input.agentId,
            matchedCompanyId: input.companyId,
          })
          .where(eq(emailMessages.id, input.sourceEmailMessageId));
      }

      const immediateEmail = evaluation.policy?.immediateEmail === true;
      logger.info(
        {
          planId: plan!.id,
          approvalId: approval!.id,
          actionType: input.actionType,
          matchedScope: evaluation.matchedScope,
          immediateEmail,
        },
        "plan-gate: plan proposed",
      );

      return { planId: plan!.id, approvalId: approval!.id, immediateEmail };
    });
  }

  // Transitions plan + approval records for a decision. Does not dispatch the
  // underlying action — dispatchers (send_email, create_issue etc.) live in
  // their own services once they exist.
  async function recordDecision(
    planId: string,
    decision: "approved" | "rejected" | "revision_requested",
    decidedByUserId: string | null,
    note?: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [plan] = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (!plan) throw new Error(`Plan not found: ${planId}`);
      await tx
        .update(plans)
        .set({
          decision,
          decidedByUserId,
          decidedAt: new Date(),
          decisionNote: note ?? null,
          updatedAt: new Date(),
        })
        .where(eq(plans.id, planId));
      await tx
        .update(approvals)
        .set({
          status: decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "pending",
          decisionNote: note ?? null,
          decidedByUserId: decidedByUserId ?? null,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(approvals.planId, planId), eq(approvals.type, "plan")));
    });
  }

  async function markExecuted(
    planId: string,
    result: { success: boolean; error?: string },
  ): Promise<void> {
    await db
      .update(plans)
      .set({
        executionStatus: result.success ? "success" : "failed",
        executionError: result.error ?? null,
        executedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(plans.id, planId));
  }

  // Dispatches the approved plan. Phase 2 only implements create_issue; other
  // kinds log and mark failed so they show up in the UI but don't silently
  // succeed. Caller should ensure plan.decision === 'approved' before invoking.
  async function executePlan(planId: string): Promise<{ issueId?: string }> {
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    if (plan.decision !== "approved") {
      throw new Error(`Plan not approved: ${planId} (decision=${plan.decision})`);
    }
    if (plan.executionStatus !== "pending") {
      throw new Error(`Plan already executed: ${planId} (status=${plan.executionStatus})`);
    }

    try {
      if (plan.kind === "create_issue") {
        const meta = (plan.proposalMeta ?? {}) as Record<string, unknown>;
        const srcEmail = (meta.sourceEmail ?? {}) as { subject?: string; from?: string };
        const title = srcEmail.subject?.trim() || plan.proposalText.slice(0, 200);
        // Pull the source email body if linked so the issue has context.
        let description = plan.proposalText;
        if (plan.sourceEmailMessageId) {
          const [msg] = await db
            .select({ body: emailMessages.body, fromAddr: emailMessages.fromAddr })
            .from(emailMessages)
            .where(eq(emailMessages.id, plan.sourceEmailMessageId))
            .limit(1);
          if (msg) {
            description = `From: ${msg.fromAddr}\n\n${msg.body}`;
          }
        }
        const created = await issueService(db).create(plan.companyId, {
          title,
          description,
          clientId: plan.clientId ?? null,
          createdByAgentId: plan.agentId,
        });
        // Link the issue back to the plan + email for audit/inbox display.
        await db
          .update(plans)
          .set({
            issueId: created.id,
            executionStatus: "success",
            executedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(plans.id, planId));
        if (plan.sourceEmailMessageId) {
          await db
            .update(emailMessages)
            .set({
              issueId: created.id,
              processingState: "executed",
              processedAt: new Date(),
            })
            .where(eq(emailMessages.id, plan.sourceEmailMessageId));
        }
        logger.info({ planId, issueId: created.id }, "plan-gate: executed create_issue");
        return { issueId: created.id };
      }

      // Unsupported kinds — mark as failed with a clear error.
      const msg = `plan kind '${plan.kind}' is not dispatched by Phase 2 executor`;
      await markExecuted(planId, { success: false, error: msg });
      throw new Error(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markExecuted(planId, { success: false, error: message });
      throw err;
    }
  }

  return { evaluateGate, proposePlan, recordDecision, markExecuted, executePlan };
}

export type PlanGateService = ReturnType<typeof planGateService>;
