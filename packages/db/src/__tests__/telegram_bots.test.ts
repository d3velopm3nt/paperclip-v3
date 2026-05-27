import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, telegramBots } from "../index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping telegram_bots tests: ${support.reason ?? "unsupported"}`);
}

describeDB("telegram_bots schema", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-bots-");
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

  it("inserts bot with defaults, allows global bot (null companyId)", async () => {
    // Company-scoped bot
    const [bot1] = await db
      .insert(telegramBots)
      .values({
        companyId,
        botTokenEnc: "encrypted-token-123",
        botUsername: "test_bot",
      })
      .returning();

    expect(bot1.companyId).toBe(companyId);
    expect(bot1.deliveryMode).toBe("longpoll");
    expect(bot1.active).toBe(true);
    expect(bot1.allowlist).toEqual([]);

    // Global bot (null companyId)
    const [bot2] = await db
      .insert(telegramBots)
      .values({
        companyId: null,
        botTokenEnc: "encrypted-token-456",
        botUsername: "global_bot",
      })
      .returning();

    expect(bot2.companyId).toBeNull();
  });

  it("cascades delete when company deleted", async () => {
    const [company2] = await db
      .insert(companies)
      .values({ name: "Test Co 2", ownerEmail: "test2@example.com", issuePrefix: "TC2" })
      .returning({ id: companies.id });

    await db.insert(telegramBots).values({
      companyId: company2.id,
      botTokenEnc: "encrypted",
      botUsername: "bot2",
    });

    await db.delete(companies).where(eq(companies.id, company2.id));

    const bots = await db.select().from(telegramBots).where(eq(telegramBots.companyId, company2.id));
    expect(bots).toHaveLength(0);
  });
});
