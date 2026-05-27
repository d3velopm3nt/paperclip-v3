import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authUsers, createDb, telegramBindings } from "../index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping telegram_bindings tests: ${support.reason ?? "unsupported"}`);
}

describeDB("telegram_bindings schema", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-bindings-");
    db = createDb(tempDb.connectionString);

    const [user] = await db
      .insert(authUsers)
      .values({
        id: "user-" + Math.random(),
        name: "Test User",
        email: "test@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: authUsers.id });
    userId = user!.id;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inserts telegram binding with pairing token, marks paired", async () => {
    const [binding] = await db
      .insert(telegramBindings)
      .values({
        telegramUserId: "123456789",
        telegramUsername: "testuser",
        appUserId: userId,
        pairingToken: "ABC123",
        pairingExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .returning();

    expect(binding.telegramUserId).toBe("123456789");
    expect(binding.appUserId).toBe(userId);
    expect(binding.pairingToken).toBe("ABC123");
    expect(binding.active).toBe(true);
    expect(binding.pairedAt).toBeNull();

    // Mark as paired
    await db
      .update(telegramBindings)
      .set({ pairedAt: new Date(), pairingToken: null })
      .where(eq(telegramBindings.id, binding.id));

    const [updated] = await db
      .select()
      .from(telegramBindings)
      .where(eq(telegramBindings.id, binding.id));

    expect(updated.pairedAt).toBeInstanceOf(Date);
    expect(updated.pairingToken).toBeNull();
  });
});
