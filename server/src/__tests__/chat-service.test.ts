import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, chatThreads, companies, createDb, operatorMessages } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { chatService } from "../services/chat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDB = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping chat service tests: ${support.reason ?? "unsupported"}`);
}

describeDB("chatService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof chatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-service-");
    db = createDb(tempDb.connectionString);
    svc = chatService(db);
    const [co] = await db
      .insert(companies)
      .values({ name: "Test Co" })
      .returning({ id: companies.id });
    companyId = co!.id;
  }, 20_000);

  afterEach(async () => {
    await db.delete(operatorMessages);
    await db.delete(chatThreads);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("getOrCreateDispatcherThread creates on first call, returns same on second", async () => {
    const t1 = await svc.getOrCreateDispatcherThread(companyId);
    const t2 = await svc.getOrCreateDispatcherThread(companyId);
    expect(t1.id).toBe(t2.id);
    expect(t1.agentId).toBeNull();
    expect(t1.name).toBe("Dispatcher");
  });

  it("listThreads returns dispatcher thread in results", async () => {
    await svc.getOrCreateDispatcherThread(companyId);
    const threads = await svc.listThreads(companyId);
    expect(threads.length).toBeGreaterThanOrEqual(1);
    expect(threads[0]!.name).toBe("Dispatcher");
  });

  it("listMessages returns empty array when no messages", async () => {
    const thread = await svc.getOrCreateDispatcherThread(companyId);
    const msgs = await svc.listMessages(companyId, thread.id);
    expect(msgs).toEqual([]);
  });
});
