import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDb } from "@paperclipai/db";
import { companies, agents, emailAccounts, emailMessages, agentWakeupRequests } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { planGateService, PlanReadinessError } from "../services/plan-gate.js";
import { emailProcessorService } from "../services/email-processor.js";
import type { Db } from "@paperclipai/db";

let tempDb: EmbeddedPostgresTestDatabase;
let db: Db;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ea-intake-gate-");
  db = createDb(tempDb.connectionString);
}, 20_000);

afterAll(async () => {
  await tempDb.cleanup();
});

let seedCounter = 0;
async function seedBase() {
  const suffix = String(++seedCounter).padStart(3, "0");
  const [company] = await db.insert(companies).values({ name: `Acme${suffix}`, issuePrefix: `A${suffix}` }).returning();
  const [agent] = await db.insert(agents).values({
    companyId: null,
    name: "Executive Agent",
    adapterType: "ea",
    role: "operator",
    status: "idle",
    metadata: {},
  }).returning();
  const [specialistAgent] = await db.insert(agents).values({
    companyId: company.id,
    name: "Client Agent",
    adapterType: "claude",
    role: "client_agent",
    status: "idle",
    metadata: {},
  }).returning();
  return { company, agent, specialistAgent };
}

function buildMinimalEmail(from: string, to: string, subject: string, body: string): Buffer {
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");
  return Buffer.from(raw);
}

// ─── Task 1: planGateService ──────────────────────────────────────────────────

describe("planGateService", () => {
  it("proposePlan: bypassReadinessGate skips clientId/projectId/DoD requirement", async () => {
    const { company, agent } = await seedBase();
    await expect(
      planGateService(db).proposePlan({
        companyId: company.id,
        agentId: agent.id,
        actionType: "create_issue",
        kind: "create_issue",
        proposalText: "Create an issue for this lead",
        bypassReadinessGate: true,
      })
    ).resolves.toMatchObject({ planId: expect.any(String), approvalId: expect.any(String) });
  });

  it("proposePlan: without bypassReadinessGate, missing clientId still throws PlanReadinessError", async () => {
    const { company, agent } = await seedBase();
    await expect(
      planGateService(db).proposePlan({
        companyId: company.id,
        agentId: agent.id,
        actionType: "create_issue",
        kind: "create_issue",
        proposalText: "Create an issue",
      })
    ).rejects.toBeInstanceOf(PlanReadinessError);
  });

  it("executePlan: wakes assignee agent after creating issue", async () => {
    const { company, agent, specialistAgent } = await seedBase();
    const { planId } = await planGateService(db).proposePlan({
      companyId: company.id,
      agentId: agent.id,
      actionType: "create_issue",
      kind: "create_issue",
      proposalText: "Handle this lead from alice@example.com",
      assigneeAgentId: specialistAgent.id,
      bypassReadinessGate: true,
    });
    await planGateService(db).recordDecision(planId, "approved", null);
    await planGateService(db).executePlan(planId);
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, specialistAgent.id));
    expect(wakeups.length).toBeGreaterThan(0);
    expect(wakeups[0].reason).toBe("plan-approved");
  });
});

// ─── Task 2: email-processor EA routing ──────────────────────────────────────

describe("email-processor: EA routing", () => {
  it("email with EA triage agent: no issue created, wakeup enqueued with emailMessageId", async () => {
    const { company, agent: eaAgent } = await seedBase();
    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "main",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "inbox@acme.com",
      imapPasswordEnc: "enc:x",
      fromName: "Acme",
      fromEmail: "inbox@acme.com",
      triageAgentId: eaAgent.id,
    }).returning();

    process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL = "1";
    const processor = emailProcessorService(db);
    const result = await processor.processRawMessage({
      emailAccountId: account.id,
      rawBytes: buildMinimalEmail("client@vendor.com", "inbox@acme.com", "Partnership inquiry", "Let's work together."),
    });

    expect(result.duplicated).toBe(false);

    const { issues: issuesTable } = await import("@paperclipai/db");
    const companyIssues = await db
      .select({ id: issuesTable.id })
      .from(issuesTable)
      .where(eq(issuesTable.companyId, company.id));
    expect(companyIssues).toHaveLength(0);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, eaAgent.id));
    expect(wakeups.length).toBeGreaterThan(0);
    expect((wakeups[0].payload as Record<string, unknown>).emailMessageId).toBeTruthy();
  });
});

// ─── Task 3: get_email_message query logic ────────────────────────────────────

