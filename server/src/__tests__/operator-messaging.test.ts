import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  issues,
  operatorMessages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { operatorMessagingService } from "../services/operator-messaging.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("operatorMessagingService.parseMentions", () => {
  it("extracts agent names and room slugs from text", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-om-parse-");
    const db = createDb(tempDb.connectionString);
    const svc = operatorMessagingService(db);
    const result = svc.parseMentions("Hey @ceo-agent and @dev-team please look at this");
    expect(result.agentNames).toContain("ceo-agent");
    expect(result.roomSlugs).toContain("dev-team");
    await tempDb.cleanup();
  });
});

describeEmbeddedPostgres("operatorMessagingService.handleInbound — auto-route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-om-inbound-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC = "1";
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE
      message_threads, operator_messages, room_members, rooms,
      issue_comments, issues, agent_wakeup_requests, email_accounts,
      agents, companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    delete process.env.PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC;
    await tempDb?.cleanup();
  });

  it("auto-routes to CEO when no mention found", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Co", issuePrefix: "CO" })
      .returning();
    const [ceo] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "CEO",
        role: "ceo",
      })
      .returning();

    const svc = operatorMessagingService(db);
    await svc.handleInbound(company!.id, "voice-id", {
      platform: "email",
      from: "op@test.co",
      body: "Can you check the latest build?",
      raw: {},
    });

    const msgs = await db.select().from(operatorMessages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.direction).toBe("inbound");

    const created = await db.select().from(issues);
    expect(created).toHaveLength(1);
    expect(created[0]!.assigneeAgentId).toBe(ceo!.id);
  });
});
