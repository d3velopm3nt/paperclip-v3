import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { telegramService } from "../services/telegram.js";
import { telegramWebhookRoutes } from "../routes/telegram-webhook.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping telegram webhook tests: ${support.reason ?? "unsupported"}`);
}

describeDB("telegram webhook", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: express.Application;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-webhook-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", ownerEmail: "test@example.com", issuePrefix: "TC" })
      .returning({ id: companies.id });
    companyId = company!.id;

    app = express();
    app.use(express.json());
    app.use("/webhook", telegramWebhookRoutes(db));
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("receives webhook update for configured bot", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "webhook-token",
      botUsername: "webhook_bot",
      deliveryMode: "webhook",
      webhookSecret: "test-secret",
    });

    const update = {
      update_id: 200,
      message: {
        message_id: 1,
        from: { id: 456, first_name: "User" },
        chat: { id: 456, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/help",
      },
    };

    const res = await request(app)
      .post(`/webhook/telegram/${bot.id}`)
      .set("X-Telegram-Bot-Api-Secret-Token", "test-secret")
      .send(update);

    expect(res.status).toBe(200);
  });

  it("rejects webhook with wrong secret", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "secret-bot-token",
      botUsername: "secret_bot",
      deliveryMode: "webhook",
      webhookSecret: "correct-secret",
    });

    const update = {
      update_id: 201,
      message: {
        message_id: 2,
        from: { id: 789, first_name: "Hacker" },
        chat: { id: 789, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/attack",
      },
    };

    const res = await request(app)
      .post(`/webhook/telegram/${bot.id}`)
      .set("X-Telegram-Bot-Api-Secret-Token", "wrong-secret")
      .send(update);

    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent bot", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";

    const res = await request(app)
      .post(`/webhook/telegram/${fakeId}`)
      .send({ update_id: 999 });

    expect(res.status).toBe(404);
  });
});
