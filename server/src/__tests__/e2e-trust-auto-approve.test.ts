import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actionPolicies, agents, companies, createDb, plans, trustLevels } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { planGateService } from "../services/plan-gate.js";
import { trustService } from "../services/trust.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping trust auto-approve e2e: ${support.reason ?? "unsupported"}`);
}

describeDB("trust auto-approve e2e", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trust-e2e-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", ownerEmail: "test@example.com", issuePrefix: "TC" })
      .returning({ id: companies.id });
    companyId = company!.id;

    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Junior Agent",
        role: "engineer",
      })
      .returning({ id: agents.id });
    agentId = agent!.id;

    // Set up policy requiring approval for deploys
    await db.insert(actionPolicies).values({
      companyId,
      scope: "company",
      scopeRefId: companyId,
      actionType: "deploy",
      requiresApproval: true,
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("agent earns trust through approvals, then gets auto-approve", async () => {
    const gate = planGateService(db);
    const trust = trustService(db);

    // Initial: agent has no trust level, gate requires plan
    const eval1 = await gate.evaluateGate({
      companyId,
      agentId,
      actionType: "deploy",
      confidence: "high",
    });
    expect(eval1.decision).toBe("REQUIRES_PLAN");

    // Simulate 10 approved deploys
    for (let i = 0; i < 10; i++) {
      await trust.recordDecision(agentId, "deploy", "approved");
    }

    // Check trust level increased
    const level = await trust.getTrustLevel(agentId, "deploy");
    expect(level).not.toBeNull();
    expect(level!.approvedCount).toBe(10);
    expect(level!.level).toBeGreaterThan(0);

    // But auto-approve still disabled
    const eval2 = await gate.evaluateGate({
      companyId,
      agentId,
      actionType: "deploy",
      confidence: "high",
    });
    expect(eval2.decision).toBe("REQUIRES_PLAN");

    // Enable auto-approve for this agent+actionType
    await db
      .update(trustLevels)
      .set({ autoApproveEnabled: true })
      .where(eq(trustLevels.id, level!.id));

    // Now agent passes gate without plan
    const eval3 = await gate.evaluateGate({
      companyId,
      agentId,
      actionType: "deploy",
      confidence: "high",
    });
    expect(eval3.decision).toBe("PASS");
    expect(eval3.reason).toContain("trust");
  });

  it("low confidence overrides trust auto-approve", async () => {
    const gate = planGateService(db);
    const trust = trustService(db);

    // Set up agent with high trust + auto-approve
    await trust.recordDecision(agentId, "send_email", "approved");
    await trust.recordDecision(agentId, "send_email", "approved");
    await trust.recordDecision(agentId, "send_email", "approved");

    await db.insert(actionPolicies).values({
      companyId,
      scope: "company",
      scopeRefId: companyId,
      actionType: "send_email",
      requiresApproval: true,
    });

    const level = await trust.getTrustLevel(agentId, "send_email");
    await db
      .update(trustLevels)
      .set({ autoApproveEnabled: true })
      .where(eq(trustLevels.id, level!.id));

    // High confidence: passes
    const evalHigh = await gate.evaluateGate({
      companyId,
      agentId,
      actionType: "send_email",
      confidence: "high",
    });
    expect(evalHigh.decision).toBe("PASS");

    // Low confidence: requires plan (override)
    const evalLow = await gate.evaluateGate({
      companyId,
      agentId,
      actionType: "send_email",
      confidence: "low",
    });
    expect(evalLow.decision).toBe("REQUIRES_PLAN");
    expect(evalLow.reason).toContain("low confidence");
  });
});
