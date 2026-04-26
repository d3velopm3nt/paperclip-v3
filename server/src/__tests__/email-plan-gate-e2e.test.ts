// v3: end-to-end coverage for the inbound-email → triage-issue → plan-gate
// → execute pipeline. Service-level (not HTTP) so each scenario can drive the
// pipeline directly and assert observable state in the DB.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentWakeupRequests,
  agents,
  approvals,
  clients,
  companies,
  createDb,
  emailAccounts,
  emailAttachments,
  emailMessages,
  issueComments,
  issues,
  planDecisionTokens,
  plans,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { emailProcessorService } from "../services/email-processor.ts";
import { planGateService } from "../services/plan-gate.ts";
import { planDecisionTokenService } from "../services/plan-decision-tokens.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeIfDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping email-plan-gate-e2e tests: ${support.reason ?? "unsupported"}`);
}

function buildEmail(opts: {
  messageId: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string;
  references?: string;
}): Buffer {
  const headers: string[] = [
    `From: ${opts.from ?? "client@innotrack.test"}`,
    `To: ${opts.to ?? "jayjay@develtech.co.za"}`,
    `Subject: ${opts.subject ?? "Hello"}`,
    `Message-ID: ${opts.messageId}`,
    "Date: Fri, 25 Apr 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  const body = opts.body ?? "This is the email body for triage.";
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body, "utf8");
}

