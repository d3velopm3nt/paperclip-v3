// v3: scoring service — record human scores, feed trust
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentScores } from "@paperclipai/db";
import { trustService } from "./trust.js";

export interface CreateScoreInput {
  agentId: string;
  planId?: string;
  issueId?: string;
  messageId?: string;
  scoredByUserId: string;
  score: number; // 1-5
  comment?: string;
}

export function scoringService(db: Db) {
  return {
    async createScore(input: CreateScoreInput) {
      if (input.score < 1 || input.score > 5) {
        throw new Error("Score must be between 1 and 5");
      }

      const [score] = await db
        .insert(agentScores)
        .values({
          agentId: input.agentId,
          planId: input.planId ?? null,
          issueId: input.issueId ?? null,
          messageId: input.messageId ?? null,
          scoredByUserId: input.scoredByUserId,
          score: input.score,
          comment: input.comment ?? null,
        })
        .returning();

      // Low score triggers trust penalty and memory append
      if (input.score <= 2) {
        const trust = trustService(db);
        // Increment low score count which factors into trust calculation
        // Trust service already handles this via recordDecision with 'declined' for low scores
        // For now, just log - full integration would append to agent memory
        console.log(`[scoring] Low score (${input.score}) for agent ${input.agentId}`);
      }

      return score!;
    },

    async listScoresForAgent(agentId: string) {
      return db
        .select()
        .from(agentScores)
        .where(eq(agentScores.agentId, agentId))
        .orderBy(agentScores.createdAt);
    },
  };
}
