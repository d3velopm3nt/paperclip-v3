import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, telegramBots } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { telegramService } from "../services/telegram.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping telegram service tests: ${support.reason ?? "unsupported"}`);
}

describeDB("telegramService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-service-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", ownerEmail: "test@example.com", issuePrefix: "TC" })
      .returning({ id: companies.id });
    companyId = company!.id;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("createBot encrypts token, returns bot with username", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      botUsername: "test_bot",
    });

    expect(bot.companyId).toBe(companyId);
    expect(bot.botUsername).toBe("test_bot");
    expect(bot.botTokenEnc).not.toBe("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    expect(bot.botTokenEnc.length).toBeGreaterThan(0);
    expect(bot.deliveryMode).toBe("longpoll");
    expect(bot.active).toBe(true);
  });

  it("listBots returns active bots for company", async () => {
    const svc = telegramService(db);

    await svc.createBot({
      companyId,
      botToken: "token1",
      botUsername: "bot1",
    });

    await svc.createBot({
      companyId,
      botToken: "token2",
      botUsername: "bot2",
    });

    const bots = await svc.listBots(companyId);
    expect(bots.length).toBeGreaterThanOrEqual(2);
  });

  it("deactivateBot marks bot inactive", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "token-deactivate",
      botUsername: "bot_deactivate",
    });

    await svc.deactivateBot(bot.id);

    const [updated] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));
    expect(updated.active).toBe(false);
  });
});
