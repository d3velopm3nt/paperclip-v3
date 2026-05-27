import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { eq } from "drizzle-orm";
import { companies, createDb, telegramBots } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { telegramBotRoutes } from "../routes/telegram-bots.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping telegram routes tests: ${support.reason ?? "unsupported"}`);
}

// Mock auth middleware - sets req.actor
function mockAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).actor = {
    type: "board",
    source: "local_implicit",
    userId: "test-user-id",
    isInstanceAdmin: true,
  };
  next();
}

describeDB("telegram bot routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: express.Application;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-routes-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", ownerEmail: "test@example.com", issuePrefix: "TC" })
      .returning({ id: companies.id });
    companyId = company!.id;

    app = express();
    app.use(express.json());
    app.use(mockAuth);
    app.use("/api", telegramBotRoutes(db));
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("POST /api/companies/:companyId/telegram-bots creates bot", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots`)
      .send({
        botToken: "123456:test-bot-token",
        botUsername: "test_bot",
        deliveryMode: "longpoll",
      });

    expect(res.status).toBe(201);
    expect(res.body.botUsername).toBe("test_bot");
    expect(res.body.deliveryMode).toBe("longpoll");
    expect(res.body.botTokenEnc).toBeUndefined(); // should not expose encrypted token
  });

  it("GET /api/companies/:companyId/telegram-bots lists bots", async () => {
    // Create a bot first
    await request(app)
      .post(`/api/companies/${companyId}/telegram-bots`)
      .send({
        botToken: "token2",
        botUsername: "bot2",
      });

    const res = await request(app).get(`/api/companies/${companyId}/telegram-bots`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/telegram-bots/:id returns bot", async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots`)
      .send({
        botToken: "token3",
        botUsername: "bot3",
      });

    const botId = createRes.body.id;

    const res = await request(app).get(`/api/telegram-bots/${botId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(botId);
    expect(res.body.botUsername).toBe("bot3");
  });

  it("DELETE /api/telegram-bots/:id deactivates bot", async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots`)
      .send({
        botToken: "token4",
        botUsername: "bot4",
      });

    const botId = createRes.body.id;

    const deleteRes = await request(app).delete(`/api/telegram-bots/${botId}`);

    expect(deleteRes.status).toBe(204);

    // Verify bot is deactivated
    const [bot] = await db.select().from(telegramBots).where(eq(telegramBots.id, botId)).limit(1);
    expect(bot?.active).toBe(false);
  });

  it("returns 404 for non-existent bot", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request(app).get(`/api/telegram-bots/${fakeId}`);
    expect(res.status).toBe(404);
  });
});
