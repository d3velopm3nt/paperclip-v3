import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { trustService } from "../services/trust.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping trust service tests: ${support.reason ?? "unsupported"}`);
}

describeDB("trustService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trust-service-");
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

  it("recordDecision creates trust_level on first call, increments counts", async () => {
    const svc = trustService(db);

    await svc.recordDecision(agentId, "send_email", "approved");

    const level1 = await svc.getTrustLevel(agentId, "send_email");
    expect(level1?.approvedCount).toBe(1);
    expect(level1?.rejectedCount).toBe(0);
    expect(level1?.level).toBeGreaterThanOrEqual(0);

    await svc.recordDecision(agentId, "send_email", "rejected");

    const level2 = await svc.getTrustLevel(agentId, "send_email");
    expect(level2?.approvedCount).toBe(1);
    expect(level2?.rejectedCount).toBe(1);
  });

  it("checkAutoApprove returns false when autoApproveEnabled is false", async () => {
    const svc = trustService(db);

    const canAutoApprove = await svc.checkAutoApprove(agentId, "deploy", companyId);
    expect(canAutoApprove).toBe(false);
  });

  it("calculateLevel returns 0 when no approvals, increases with approvals", async () => {
    const svc = trustService(db);

    const level0 = svc.calculateLevel(0, 0, 0);
    expect(level0).toBe(0);

    const level1 = svc.calculateLevel(10, 0, 0);
    expect(level1).toBeGreaterThan(0);
    expect(level1).toBeLessThanOrEqual(5);

    const level2 = svc.calculateLevel(10, 5, 0);
    expect(level2).toBeLessThan(level1);
  });
});
