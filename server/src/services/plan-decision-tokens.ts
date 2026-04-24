// v3: token-based approve/reject links for plan notifications. Each plan gets
// a one-shot token on proposal; the link in the email hits a public endpoint
// that consumes the token and calls planGateService.recordDecision.
import { randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { planDecisionTokens } from "@paperclipai/db";

const DEFAULT_TTL_HOURS = 24;

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export function planDecisionTokenService(db: Db) {
  async function issue(planId: string, ttlHours = DEFAULT_TTL_HOURS): Promise<IssuedToken> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    await db.insert(planDecisionTokens).values({ planId, token, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Redeems a token exactly once. Returns the planId on success.
   * Throws when the token is missing, expired, or already used.
   */
  async function redeem(token: string): Promise<{ planId: string }> {
    const [row] = await db
      .select()
      .from(planDecisionTokens)
      .where(eq(planDecisionTokens.token, token))
      .limit(1);
    if (!row) throw new Error("Invalid or unknown token");
    if (row.usedAt) throw new Error("Token already used");
    if (row.expiresAt.getTime() < Date.now()) throw new Error("Token expired");

    // Claim atomically — second caller with same token gets usedAt !== null.
    const [claimed] = await db
      .update(planDecisionTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(planDecisionTokens.token, token),
          sql`${planDecisionTokens.usedAt} IS NULL`,
        ),
      )
      .returning();
    if (!claimed) throw new Error("Token already used");
    return { planId: row.planId };
  }

  async function purgeExpired(): Promise<void> {
    await db.delete(planDecisionTokens).where(lt(planDecisionTokens.expiresAt, new Date()));
  }

  return { issue, redeem, purgeExpired };
}

export type PlanDecisionTokenService = ReturnType<typeof planDecisionTokenService>;
