import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, telegramBots } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { telegramService } from "../services/telegram.js";
import { pollTelegramUpdates } from "../services/telegram-poller.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping E2E telegram tests: ${support.reason ?? "unsupported"}`);
}

// Mock fetch for Telegram API
global.fetch = vi.fn();

describeDB("E2E: telegram bot lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-e2e-telegram-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "E2E Test Co", ownerEmail: "e2e@example.com", issuePrefix: "E2E" })
      .returning({ id: companies.id });
    companyId = company!.id;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.restoreAllMocks();
  });

  it("full flow: create bot → configure longpoll → poll updates → process", async () => {
    const svc = telegramService(db);

    // Step 1: Create bot
    const bot = await svc.createBot({
      companyId,
      botToken: "e2e-token",
      botUsername: "e2e_bot",
      deliveryMode: "longpoll",
    });

    expect(bot.active).toBe(true);
    expect(bot.deliveryMode).toBe("longpoll");
    expect(bot.botTokenEnc).toBeTruthy();
    expect(bot.botTokenEnc).not.toBe("e2e-token"); // encrypted

    // Step 2: Mock Telegram API response
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 1000,
            message: {
              message_id: 50,
              from: { id: 111, first_name: "E2E User", username: "e2e_user" },
              chat: { id: 111, type: "private" },
              date: Math.floor(Date.now() / 1000),
              text: "/start",
            },
          },
          {
            update_id: 1001,
            message: {
              message_id: 51,
              from: { id: 111, first_name: "E2E User", username: "e2e_user" },
              chat: { id: 111, type: "private" },
              date: Math.floor(Date.now() / 1000),
              text: "Hello bot!",
            },
          },
        ],
      }),
    } as Response);

    // Step 3: Poll for updates
    await pollTelegramUpdates(db);

    // Step 4: Verify bot state updated
    const [updatedBot] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));

    expect(updatedBot.lastPolledAt).not.toBeNull();
    expect(updatedBot.lastOffset).toBe(1001); // highest update_id
    expect(updatedBot.lastErrorText).toBeNull();

    // Step 5: Deactivate bot
    await svc.deactivateBot(bot.id);

    const [deactivatedBot] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));
    expect(deactivatedBot.active).toBe(false);

    // Step 6: Verify polling skips deactivated bot
    vi.mocked(fetch).mockClear();
    await pollTelegramUpdates(db);

    expect(fetch).not.toHaveBeenCalled(); // no API calls for inactive bot
  });

  it("error recovery: API failure → error logged → bot continues", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "error-recovery-token",
      botUsername: "error_bot",
      deliveryMode: "longpoll",
    });

    // Mock API failure
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Telegram API down"));

    await pollTelegramUpdates(db);

    // Error logged but doesn't crash
    const [botAfterError] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));
    expect(botAfterError.lastErrorText).toContain("Telegram API down");

    // Mock successful recovery
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: [] }),
    } as Response);

    await pollTelegramUpdates(db);

    const [botAfterRecovery] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));
    expect(botAfterRecovery.lastErrorText).toBeNull(); // error cleared
    expect(botAfterRecovery.lastPolledAt).not.toBeNull();
  });
});