describeIfDb("email → triage issue → plan-gate → execute (e2e)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let attachmentRoot: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pg-e2e-");
    db = createDb(tempDb.connectionString);
    attachmentRoot = mkdtempSync(path.join(tmpdir(), "paperclip-home-"));
    process.env.PAPERCLIP_HOME = attachmentRoot;
    // Disable async workflow re-evaluation — it races with afterEach truncate.
    process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL = "1";
    process.env.PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC = "1";
  }, 30_000);

  afterEach(async () => {
    // Truncate companies cascade — companies is the root and most rows fall
    // away through FK chains; explicit table list keeps any non-cascading
    // tables clean and avoids fighting circular FKs by hand.
    await db.execute(sql`TRUNCATE TABLE
      plan_decision_tokens, plans, approvals, email_attachments, email_messages,
      issue_comments, issues, agent_wakeup_requests, projects, clients,
      email_accounts, agents, companies
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    delete process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL;
    delete process.env.PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC;
    try { rmSync(attachmentRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Dev", issuePrefix: "DEV" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "CEO", role: "ceo" })
      .returning();
    const [account] = await db
      .insert(emailAccounts)
      .values({
        companyId: company.id,
        label: "main",
        role: "inbound",
        imapHost: "imap.test",
        imapPort: 993,
        imapUser: "jayjay@develtech.co.za",
        imapPasswordEnc: "enc:x",
        fromName: "Dev",
        fromEmail: "jayjay@develtech.co.za",
        triageAgentId: agent.id,
      })
      .returning();
    return { company, agent, account };
  }

  it("inbound email → creates triage issue assigned to triage agent + queues wakeup + links email", async () => {
    const { company, agent, account } = await seed();
    const processor = emailProcessorService(db);
    const result = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildEmail({ messageId: "<e2e-1@test>", subject: "First request" }),
    });

    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, result.emailMessageId));
    expect(msg.processingState).toBe("plan_proposed");
    expect(msg.matchedAgentId).toBe(agent.id);
    expect(msg.issueId).toBeTruthy();

    const [issue] = await db.select().from(issues).where(eq(issues.id, msg.issueId!));
    expect(issue.assigneeAgentId).toBe(agent.id);
    expect(issue.status).toBe("in_progress");
    expect(issue.title).toContain("First request");
    expect(issue.companyId).toBe(company.id);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agent.id));
    expect(wakeups.length).toBeGreaterThanOrEqual(1);
    expect(wakeups[0].reason).toBe("email-triage");
  }, 30_000);

  it("reply with In-Reply-To attaches to the original triage issue (no second issue, comment + wakeup)", async () => {
    const { agent, account } = await seed();
    const processor = emailProcessorService(db);

    const first = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildEmail({ messageId: "<thread-1@test>", subject: "Need help" }),
    });
    const [firstMsg] = await db.select().from(emailMessages).where(eq(emailMessages.id, first.emailMessageId));
    expect(firstMsg.issueId).toBeTruthy();
    const triageIssueId = firstMsg.issueId!;

    // Clear wakeup queue + issue execution lock so the reply path does a fresh
    // wakeup with reason='thread-reply' (otherwise heartbeatService coalesces
    // into the still-locked first run with reason='issue_execution_same_name').
    // In production the first run completes + releases the lock between calls;
    // tests bypass run execution via PAPERCLIP_DISABLE_HEARTBEAT_RUN_EXEC=1, so
    // we have to release manually.
    await db.execute(sql`UPDATE issues SET execution_run_id = NULL, execution_agent_name_key = NULL, execution_locked_at = NULL`);
    await db.execute(sql`UPDATE heartbeat_runs SET status = 'succeeded', finished_at = now(), wakeup_request_id = NULL WHERE status IN ('queued','running')`);
    await db.delete(agentWakeupRequests);

    const reply = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildEmail({
        messageId: "<thread-2@test>",
        subject: "Re: Need help",
        body: "Here's the extra detail you asked for.",
        inReplyTo: "<thread-1@test>",
        references: "<thread-1@test>",
      }),
    });

    const [replyMsg] = await db.select().from(emailMessages).where(eq(emailMessages.id, reply.emailMessageId));
    expect(replyMsg.issueId).toBe(triageIssueId);
    expect(replyMsg.processingState).toBe("plan_proposed");

    const allTriageIssues = await db.select().from(issues);
    expect(allTriageIssues).toHaveLength(1);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, triageIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Follow-up email received");

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agent.id));
    expect(wakeups.length).toBe(1);
    expect(wakeups[0].reason).toBe("thread-reply");
  }, 30_000);

  it("plan decision token approves and executes (creates issue from plan)", async () => {
    const { company, agent, account } = await seed();
    // Bring in a source email so executePlan has context for create_issue.
    const processor = emailProcessorService(db);
    const inbound = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildEmail({ messageId: "<approve-1@test>", subject: "Build feature X" }),
    });

    // Seed client + project so the create_issue plan has full readiness.
    const [client] = await db
      .insert(clients)
      .values({ companyId: company.id, name: "Innotrack", emailDomain: "innotrack.test" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Feature X", clientId: client.id })
      .returning();

    const gate = planGateService(db);
    const proposed = await gate.proposePlan({
      companyId: company.id,
      agentId: agent.id,
      kind: "create_issue",
      actionType: "create_issue",
      proposalText: "Plan: build feature X with frontend + backend changes.",
      sourceEmailMessageId: inbound.emailMessageId,
      clientId: client.id,
      projectId: project.id,
      definitionOfDone: ["feature X built", "tests pass", "shipped"],
      proposalMeta: { sourceEmail: { from: "client@innotrack.test", subject: "Build feature X" } },
      confidence: "high",
    });

    const tokens = planDecisionTokenService(db);
    const { token } = await tokens.issue(proposed.planId);
    const { planId } = await tokens.redeem(token);
    expect(planId).toBe(proposed.planId);

    await gate.recordDecision(proposed.planId, "approved", null, "Approved via e2e");
    const result = await gate.executePlan(proposed.planId);
    expect(result.issueId).toBeTruthy();

    const [plan] = await db.select().from(plans).where(eq(plans.id, proposed.planId));
    expect(plan.decision).toBe("approved");
    expect(plan.executionStatus).toBe("success");
    expect(plan.issueId).toBe(result.issueId);

    const [createdIssue] = await db.select().from(issues).where(eq(issues.id, result.issueId!));
    expect(createdIssue.title).toContain("Build feature X");
  }, 30_000);

  it("expired token is rejected", async () => {
    const { company, agent } = await seed();
    const gate = planGateService(db);
    const proposed = await gate.proposePlan({
      companyId: company.id,
      agentId: agent.id,
      kind: "request_clarification",
      actionType: "request_clarification",
      proposalText: "Test plan",
    });
    // Backdate the token so it's already expired.
    const tokens = planDecisionTokenService(db);
    const { token } = await tokens.issue(proposed.planId, 1);
    await db
      .update(planDecisionTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(planDecisionTokens.token, token));

    await expect(tokens.redeem(token)).rejects.toThrow(/expired/i);
  }, 30_000);

  it("re-used token is rejected on the second attempt", async () => {
    const { company, agent } = await seed();
    const gate = planGateService(db);
    const proposed = await gate.proposePlan({
      companyId: company.id,
      agentId: agent.id,
      kind: "request_clarification",
      actionType: "request_clarification",
      proposalText: "Test plan",
    });
    const tokens = planDecisionTokenService(db);
    const { token } = await tokens.issue(proposed.planId);
    await tokens.redeem(token);
    await expect(tokens.redeem(token)).rejects.toThrow(/already used/i);
  }, 30_000);

  it("create_issue plan without clientId/projectId/DoD throws PlanReadinessError", async () => {
    const { company, agent } = await seed();
    const { planGateService: pgs, PlanReadinessError } = await import("../services/plan-gate.ts");
    const gate = pgs(db);
    await expect(
      gate.proposePlan({
        companyId: company.id,
        agentId: agent.id,
        kind: "create_issue",
        actionType: "create_issue",
        proposalText: "Build it",
      }),
    ).rejects.toBeInstanceOf(PlanReadinessError);
    // None of the readiness fields are set → all three should appear in `missing`.
    try {
      await gate.proposePlan({
        companyId: company.id,
        agentId: agent.id,
        kind: "create_issue",
        actionType: "create_issue",
        proposalText: "Build it",
      });
    } catch (err) {
      const e = err as InstanceType<typeof PlanReadinessError>;
      expect(e.missing).toEqual(["clientId", "projectId", "definitionOfDone"]);
    }
  }, 30_000);

  it("client/project auto-link: single non-archived project for matched client → plan picks it up", async () => {
    const { company, agent, account } = await seed();
    const [client] = await db
      .insert(clients)
      .values({ companyId: company.id, name: "Innotrack", emailDomain: "innotrack.test" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Website", clientId: client.id })
      .returning();

    const processor = emailProcessorService(db);
    const result = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildEmail({
        messageId: "<auto-link-1@test>",
        from: "boss@innotrack.test",
        subject: "Update logo",
      }),
    });

    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, result.emailMessageId));
    expect(msg.matchedClientId).toBe(client.id);
    const [issue] = await db.select().from(issues).where(eq(issues.id, msg.issueId!));
    expect(issue.clientId).toBe(client.id);
    expect(issue.projectId).toBe(project.id);
  }, 30_000);

  it("no client match → triage issue still created with null clientId/projectId", async () => {
    const { agent, account } = await seed();
    const processor = emailProcessorService(db);
    const result = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildEmail({
        messageId: "<no-match-1@test>",
        from: "stranger@unknown.test",
        subject: "Hi",
      }),
    });

    const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, result.emailMessageId));
    expect(msg.matchedClientId).toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, msg.issueId!));
    expect(issue.clientId).toBeNull();
    expect(issue.projectId).toBeNull();
    expect(issue.assigneeAgentId).toBe(agent.id);
  }, 30_000);
});
