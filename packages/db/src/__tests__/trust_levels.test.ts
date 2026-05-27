import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, trustLevels } from "../index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping trust_levels tests: ${support.reason ?? "unsupported"}`);
}

describeDB("trust_levels schema", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trust-levels-");
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

  it("inserts trust level with defaults, enforces unique (agentId, actionType)", async () => {
    const [row1] = await db
      .insert(trustLevels)
      .values({
        agentId,
        actionType: "send_email",
      })
      .returning();

    expect(row1.level).toBe(0);
    expect(row1.approvedCount).toBe(0);
    expect(row1.rejectedCount).toBe(0);
    expect(row1.lowScoreCount).toBe(0);
    expect(row1.autoApproveEnabled).toBe(false);

    // Duplicate insert should fail
    await expect(
      db.insert(trustLevels).values({
        agentId,
        actionType: "send_email",
      })
    ).rejects.toThrow();
  });
});
