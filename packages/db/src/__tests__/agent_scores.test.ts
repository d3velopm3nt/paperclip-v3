import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentScores, agents, authUsers, companies, createDb } from "../index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping agent_scores tests: ${support.reason ?? "unsupported"}`);
}

describeDB("agent_scores schema", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-scores-");
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

    const [user] = await db
      .insert(authUsers)
      .values({
        id: "user-" + Math.random(),
        name: "Scorer",
        email: "scorer@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: authUsers.id });
    userId = user!.id;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inserts agent score with 1-5 rating and optional comment", async () => {
    const [row] = await db
      .insert(agentScores)
      .values({
        agentId,
        scoredByUserId: userId,
        score: 4,
        comment: "Good work",
      })
      .returning();

    expect(row.agentId).toBe(agentId);
    expect(row.score).toBe(4);
    expect(row.comment).toBe("Good work");
    expect(row.issueId).toBeNull();
    expect(row.planId).toBeNull();
    expect(row.messageId).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
