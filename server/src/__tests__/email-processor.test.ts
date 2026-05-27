import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  companies,
  createDb,
  emailAccounts,
  emailAttachments,
  emailMessages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { emailProcessorService } from "../services/email-processor.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping email-processor tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function buildMultipartFixture() {
  const boundary = "----testboundary123";
  const pdfBody = Buffer.from("%PDF-1.4 fake");
  const pngBody = Buffer.from("PNG-fake");
  const crlf = "\r\n";
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello attached",
    `--${boundary}`,
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    pdfBody.toString("base64"),
    `--${boundary}`,
    "Content-Type: image/png",
    'Content-Disposition: inline; filename="logo.png"',
    "Content-ID: <logo@test>",
    "Content-Transfer-Encoding: base64",
    "",
    pngBody.toString("base64"),
    `--${boundary}--`,
    "",
  ];
  const body = parts.join(crlf);
  const headers = [
    "From: client@example.com",
    "To: jayjay@develtech.co.za",
    "Subject: With attachments",
    "Message-ID: <fixture-1@test>",
    "Date: Thu, 24 Apr 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ].join(crlf);
  return Buffer.from(headers + body, "utf8");
}

describeEmbeddedPostgres("email-processor service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let attachmentRoot: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-email-processor-");
    db = createDb(tempDb.connectionString);
    attachmentRoot = mkdtempSync(path.join(tmpdir(), "paperclip-home-"));
    process.env.PAPERCLIP_HOME = attachmentRoot;
    process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL = "1";
  }, 20_000);

  afterEach(async () => {
    await db.delete(emailAttachments);
    await db.delete(emailMessages);
    await db.delete(emailAccounts);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    delete process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL;
    try { rmSync(attachmentRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    await tempDb?.cleanup();
  });

  it("parses message, inserts row, saves attachments to disk", async () => {
    const [company] = await db.insert(companies).values({ name: "Dev", issuePrefix: "DEV" }).returning();
    const [account] = await db
      .insert(emailAccounts)
      .values({
        companyId: company.id,
        label: "main",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUser: "jayjay@develtech.co.za",
        imapPasswordEnc: "enc:x",
        fromName: "Dev",
        fromEmail: "jayjay@develtech.co.za",
      })
      .returning();

    const processor = emailProcessorService(db);
    const result = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildMultipartFixture(),
    });

    expect(result.duplicated).toBe(false);
    expect(result.attachmentCount).toBe(2);

    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, result.emailMessageId));
    expect(msg.subject).toBe("With attachments");
    expect(msg.fromAddr).toBe("client@example.com");
    expect(msg.toAddrs).toEqual(["jayjay@develtech.co.za"]);
    expect(msg.attachmentsPath).toBe(msg.id);

    const attachments = await db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, msg.id));
    expect(attachments).toHaveLength(2);
    const pdf = attachments.find((a) => a.filename === "invoice.pdf");
    const png = attachments.find((a) => a.filename === "logo.png");
    expect(pdf?.contentType).toBe("application/pdf");
    expect(pdf?.isInline).toBe(false);
    expect(png?.isInline).toBe(true);
    expect(png?.contentId).toBe("logo@test");

    expect(existsSync(pdf!.storagePath)).toBe(true);
    expect(existsSync(png!.storagePath)).toBe(true);
    expect(readFileSync(pdf!.storagePath).toString()).toContain("%PDF-1.4");
  }, 60_000);

  it("returns duplicated=true on same Message-ID re-delivery", async () => {
    const [company] = await db.insert(companies).values({ name: "Dev", issuePrefix: "DEV" }).returning();
    const [account] = await db
      .insert(emailAccounts)
      .values({
        companyId: company.id,
        label: "main",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUser: "jayjay@develtech.co.za",
        imapPasswordEnc: "enc:x",
        fromName: "Dev",
        fromEmail: "jayjay@develtech.co.za",
      })
      .returning();

    const processor = emailProcessorService(db);
    const fixture = buildMultipartFixture();
    const first = await processor.processRawMessage({ emailAccountId: account.id, rawBytes: fixture });
    const second = await processor.processRawMessage({ emailAccountId: account.id, rawBytes: fixture });

    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(second.emailMessageId).toBe(first.emailMessageId);

    const count = await db.select().from(emailMessages);
    expect(count).toHaveLength(1);
  }, 60_000);
});
