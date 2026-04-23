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
import { emailAccounts } from "../schema/email_accounts.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("email_accounts schema", () => {
  it("inserts and reads an email account scoped to a company", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("paperclip-email-accounts-");
    cleanups.push(dbh.cleanup);
    const sql = postgres(dbh.connectionString);
    const db = drizzle(sql);
    await applyPendingMigrations(dbh.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Develtech", issuePrefix: "DEV" })
      .returning();

    const [account] = await db
      .insert(emailAccounts)
      .values({
        companyId: company.id,
        label: "main",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUser: "jayjay@develtech.co.za",
        imapPasswordEnc: "enc:placeholder",
        fromName: "Develtech",
        fromEmail: "jayjay@develtech.co.za",
      })
      .returning();

    expect(account.id).toBeDefined();
    expect(account.companyId).toBe(company.id);
    expect(account.active).toBe(true);
    expect(account.pollIntervalSec).toBe(60);
    expect(account.imapTls).toBe(true);
    expect(account.folder).toBe("INBOX");

    const rows = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.companyId, company.id));
    expect(rows).toHaveLength(1);

    await sql.end();
  });
});
