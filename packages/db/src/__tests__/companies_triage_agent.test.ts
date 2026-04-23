import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { applyPendingMigrations } from "../client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";
import { companies } from "../schema/companies.js";
import { agents } from "../schema/agents.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("companies.triageAgentId", () => {
  it(
    "sets and reads triageAgentId fk on companies",
    async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("paperclip-triage-agent-");
    cleanups.push(dbh.cleanup);
    const sql = postgres(dbh.connectionString);
    const db = drizzle(sql);
    await applyPendingMigrations(dbh.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Develtech", issuePrefix: "DEV" })
      .returning();

    expect(company.triageAgentId).toBeNull();

    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "CEO",
        role: "ceo",
      })
      .returning();

    const [updated] = await db
      .update(companies)
      .set({ triageAgentId: agent.id })
      .where(eq(companies.id, company.id))
      .returning();

    expect(updated.triageAgentId).toBe(agent.id);

    await sql.end();
  },
    20_000,
  );
});
