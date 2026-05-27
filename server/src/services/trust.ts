import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { actionPolicies, trustLevels } from "@paperclipai/db";

export function trustService(db: Db) {
  /**
   * Calculate trust level (0-5) from counts.
   * Formula: floor((approved - 2*rejected - lowScore) / 3), clamped 0-5
   */
  function calculateLevel(
    approvedCount: number,
    rejectedCount: number,
    lowScoreCount: number,
  ): number {
    return Math.max(0, Math.min(5, Math.floor((approvedCount - 2 * rejectedCount - lowScoreCount) / 3)));
  }

  /**
   * Record decision (approved/rejected) for agent+actionType.
   * Creates trust_level row if not exists, increments counts, recalculates level.
   */
  async function recordDecision(
    agentId: string,
    actionType: string,
    decision: "approved" | "rejected",
  ): Promise<void> {
    const [existing] = await db
      .select()
      .from(trustLevels)
      .where(and(eq(trustLevels.agentId, agentId), eq(trustLevels.actionType, actionType)))
      .limit(1);

    if (!existing) {
      // Create new trust level
      const approvedCount = decision === "approved" ? 1 : 0;
      const rejectedCount = decision === "rejected" ? 1 : 0;
      await db.insert(trustLevels).values({
        agentId,
        actionType,
        level: calculateLevel(approvedCount, rejectedCount, 0),
        approvedCount,
        rejectedCount,
        lowScoreCount: 0,
        lastDecisionAt: new Date(),
      });
    } else {
      // Update existing
      const newApprovedCount = existing.approvedCount + (decision === "approved" ? 1 : 0);
      const newRejectedCount = existing.rejectedCount + (decision === "rejected" ? 1 : 0);
      const newLevel = calculateLevel(newApprovedCount, newRejectedCount, existing.lowScoreCount);

      await db
        .update(trustLevels)
        .set({
          approvedCount: newApprovedCount,
          rejectedCount: newRejectedCount,
          level: newLevel,
          lastDecisionAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(trustLevels.id, existing.id));
    }
  }

  /**
   * Check if agent can auto-approve for actionType.
   * Returns true only if:
   * 1. action_policies.requiresApproval is false, OR
   * 2. trust_levels.autoApproveEnabled is true (and policy requires approval)
   */
  async function checkAutoApprove(
    agentId: string,
    actionType: string,
    companyId: string,
  ): Promise<boolean> {
    // Check action policy first
    const [policy] = await db
      .select()
      .from(actionPolicies)
      .where(and(eq(actionPolicies.companyId, companyId), eq(actionPolicies.actionType, actionType)))
      .limit(1);

    // If policy explicitly doesn't require approval, auto-approve
    if (policy && !policy.requiresApproval) {
      return true;
    }

    // Check trust level (only if policy exists and requires approval, or no policy = require by default)
    const [trustLevel] = await db
      .select()
      .from(trustLevels)
      .where(and(eq(trustLevels.agentId, agentId), eq(trustLevels.actionType, actionType)))
      .limit(1);

    return trustLevel?.autoApproveEnabled ?? false;
  }

  /**
   * Get trust level for agent+actionType
   */
  async function getTrustLevel(agentId: string, actionType: string) {
    const [level] = await db
      .select()
      .from(trustLevels)
      .where(and(eq(trustLevels.agentId, agentId), eq(trustLevels.actionType, actionType)))
      .limit(1);
    return level ?? null;
  }

  return {
    calculateLevel,
    recordDecision,
    checkAutoApprove,
    getTrustLevel,
  };
}
