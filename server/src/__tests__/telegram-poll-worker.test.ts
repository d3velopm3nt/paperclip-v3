import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { companies, createDb, telegramBots } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { startTelegramPollWorker } from "../workers/telegram-poll.js";
import { telegramService } from "../services/telegram.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping telegram poll worker tests: ${support.reason ?? "unsupported"}`);
}

describeDB("telegram poll worker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-poll-worker-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", ownerEmail: "test@example.com", issuePrefix: "TC" })
      .returning({ id: companies.id });
    companyId = company!.id;
  }, 20_000);

  afterEach(async () => {
    await db.update(telegramBots).set({ active: false });
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.restoreAllMocks();
  });

  it("starts poller for active longpoll bots", async () => {
    const svc = telegramService(db);

    // Create active longpoll bot
    await svc.createBot({
      companyId,
      botToken: "test-token-123",
      botUsername: "testbot",
      deliveryMode: "longpoll",
    });

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const worker = startTelegramPollWorker({ db, reconcileIntervalMs: 100 });

    // Wait for first reconcile + poll
    await new Promise((r) => setTimeout(r, 200));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("getUpdates"),
      expect.any(Object),
    );

    worker.stop();
  });

  it("stops poller when bot deactivated", async () => {
    const svc = telegramService(db);

    const bot = await svc.createBot({
      companyId,
      botToken: "test-token-456",
      botUsername: "testbot2",
      deliveryMode: "longpoll",
    });

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const worker = startTelegramPollWorker({ db, reconcileIntervalMs: 100 });
    await new Promise((r) => setTimeout(r, 150));

    const callsBefore = mockFetch.mock.calls.length;

    // Deactivate bot
    await svc.deactivateBot(bot.id);

    // Wait for reconcile
    await new Promise((r) => setTimeout(r, 200));

    // No new calls after deactivation
    expect(mockFetch.mock.calls.length).toBe(callsBefore);

    worker.stop();
  });

  it("does not start poller for webhook bots", async () => {
    const svc = telegramService(db);

    await svc.createBot({
      companyId,
      botToken: "test-token-789",
      botUsername: "webhookbot",
      deliveryMode: "webhook",
    });

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const worker = startTelegramPollWorker({ db, reconcileIntervalMs: 100 });
    await new Promise((r) => setTimeout(r, 150));

    expect(mockFetch).not.toHaveBeenCalled();

    worker.stop();
  });
});
