import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentProjectSessions, agents } from "@paperclipai/db";

export function sessionResolverService(db: Db) {
  return {
    async resolveSession(agentId: string, adapterType: string, projectId: string | null) {
      const conditions = [
        eq(agentProjectSessions.agentId, agentId),
        eq(agentProjectSessions.adapterType, adapterType),
      ];
      if (projectId) {
        conditions.push(eq(agentProjectSessions.projectId, projectId));
      }

      const [existing] = await db
        .select()
        .from(agentProjectSessions)
        .where(and(...conditions))
        .limit(1);

      if (existing) {
        return existing;
      }

      // Create new session — need companyId from agent
      const [agent] = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!agent) return null;

      const [session] = await db
        .insert(agentProjectSessions)
        .values({
          agentId,
          adapterType,
          projectId: projectId ?? undefined,
          companyId: agent.companyId,
        })
        .returning();

      return session;
    },

    async updateSession(
      agentId: string,
      adapterType: string,
      projectId: string | null,
      updates: {
        sessionParamsJson?: Record<string, unknown> | null;
        sessionDisplayId?: string | null;
        lastRunId?: string | null;
        runCount?: number;
        inputTokens?: number;
        outputTokens?: number;
      },
    ) {
      const conditions = [
        eq(agentProjectSessions.agentId, agentId),
        eq(agentProjectSessions.adapterType, adapterType),
      ];
      if (projectId) {
        conditions.push(eq(agentProjectSessions.projectId, projectId));
      }

      const [existing] = await db
        .select()
        .from(agentProjectSessions)
        .where(and(...conditions))
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(agentProjectSessions)
          .set({
            sessionParams: updates.sessionParamsJson ?? existing.sessionParams,
            sessionDisplayId: updates.sessionDisplayId ?? existing.sessionDisplayId,
            lastRunId: updates.lastRunId ?? existing.lastRunId,
            runCount: existing.runCount + (updates.runCount ?? 0),
            totalInputTokens: existing.totalInputTokens + (updates.inputTokens ?? 0),
            totalOutputTokens: existing.totalOutputTokens + (updates.outputTokens ?? 0),
            updatedAt: new Date(),
          })
          .where(eq(agentProjectSessions.id, existing.id))
          .returning();
        return updated;
      }

      // Create if not exists
      const [agent] = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!agent) return null;

      const [created] = await db
        .insert(agentProjectSessions)
        .values({
          agentId,
          adapterType,
          projectId: projectId ?? undefined,
          companyId: agent.companyId,
          sessionParams: updates.sessionParamsJson,
          sessionDisplayId: updates.sessionDisplayId,
          lastRunId: updates.lastRunId,
          runCount: updates.runCount ?? 1,
          totalInputTokens: updates.inputTokens ?? 0,
          totalOutputTokens: updates.outputTokens ?? 0,
        })
        .returning();
      return created;
    },

    async getSession(sessionId: string) {
      const [session] = await db
        .select()
        .from(agentProjectSessions)
        .where(eq(agentProjectSessions.id, sessionId))
        .limit(1);
      return session ?? null;
    },

    async listSessions(agentId: string) {
      return db
        .select()
        .from(agentProjectSessions)
        .where(eq(agentProjectSessions.agentId, agentId));
    },
  };
}
