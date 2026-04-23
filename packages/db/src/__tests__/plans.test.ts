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
import { plans } from "../schema/plans.js";
import { approvals } from "../schema/approvals.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("plans schema", () => {
  it(
    "inserts a plan with defaults and cascades on company delete; approvals.planId links back",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("paperclip-plans-");
      cleanups.push(dbh.cleanup);
      const sql = postgres(dbh.connectionString);
      const db = drizzle(sql);
      await applyPendingMigrations(dbh.connectionString);

      const [company] = await db
        .insert(companies)
        .values({ name: "Develtech", issuePrefix: "DEV" })
        .returning();

      const [agent] = await db
        .insert(agents)
        .values({ companyId: company.id, name: "CEO", role: "ceo" })
        .returning();

      const [plan] = await db
        .insert(plans)
        .values({
          agentId: agent.id,
          companyId: company.id,
          kind: "create_issue",
          proposalText: "Create issue DEV-42 from inbound email",
        })
        .returning();

      expect(plan.id).toBeDefined();
      expect(plan.revision).toBe(1);
      expect(plan.decision).toBe("pending");
      expect(plan.executionStatus).toBe("pending");
      expect(plan.confidence).toBe("medium");

      // approvals.planId FK works
      const [approval] = await db
        .insert(approvals)
        .values({
          companyId: company.id,
          type: "plan",
          payload: { planId: plan.id },
          planId: plan.id,
        })
        .returning();

      expect(approval.planId).toBe(plan.id);

      // cascade delete rule is declared on the FK (cannot delete the row
      // end-to-end because agents.companyId blocks it with no-action).
      const rules = await sql<{ delete_rule: string }[]>`
        SELECT delete_rule FROM information_schema.referential_constraints
        WHERE constraint_name = 'plans_company_id_companies_id_fk'
      `;
      expect(rules[0]?.delete_rule).toBe("CASCADE");

      // approvals.plan_id FK is SET NULL on plan delete
      const approvalRules = await sql<{ delete_rule: string }[]>`
        SELECT delete_rule FROM information_schema.referential_constraints
        WHERE constraint_name = 'approvals_plan_id_plans_id_fk'
      `;
      expect(approvalRules[0]?.delete_rule).toBe("SET NULL");

      await sql.end();
    },
    20_000,
  );
});
