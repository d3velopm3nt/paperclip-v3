import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { companies, agents, clients } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpToolServerRoutes } from "../routes/mcp-tool-server.js";
import { signMcpToken } from "../services/mcp-session-token.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping mcp-storage-tools tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("MCP storage tools", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let token!: string;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-storage-");
    db = createDb(tempDb.connectionString);

    const [co] = await db.insert(companies).values({ name: "Test Co" }).returning();
    companyId = co!.id;
    const [ag] = await db
      .insert(agents)
      .values({ companyId, name: "EA", adapterType: "ea", status: "idle" })
      .returning();
    token = signMcpToken({ companyId, agentId: ag!.id });

    app = express();
    app.use(express.json());
    app.use("/api", mcpToolServerRoutes(db));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function callTool(name: string, args: Record<string, unknown>) {
    return request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  }

  describe("set_storage_root", () => {
    it("sets localPath on the company row", async () => {
      const res = await callTool("set_storage_root", { localPath: "/tmp/test-storage" });
      expect(res.status).toBe(200);
      const text = res.body.result.content[0].text as string;
      const result = JSON.parse(text);
      expect(result.localPath).toBe("/tmp/test-storage");

      const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
      expect(co?.storageLocalPath).toBe("/tmp/test-storage");
    });

    it("clears localPath when both omitted", async () => {
      const res = await callTool("set_storage_root", {});
      expect(res.status).toBe(200);
      const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
      expect(co?.storageLocalPath).toBeNull();
    });
  });

  describe("ensure_client_folder", () => {
    it("no-ops when no storage root configured", async () => {
      const [client] = await db.insert(clients).values({ companyId, name: "Acme" }).returning();
      const res = await callTool("ensure_client_folder", { clientId: client!.id });
      expect(res.status).toBe(200);
      expect(res.body.result.content[0].text).toContain("ensured");
    });

    it("is idempotent when called twice", async () => {
      await callTool("set_storage_root", { localPath: "/tmp/test-storage" });
      const [client] = await db
        .insert(clients)
        .values({ companyId, name: "Beta Corp", emailDomain: "beta.com" })
        .returning();
      const first = await callTool("ensure_client_folder", { clientId: client!.id });
      const second = await callTool("ensure_client_folder", { clientId: client!.id });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });
  });

  describe("ensure_project_folder", () => {
    it("no-ops when project not found", async () => {
      const res = await callTool("ensure_project_folder", {
        projectId: "00000000-0000-4000-8000-000000000001",
      });
      expect(res.status).toBe(200);
      expect(res.body.result.content[0].text).toContain("ensured");
    });
  });
});
