import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, rooms, roomMembers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { roomService } from "../services/rooms.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("roomService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rooms-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE room_members, rooms, agents, companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Test Co", issuePrefix: "TC" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "CEO", role: "ceo", title: "CEO",
      adapterType: "claude-local", status: "active",
    }).returning();
    return { company: company!, agent: agent! };
  }

  it("creates a room and lists it", async () => {
    const { company } = await seed();
    const svc = roomService(db);
    const room = await svc.create(company.id, { name: "Dev Team", slug: "dev-team" });
    expect(room.name).toBe("Dev Team");
    expect(room.slug).toBe("dev-team");
    const list = await svc.list(company.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(room.id);
  });

  it("adds and removes members", async () => {
    const { company, agent } = await seed();
    const svc = roomService(db);
    const room = await svc.create(company.id, { name: "All Hands", slug: "all-hands" });
    await svc.addMember(room.id, { agentId: agent.id });
    const detail = await svc.getById(room.id);
    expect(detail!.members).toHaveLength(1);
    expect(detail!.members[0]!.agentId).toBe(agent.id);
    await svc.removeMember(detail!.members[0]!.id);
    const after = await svc.getById(room.id);
    expect(after!.members).toHaveLength(0);
  });

  it("resolves room by company + slug", async () => {
    const { company } = await seed();
    const svc = roomService(db);
    await svc.create(company.id, { name: "Dev Team", slug: "dev-team" });
    const found = await svc.findBySlug(company.id, "dev-team");
    expect(found).not.toBeNull();
    expect(found!.slug).toBe("dev-team");
  });
});
