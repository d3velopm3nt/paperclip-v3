import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionPolicies, agents, companies, createDb, trustLevels } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { planGateService } from "../services/plan-gate.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping plan-gate trust integration tests: ${support.reason ?? "unsupported"}`);
}

describeDB("planGateService trust integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-gate-trust-");
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
        name: "Test Agent",
        role: "ceo",
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("evaluateGate returns PASS when trust level has autoApproveEnabled=true", async () => {
    const svc = planGateService(db);

    // Set up policy that requires approval
    await db.insert(actionPolicies).values({
      companyId,
      scope: "company",
      scopeRefId: companyId,
      actionType: "send_email",
      requiresApproval: true,
    });

    // Set up trust level with auto-approve enabled
    await db.insert(trustLevels).values({
      agentId,
      actionType: "send_email",
      autoApproveEnabled: true,
      level: 3,
      approvedCount: 10,
      rejectedCount: 0,
    });

    const result = await svc.evaluateGate({
      companyId,
      agentId,
      actionType: "send_email",
      confidence: "high",
    });

    expect(result.decision).toBe("PASS");
    expect(result.reason).toContain("trust");
  });

  it("evaluateGate returns REQUIRES_PLAN when policy requires approval and no trust level", async () => {
    const svc = planGateService(db);

    // Set up policy that requires approval
    await db.insert(actionPolicies).values({
      companyId,
      scope: "company",
      scopeRefId: companyId,
      actionType: "deploy",
      requiresApproval: true,
    });

    // No trust level set up

    const result = await svc.evaluateGate({
      companyId,
      agentId,
      actionType: "deploy",
      confidence: "high",
    });

    expect(result.decision).toBe("REQUIRES_PLAN");
    expect(result.reason).toContain("requires approval");
  });
});
