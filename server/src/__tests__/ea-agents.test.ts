import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { eaAgentsService } from "../services/ea-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping ecc-agents tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("eaAgentsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof eaAgentsService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ecc-agents-");
    db = createDb(tempDb.connectionString);
    svc = eaAgentsService(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("seeds two ECC agents if none exist", async () => {
    await svc.seedEaAgents();
    const agents = await svc.listEaAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name)).toEqual(
      expect.arrayContaining(["Executive Control Agent", "Client Control Agent"]),
    );
  });

  it("seed is idempotent", async () => {
    await svc.seedEaAgents();
    await svc.seedEaAgents();
    const agents = await svc.listEaAgents();
    expect(agents).toHaveLength(2);
  });

  it("getEccAgent returns correct agent by role", async () => {
    const exec = await svc.getEaAgent("operator");
    const client = await svc.getEaAgent("client");
    expect(exec?.name).toBe("Executive Control Agent");
    expect(client?.name).toBe("Client Control Agent");
  });

  it("setProcessing updates status and metadata", async () => {
    const exec = await svc.getEaAgent("operator");
    await svc.setProcessing(exec!.id, "topic-id-123", "Rockdog Pipeline", "Can we push...");
    const updated = await svc.getEaAgent("operator");
    expect(updated?.status).toBe("processing");
    expect((updated?.metadata as Record<string, unknown>)?.currentTopicName).toBe("Rockdog Pipeline");
  });

  it("setIdle clears metadata and updates lastHeartbeatAt", async () => {
    const exec = await svc.getEaAgent("operator");
    await svc.setIdle(exec!.id);
    const updated = await svc.getEaAgent("operator");
    expect(updated?.status).toBe("idle");
    expect(updated?.metadata).toEqual({});
    expect(updated?.lastHeartbeatAt).not.toBeNull();
  });
});
