import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { companies, agents, emailAccounts, emailMessages, emailLabelDefinitions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpToolServerRoutes } from "../routes/mcp-tool-server.js";
import { signMcpToken } from "../services/mcp-session-token.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping mcp-email-label-gates tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("MCP email label gates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let agentToken!: string;
  let operatorToken!: string;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-label-gates-");
    db = createDb(tempDb.connectionString);

    const [co] = await db.insert(companies).values({ name: "Test Co", issuePrefix: "TC" }).returning();
    companyId = co!.id;
    const [ag] = await db
      .insert(agents)
      .values({ companyId, name: "EA", adapterType: "ea", status: "idle" })
      .returning();

    agentToken = signMcpToken({ companyId, agentId: ag!.id, isOperator: false });
    operatorToken = signMcpToken({ companyId, agentId: ag!.id, isOperator: true });

    app = express();
    app.use(express.json());
    app.use("/api", mcpToolServerRoutes(db));
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function callTool(token: string, name: string, args: Record<string, unknown>) {
    return request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  }

  describe("create_issue guard", () => {
    it("returns error when isOperator=false", async () => {
      const res = await callTool(agentToken, "create_issue", { title: "Test issue" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/operator authorization/i);
    });

    it("succeeds when isOperator=true", async () => {
      const res = await callTool(operatorToken, "create_issue", { title: "Operator-created issue", companyId });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).not.toMatch(/^Error:/i);
      expect(JSON.parse(text)).toMatchObject({ title: "Operator-created issue" });
    });
  });

  describe("create_client guard", () => {
    it("returns error when isOperator=false", async () => {
      const res = await callTool(agentToken, "create_client", { name: "Acme Corp" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/operator authorization/i);
    });
  });

  describe("create_project guard", () => {
    it("returns error when isOperator=false", async () => {
      const res = await callTool(agentToken, "create_project", { name: "New Project" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      expect(text).toMatch(/operator authorization/i);
    });
  });

  describe("label_email tool", () => {
    let emailMessageId: string;

    beforeAll(async () => {
      const [acct] = await db.insert(emailAccounts).values({
        companyId,
        fromEmail: "inbox@test.com",
        fromName: "Test Inbox",
        label: "Test Inbox",
        role: "inbound",
        imapHost: "imap.test.com",
        imapPort: 993,
        imapUser: "inbox@test.com",
        imapPasswordEnc: "enc-pass",
      }).returning();
      const [msg] = await db.insert(emailMessages).values({
        emailAccountId: acct!.id,
        messageIdHeader: "<test-label@example.com>",
        fromAddr: "sender@spammer.com",
        toAddrs: ["inbox@test.com"],
        subject: "Spam email",
        body: "Buy now!",
        receivedAt: new Date(),
        processingState: "pending",
      }).returning();
      emailMessageId = msg!.id;

      await db.insert(emailLabelDefinitions).values({
        companyId,
        name: "spam",
        color: "#e74c3c",
      });
    });

    it("sets label and processingState=ignored on the email", async () => {
      const res = await callTool(agentToken, "label_email", { emailId: emailMessageId, label: "spam" });
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.result.content[0].text as string);
      expect(parsed.success).toBe(true);
      expect(parsed.label).toBe("spam");
      expect(parsed.senderDomain).toBe("spammer.com");

      const [row] = await db
        .select({ label: emailMessages.label, processingState: emailMessages.processingState })
        .from(emailMessages)
        .where(eq(emailMessages.id, emailMessageId))
        .limit(1);
      expect(row?.label).toBe("spam");
      expect(row?.processingState).toBe("ignored");
    });

    it("returns error for non-existent email", async () => {
      const res = await callTool(agentToken, "label_email", { emailId: "00000000-0000-0000-0000-000000000000", label: "spam" });
      expect(res.status).toBe(200);
      expect(res.body.result.content[0].text).toMatch(/not found/i);
    });
  });
});
