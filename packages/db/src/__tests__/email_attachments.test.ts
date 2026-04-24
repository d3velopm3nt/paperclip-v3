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
import { emailAttachments } from "../schema/email_attachments.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("email_attachments schema", () => {
  it(
    "inserts attachments and cascades on message delete",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("paperclip-email-attachments-");
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
          messageIdHeader: "<m1@example.com>",
          fromAddr: "client@example.com",
          toAddrs: ["jayjay@develtech.co.za"],
          subject: "With attachments",
          body: "See attached",
          receivedAt: new Date(),
        })
        .returning();

      await db
        .insert(emailAttachments)
        .values([
          {
            emailMessageId: msg.id,
            filename: "invoice.pdf",
            contentType: "application/pdf",
            sizeBytes: 12345,
            storagePath: "/tmp/a/invoice.pdf",
          },
          {
            emailMessageId: msg.id,
            filename: "logo.png",
            contentType: "image/png",
            contentId: "<logo@example.com>",
            isInline: true,
            sizeBytes: 678,
            storagePath: "/tmp/a/logo.png",
          },
        ]);

      const attachments = await db
        .select()
        .from(emailAttachments)
        .where(eq(emailAttachments.emailMessageId, msg.id));
      expect(attachments).toHaveLength(2);
      const inline = attachments.find((a) => a.isInline);
      expect(inline?.filename).toBe("logo.png");
      expect(inline?.contentId).toBe("<logo@example.com>");

      // cascade on message delete
      await db.delete(emailMessages).where(eq(emailMessages.id, msg.id));
      const after = await db
        .select()
        .from(emailAttachments)
        .where(eq(emailAttachments.emailMessageId, msg.id));
      expect(after).toHaveLength(0);

      await sql.end();
    },
    20_000,
  );
});
