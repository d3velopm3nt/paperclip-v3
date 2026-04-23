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
import { emailMessages } from "../schema/email_messages.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("email_messages schema", () => {
  it(
    "inserts a message tied to an account and dedups on (account, message_id_header)",
    async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("paperclip-email-messages-");
    cleanups.push(dbh.cleanup);
    const sql = postgres(dbh.connectionString);
    const db = drizzle(sql);
    await applyPendingMigrations(dbh.connectionString);

    const [company] = await db.insert(companies).values({ name: "Develtech", issuePrefix: "DEV" }).returning();
    const [account] = await db
      .insert(emailAccounts)
      .values({
        companyId: company.id,
        label: "main",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUser: "jayjay@develtech.co.za",
        imapPasswordEnc: "enc:x",
        fromName: "Develtech",
        fromEmail: "jayjay@develtech.co.za",
      })
      .returning();

    const [msg] = await db
      .insert(emailMessages)
      .values({
        emailAccountId: account.id,
        messageIdHeader: "<abc@example.com>",
        fromAddr: "client@example.com",
        toAddrs: ["jayjay@develtech.co.za"],
        subject: "Hello",
        body: "Test",
        receivedAt: new Date(),
      })
      .returning();

    expect(msg.id).toBeDefined();
    expect(msg.processingState).toBe("pending");

    // Dedup: inserting same (account, header) must fail
    await expect(
      db
        .insert(emailMessages)
        .values({
          emailAccountId: account.id,
          messageIdHeader: "<abc@example.com>",
          fromAddr: "client@example.com",
          toAddrs: ["jayjay@develtech.co.za"],
          subject: "Hello again",
          body: "Dup",
          receivedAt: new Date(),
        })
        .returning(),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.emailAccountId, account.id));
    expect(rows).toHaveLength(1);

    await sql.end();
  },
    20_000,
  );
});
