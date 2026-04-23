import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("v3 migrations end-to-end", () => {
  it("applies all migrations cleanly on a fresh database and creates expected tables", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("paperclip-v3-migrations-");
    cleanups.push(dbh.cleanup);
    const sql = postgres(dbh.connectionString);
    const db = drizzle(sql);

    await applyPendingMigrations(dbh.connectionString);

    const tableNames = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `.then((rows) => rows.map((r) => r.table_name));

    // All v3 tables must exist
    expect(tableNames).toContain("email_accounts");
    expect(tableNames).toContain("email_messages");
    expect(tableNames).toContain("action_policies");

    // Existing upstream tables must also exist (no regression)
    expect(tableNames).toContain("companies");
    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("approvals");
    expect(tableNames).toContain("issues");

    // companies must now have triage_agent_id column
    const companyCols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companies'
    `.then((rows) => rows.map((r) => r.column_name));
    expect(companyCols).toContain("triage_agent_id");

    // FK constraint for companies.triage_agent_id must exist
    const fks = await sql<{ constraint_name: string }[]>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'companies' AND constraint_type = 'FOREIGN KEY'
    `.then((rows) => rows.map((r) => r.constraint_name));
    expect(fks).toContain("companies_triage_agent_id_agents_id_fk");

    await sql.end();
  });
});
