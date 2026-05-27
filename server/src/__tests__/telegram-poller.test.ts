import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  console.warn(`Skipping telegram poller tests: ${support.reason ?? "unsupported"}`);
}

// Mock fetch for Telegram API
global.fetch = vi.fn();

describeDB("telegram poller", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-poller-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", ownerEmail: "test@example.com", issuePrefix: "TC" })
      .returning({ id: companies.id });
    companyId = company!.id;
  }, 20_000);

  afterEach(async () => {
    // Deactivate all bots to isolate tests
    await db.update(telegramBots).set({ active: false });
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.restoreAllMocks();
  });

  it("polls active longpoll bot and updates lastPolledAt and lastOffset", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "123456:test-token",
      botUsername: "test_bot",
      deliveryMode: "longpoll",
    });

    // Mock Telegram getUpdates response
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 1,
              from: { id: 123, first_name: "Test" },
              chat: { id: 123, type: "private" },
              date: Math.floor(Date.now() / 1000),
              text: "/start",
            },
          },
        ],
      }),
    } as Response);

    await pollTelegramUpdates(db);

    const [updated] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));
    expect(updated.lastPolledAt).not.toBeNull();
    expect(updated.lastOffset).toBe(100); // stores highest update_id seen
  });

  it("skips inactive bots", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "inactive-token",
      botUsername: "inactive_bot",
      deliveryMode: "longpoll",
    });

    await svc.deactivateBot(bot.id);

    await pollTelegramUpdates(db);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles API errors gracefully", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "error-token",
      botUsername: "error_bot",
      deliveryMode: "longpoll",
    });

    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    await expect(pollTelegramUpdates(db)).resolves.not.toThrow();

    const [updated] = await db.select().from(telegramBots).where(eq(telegramBots.id, bot.id));
    expect(updated.lastErrorText).toContain("Network error");
  });
});
