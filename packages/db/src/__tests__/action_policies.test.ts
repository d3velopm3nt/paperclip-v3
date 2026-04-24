import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
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
    "inserts scoped policies and enforces uniqueness on (scope, scopeRefId, actionType)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("paperclip-action-policies-");
      cleanups.push(dbh.cleanup);
      const sql = postgres(dbh.connectionString);
      const db = drizzle(sql);
      await applyPendingMigrations(dbh.connectionString);

      const [company] = await db
        .insert(companies)
        .values({ name: "Develtech", issuePrefix: "DEV" })
        .returning();

      const [policy] = await db
        .insert(actionPolicies)
        .values({
          companyId: company.id,
          scope: "company",
          scopeRefId: company.id,
          actionType: "send_email",
          requiresApproval: true,
          immediateEmail: false,
        })
        .returning();

      expect(policy.requiresApproval).toBe(true);
      expect(policy.scope).toBe("company");

      // Duplicate (scope, scopeRefId, actionType) must fail.
      await expect(
        db
          .insert(actionPolicies)
          .values({
            companyId: company.id,
            scope: "company",
            scopeRefId: company.id,
            actionType: "send_email",
            requiresApproval: false,
          })
          .returning(),
      ).rejects.toThrow();

      // Same actionType at a different scope is allowed.
      const differentScopeRef = "00000000-0000-0000-0000-000000000001";
      const [clientScoped] = await db
        .insert(actionPolicies)
        .values({
          companyId: company.id,
          scope: "client",
          scopeRefId: differentScopeRef,
          actionType: "send_email",
          requiresApproval: false,
        })
        .returning();
      expect(clientScoped.scope).toBe("client");

      const rows = await db
        .select()
        .from(actionPolicies)
        .where(and(eq(actionPolicies.companyId, company.id), eq(actionPolicies.actionType, "send_email")));
      expect(rows).toHaveLength(2);

      await sql.end();
    },
    20_000,
  );
});