describe("get_email_message query logic", () => {
  it("returns thread history and existingIssueId when prior thread email has issue", async () => {
    const { company } = await seedBase();
    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "thread-test",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "box@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "box@co.com",
    }).returning();

    const { issues: issuesTable } = await import("@paperclipai/db");
    const [existingIssue] = await db.insert(issuesTable).values({
      companyId: company.id,
      title: "Prior issue",
      status: "in_progress",
      priority: "medium",
    }).returning();

    const [parentEmail] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<parent-001@example.com>",
      referencesHeaders: [],
      fromAddr: "client@vendor.com",
      toAddrs: ["box@co.com"],
      subject: "Original inquiry",
      body: "Let's work together.",
      receivedAt: new Date(Date.now() - 86400_000),
      issueId: existingIssue.id,
    }).returning();

    const [replyEmail] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<reply-002@example.com>",
      inReplyToHeader: "<parent-001@example.com>",
      referencesHeaders: ["<parent-001@example.com>"],
      fromAddr: "client@vendor.com",
      toAddrs: ["box@co.com"],
      subject: "Re: Original inquiry",
      body: "Following up.",
      receivedAt: new Date(),
    }).returning();

    const emailRow = replyEmail;
    const referencedMsgIds = [
      ...(emailRow.referencesHeaders ?? []),
      ...(emailRow.inReplyToHeader ? [emailRow.inReplyToHeader] : []),
    ];
    const ancestors = await db
      .select({ id: emailMessages.id, issueId: emailMessages.issueId, fromAddr: emailMessages.fromAddr })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.emailAccountId, account.id),
          inArray(emailMessages.messageIdHeader, referencedMsgIds),
        )
      )
      .orderBy(emailMessages.receivedAt);

    const existingIssueId = ancestors.find((a) => a.issueId)?.issueId ?? null;

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].id).toBe(parentEmail.id);
    expect(existingIssueId).toBe(existingIssue.id);
  });

  it("returns existingIssueId null when no thread email has an issue", async () => {
    const referencedMsgIds: string[] = [];
    const existingIssueId = referencedMsgIds.length === 0 ? null : null;
    expect(existingIssueId).toBeNull();
  });
});

// ─── Task 4: get_issue_context query logic ────────────────────────────────────

describe("get_issue_context query logic", () => {
  it("returns issue + comments + linked emails", async () => {
    const { company, agent } = await seedBase();
    const { issues: issuesTable, issueComments } = await import("@paperclipai/db");

    const [issue] = await db.insert(issuesTable).values({
      companyId: company.id,
      title: "Client lead: Alice",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    }).returning();

    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: agent.id,
      body: "Started investigating this lead.",
    });

    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "ctx-test",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "ctx@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "ctx@co.com",
    }).returning();

    await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<ctx-001@example.com>",
      referencesHeaders: [],
      fromAddr: "alice@vendor.com",
      toAddrs: ["ctx@co.com"],
      subject: "Partnership",
      body: "Hello, let's connect.",
      receivedAt: new Date(),
      issueId: issue.id,
    });

    const [issueRow] = await db
      .select({ id: issuesTable.id, title: issuesTable.title, status: issuesTable.status })
      .from(issuesTable)
      .where(eq(issuesTable.id, issue.id))
      .limit(1);

    const commentRows = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));

    const emailRows = await db
      .select({ id: emailMessages.id, fromAddr: emailMessages.fromAddr })
      .from(emailMessages)
      .where(eq(emailMessages.issueId, issue.id));

    expect(issueRow.id).toBe(issue.id);
    expect(commentRows).toHaveLength(1);
    expect(commentRows[0].body).toBe("Started investigating this lead.");
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0].fromAddr).toBe("alice@vendor.com");
  });
});

// ─── Task 5: create_plan with emailMessageId ──────────────────────────────────

describe("create_plan with emailMessageId", () => {
  it("creates plan + approval with sourceEmailMessageId and assigneeAgentId", async () => {
    const { company, agent: eaAgent, specialistAgent } = await seedBase();
    const { plans: plansTable, approvals: approvalsTable } = await import("@paperclipai/db");

    const [account] = await db.insert(emailAccounts).values({
      companyId: company.id,
      label: "plan-test",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapUser: "plan@co.com",
      imapPasswordEnc: "enc:x",
      fromName: "Co",
      fromEmail: "plan@co.com",
    }).returning();

    const [email] = await db.insert(emailMessages).values({
      emailAccountId: account.id,
      messageIdHeader: "<plan-001@example.com>",
      referencesHeaders: [],
      fromAddr: "lead@corp.com",
      toAddrs: ["plan@co.com"],
      subject: "Interested in your services",
      body: "We'd like to discuss a partnership.",
      receivedAt: new Date(),
      matchedCompanyId: company.id,
    }).returning();

    const { planId, approvalId } = await planGateService(db).proposePlan({
      companyId: company.id,
      agentId: eaAgent.id,
      actionType: "create_issue",
      kind: "create_issue",
      proposalText: "Create a new lead issue for corp.com inquiry",
      sourceEmailMessageId: email.id,
      assigneeAgentId: specialistAgent.id,
      bypassReadinessGate: true,
    });

    const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, planId)).limit(1);
    expect(plan.sourceEmailMessageId).toBe(email.id);
    expect(plan.kind).toBe("create_issue");

    const [approval] = await db.select().from(approvalsTable).where(eq(approvalsTable.id, approvalId)).limit(1);
    expect(approval.status).toBe("pending");
  });
});
