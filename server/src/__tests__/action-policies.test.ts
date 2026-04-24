import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  actionPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actionPolicyService, DEFAULT_POLICIES } from "../services/action-policies.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("action-policies service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-action-policies-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(actionPolicies);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("seedDefaults inserts the expected rows and is idempotent", async () => {
    const [co] = await db.insert(companies).values({ name: "Dev", issuePrefix: "DEV" }).returning();
    const svc = actionPolicyService(db);

    await svc.seedDefaults(co.id);
    let rows = await db.select().from(actionPolicies).where(eq(actionPolicies.companyId, co.id));
    expect(rows).toHaveLength(DEFAULT_POLICIES.length);
    const actionTypes = rows.map((r) => r.actionType).sort();
    expect(actionTypes).toEqual(DEFAULT_POLICIES.map((p) => p.actionType).sort());
    const spend = rows.find((r) => r.actionType === "spend_over_cents");
    expect(spend?.paramsJson).toEqual({ thresholdCents: 5000 });

    // Idempotent: running again must not duplicate
    await svc.seedDefaults(co.id);
    rows = await db.select().from(actionPolicies).where(eq(actionPolicies.companyId, co.id));
    expect(rows).toHaveLength(DEFAULT_POLICIES.length);
  }, 20_000);

  it("companyService.create seeds defaults automatically", async () => {
    const cos = companyService(db);
    const created = await cos.create({ name: "AutoSeed", issuePrefix: "ASD" });
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.companyId, created.id));
    expect(rows).toHaveLength(DEFAULT_POLICIES.length);
  }, 20_000);

  it("resolvePolicy walks scope hierarchy: agent > project > client > company", async () => {
    const [co] = await db.insert(companies).values({ name: "R", issuePrefix: "RRR" }).returning();
    const svc = actionPolicyService(db);
    const clientId = "00000000-0000-0000-0000-000000000002";
    const projectId = "00000000-0000-0000-0000-000000000003";
    const agentId = "00000000-0000-0000-0000-000000000004";

    // Company-scoped: approval ON
    await svc.create(co.id, { scope: "company", scopeRefId: co.id, actionType: "reply_to_sender", requiresApproval: true });

    // Only company policy present → resolves to company row
    let res = await svc.resolvePolicy({ companyId: co.id, actionType: "reply_to_sender", clientId, projectId, agentId });
    expect(res.matchedScope).toBe("company");
    expect(res.policy?.requiresApproval).toBe(true);

    // Client-scoped override: approval OFF
    await svc.create(co.id, { scope: "client", scopeRefId: clientId, actionType: "reply_to_sender", requiresApproval: false });
    res = await svc.resolvePolicy({ companyId: co.id, actionType: "reply_to_sender", clientId, projectId, agentId });
    expect(res.matchedScope).toBe("client");
    expect(res.policy?.requiresApproval).toBe(false);

    // Project-scoped override: approval ON
    await svc.create(co.id, { scope: "project", scopeRefId: projectId, actionType: "reply_to_sender", requiresApproval: true });
    res = await svc.resolvePolicy({ companyId: co.id, actionType: "reply_to_sender", clientId, projectId, agentId });
    expect(res.matchedScope).toBe("project");
    expect(res.policy?.requiresApproval).toBe(true);

    // Agent-scoped override: approval OFF — most specific wins
    await svc.create(co.id, { scope: "agent", scopeRefId: agentId, actionType: "reply_to_sender", requiresApproval: false });
    res = await svc.resolvePolicy({ companyId: co.id, actionType: "reply_to_sender", clientId, projectId, agentId });
    expect(res.matchedScope).toBe("agent");
    expect(res.policy?.requiresApproval).toBe(false);

    // Unknown actionType → null
    res = await svc.resolvePolicy({ companyId: co.id, actionType: "no_such_type", clientId, projectId, agentId });
    expect(res.policy).toBeNull();
  }, 20_000);

  it("update + delete work end to end", async () => {
    const [co] = await db.insert(companies).values({ name: "U", issuePrefix: "UUU" }).returning();
    const svc = actionPolicyService(db);
    const created = await svc.create(co.id, {
      scope: "company",
      scopeRefId: co.id,
      actionType: "custom_thing",
      requiresApproval: true,
      immediateEmail: false,
    });
    const updated = await svc.update(created.id, { requiresApproval: false, immediateEmail: true });
    expect(updated?.requiresApproval).toBe(false);
    expect(updated?.immediateEmail).toBe(true);
    await svc.remove(created.id);
    const after = await svc.getById(created.id);
    expect(after).toBeNull();
  }, 20_000);
});
