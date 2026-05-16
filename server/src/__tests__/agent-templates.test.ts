import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentTemplates, companies, agents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentTemplatesService } from "../services/agent-templates.ts";
import { eq } from "drizzle-orm";
import type { AgentTemplateDefinition } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agentTemplatesService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-templates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(agentTemplates);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const svc = () => agentTemplatesService(db as any);

  it("seedAgentTemplates creates the dev-team built-in row", async () => {
    await svc().seedAgentTemplates();
    const rows = await db.select().from(agentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("dev-team");
    expect(rows[0].sourceType).toBe("built_in");
    const defs = rows[0].agentDefinitions as Record<string, unknown>[];
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.tempId)).toEqual(["tech-lead", "fullstack-dev", "qa-agent"]);
  }, 20_000);

  it("seedAgentTemplates is idempotent", async () => {
    await svc().seedAgentTemplates();
    await svc().seedAgentTemplates();
    const rows = await db.select().from(agentTemplates);
    expect(rows).toHaveLength(1);
  }, 20_000);

  it("seedAgentTemplates skips update when metadata.customized is true", async () => {
    await svc().seedAgentTemplates();
    await db
      .update(agentTemplates)
      .set({ metadata: { customized: true, version: 1 }, name: "My Custom Dev Team" });
    await svc().seedAgentTemplates();
    const rows = await db.select().from(agentTemplates);
    expect(rows[0].name).toBe("My Custom Dev Team");
  }, 20_000);

  it("deployTemplate creates agents with correct names and companyId", async () => {
    await svc().seedAgentTemplates();
    const [template] = await db.select().from(agentTemplates).where(eq(agentTemplates.slug, "dev-team"));
    const [co] = await db.insert(companies).values({ name: "Test Co", issuePrefix: "TC" }).returning();
    const result = await svc().deployTemplate(template.id, co.id);
    expect(result.agentNames).toEqual(["Tech Lead", "Full-stack Dev", "QA Agent"]);
    expect(result.agentIds).toHaveLength(3);
    const createdAgents = await db.select().from(agents).where(eq(agents.companyId, co.id));
    expect(createdAgents).toHaveLength(3);
  }, 20_000);

  it("deployTemplate wires reportsTo relationships correctly", async () => {
    await svc().seedAgentTemplates();
    const [template] = await db.select().from(agentTemplates).where(eq(agentTemplates.slug, "dev-team"));
    const [co] = await db.insert(companies).values({ name: "Test Co 2", issuePrefix: "TC2" }).returning();
    const result = await svc().deployTemplate(template.id, co.id);
    const createdAgents = await db.select().from(agents).where(eq(agents.companyId, co.id));
    const lead = createdAgents.find((a) => a.name === "Tech Lead");
    const dev = createdAgents.find((a) => a.name === "Full-stack Dev");
    const qa = createdAgents.find((a) => a.name === "QA Agent");
    expect(lead?.reportsTo).toBeNull();
    expect(dev?.reportsTo).toBe(lead?.id);
    expect(qa?.reportsTo).toBe(lead?.id);
    expect(result.agentIds).toContain(lead?.id);
  }, 20_000);

  it("saveAsTemplate creates a custom template from an agent", async () => {
    const [co] = await db.insert(companies).values({ name: "Test Co 3", issuePrefix: "TC3" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: co.id,
      name: "My Agent",
      role: "worker",
      adapterType: "ea",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      status: "idle",
    }).returning();
    const template = await svc().saveAsTemplate(agent.id, {
      subtree: false,
      name: "My Agent Template",
      slug: "my-agent-template",
      description: "A test template",
      category: "custom",
    });
    expect(template.slug).toBe("my-agent-template");
    expect(template.sourceType).toBe("custom");
    const defs = template.agentDefinitions as AgentTemplateDefinition[];
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("My Agent");
  }, 20_000);
});
