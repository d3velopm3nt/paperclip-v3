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
import { actionPolicies } from "../schema/action_policies.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("action_policies schema", () => {
  it(
    "inserts a policy per company and enforces uniqueness on (companyId, actionType)",
    async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("paperclip-action-policies-");
    cleanups.push(dbh.cleanup);
    const sql = postgres(dbh.connectionString);
    const db = drizzle(sql);
    await applyPendingMigrations(dbh.connectionString);

    const [company] = await db.insert(companies).values({ name: "Develtech", issuePrefix: "DEV" }).returning();

    const [policy] = await db
      .insert(actionPolicies)
      .values({
        companyId: company.id,
        actionType: "send_email",
        requiresApproval: true,
        immediateEmail: false,
      })
      .returning();

    expect(policy.requiresApproval).toBe(true);

    // Uniqueness: second insert for same (company, actionType) must fail
    await expect(
      db
        .insert(actionPolicies)
        .values({
          companyId: company.id,
          actionType: "send_email",
          requiresApproval: false,
        })
        .returning(),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(actionPolicies)
      .where(eq(actionPolicies.companyId, company.id));
    expect(rows).toHaveLength(1);

    await sql.end();
  },
    20_000,
  );
});
