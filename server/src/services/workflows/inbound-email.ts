// v3: workflow definition for inbound email triage. Each stage is a pure
// evaluator that queries the DB and returns its observed state plus a
// computed pass/fail/pending. Persisted via the workflow engine.
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  agentWakeupRequests,
  emailAccounts,
  emailAttachments,
  emailMessages,
  issueComments,
  issues,
  planDecisionTokens,
  plans,
  projects,
  clients,
} from "@paperclipai/db";
import type { StageDef, WorkflowContext, WorkflowDefinition } from "../workflow-engine.js";

const SOURCE_TABLE = "email_messages";
const TYPE = "inbound_email";

interface CachedEmail {
  email: typeof emailMessages.$inferSelect | null;
  account: typeof emailAccounts.$inferSelect | null;
}

async function getEmail(ctx: WorkflowContext): Promise<CachedEmail> {
  const cached = ctx.cache.email as CachedEmail | undefined;
  if (cached) return cached;
  const [email] = await ctx.db
    .select()
    .from(emailMessages)
    .where(eq(emailMessages.id, ctx.sourceId))
    .limit(1);
  let account: typeof emailAccounts.$inferSelect | null = null;
  if (email) {
    const [acct] = await ctx.db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.id, email.emailAccountId))
      .limit(1);
    account = acct ?? null;
  }
  const result: CachedEmail = { email: email ?? null, account };
  ctx.cache.email = result;
  return result;
}

const stageS1Persisted: StageDef = {
  id: "s1_persisted",
  label: "Email persisted",
  expectations: ["row exists in email_messages"],
  async evaluate(ctx) {
    const { email } = await getEmail(ctx);
    if (!email) return { status: "failed", error: "email_messages row missing" };
    return {
      status: "passed",
      actuals: {
        id: email.id,
        receivedAt: email.receivedAt,
        processingState: email.processingState,
      },
    };
  },
};

const stageS2Headers: StageDef = {
  id: "s2_headers",
  label: "Headers parsed",
  expectations: ["fromAddr non-empty", "messageIdHeader non-empty"],
  async evaluate(ctx) {
    const { email } = await getEmail(ctx);
    if (!email) return { status: "skipped" };
    const ok = !!email.fromAddr && !!email.messageIdHeader;
    return {
      status: ok ? "passed" : "failed",
      actuals: {
        fromAddr: email.fromAddr,
        toAddrs: email.toAddrs,
        subject: email.subject,
        messageIdHeader: email.messageIdHeader,
        inReplyToHeader: email.inReplyToHeader,
        referencesHeaders: email.referencesHeaders,
      },
    };
  },
};

const stageS3Threading: StageDef = {
  id: "s3_threading",
  label: "Threading branch",
  expectations: ["picks reply path A if in_reply_to set + parent has issue, else fresh path B"],
  async evaluate(ctx) {
    const { email } = await getEmail(ctx);
    if (!email) return { status: "skipped" };
    if (!email.inReplyToHeader) {
      ctx.cache.branch = "B";
      return {
        status: "passed",
        actuals: { branch: "B (fresh email)" },
      };
    }
    const candidates = [email.inReplyToHeader, ...(email.referencesHeaders ?? [])].filter(Boolean);
    const parents = await ctx.db
      .select({ id: emailMessages.id, issueId: emailMessages.issueId })
      .from(emailMessages)
      .where(inArray(emailMessages.messageIdHeader, candidates));
    const parent = parents.find((p) => p.issueId);
    if (parent) {
      ctx.cache.branch = "A";
      ctx.cache.parentEmailId = parent.id;
      ctx.cache.parentIssueId = parent.issueId;
      return {
        status: "passed",
        actuals: { branch: "A (reply attached to existing thread)", parentEmailId: parent.id, parentIssueId: parent.issueId },
      };
    }
    ctx.cache.branch = "B";
    return {
      status: "passed",
      actuals: { branch: "B (fresh — in_reply_to had no matching prior email)" },
    };
  },
};

// ---- Branch A (reply attached to existing issue) ----
const stageA3Comment: StageDef = {
  id: "a3_comment",
  label: "Reply: comment added on existing issue",
  branch: "A",
  expectations: ["issue_comments row authored 'email-thread' for parent issue"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "A") return { status: "skipped" };
    const issueId = ctx.cache.parentIssueId as string | undefined;
    if (!issueId) return { status: "failed", error: "no parentIssueId" };
    const comments = await ctx.db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorUserId, "email-thread")));
    return {
      status: comments.length > 0 ? "passed" : "failed",
      actuals: { commentCount: comments.length, latestBodyExcerpt: comments.at(-1)?.body?.slice(0, 200) ?? null },
    };
  },
};

const stageA4Wakeup: StageDef = {
  id: "a4_wakeup",
  label: "Reply: wakeup queued for existing assignee",
  branch: "A",
  expectations: ["agent_wakeup_requests row with reason='thread-reply' for the assignee"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "A") return { status: "skipped" };
    const issueId = ctx.cache.parentIssueId as string | undefined;
    if (!issueId) return { status: "failed", error: "no parentIssueId" };
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue?.assigneeAgentId) return { status: "failed", error: "issue has no assignee" };
    const wakeups = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, issue.assigneeAgentId), eq(agentWakeupRequests.reason, "thread-reply")));
    return {
      status: wakeups.length > 0 ? "passed" : "failed",
      actuals: { count: wakeups.length, agentId: issue.assigneeAgentId },
    };
  },
};

// ---- Branch B (fresh email) ----
const stageB1Account: StageDef = {
  id: "b1_account",
  label: "Account loaded",
  branch: "B",
  expectations: ["email_accounts row exists for emailAccountId"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "B") return { status: "skipped" };
    const { account } = await getEmail(ctx);
    if (!account) return { status: "failed", error: "account missing" };
    return {
      status: "passed",
      actuals: {
        id: account.id,
        label: account.label,
        role: account.role,
        triageAgentId: account.triageAgentId,
        autoAcknowledge: account.autoAcknowledge,
      },
    };
  },
};

const stageB3ClientMatch: StageDef = {
  id: "b3_client_match",
  label: "Client matched (or null)",
  branch: "B",
  expectations: ["matchedClientId stamped (may be null if no client matches)"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "B") return { status: "skipped" };
    const { email } = await getEmail(ctx);
    if (!email) return { status: "skipped" };
    let clientName: string | null = null;
    if (email.matchedClientId) {
      const [c] = await ctx.db
        .select({ name: clients.name, emailDomain: clients.emailDomain })
        .from(clients)
        .where(eq(clients.id, email.matchedClientId))
        .limit(1);
      clientName = c?.name ?? null;
    }
    return {
      status: "passed",
      actuals: { matchedClientId: email.matchedClientId, clientName },
    };
  },
};

const stageB4ProjectAutoLink: StageDef = {
  id: "b4_project_link",
  label: "Single-project auto-link",
  branch: "B",
  expectations: ["if matched client has exactly one non-archived project, issue.projectId = that project"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "B") return { status: "skipped" };
    const { email } = await getEmail(ctx);
    if (!email?.matchedClientId) {
      return { status: "skipped", actuals: { reason: "no client matched" } };
    }
    const projs = await ctx.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.clientId, email.matchedClientId), isNull(projects.archivedAt)));
    if (projs.length !== 1) {
      return {
        status: "skipped",
        actuals: { projectCount: projs.length, reason: "auto-link only when exactly 1 active project" },
      };
    }
    if (!email.issueId) return { status: "pending", actuals: { expected: projs[0]!.id } };
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, email.issueId)).limit(1);
    const ok = issue?.projectId === projs[0]!.id;
    return {
      status: ok ? "passed" : "failed",
      actuals: { expected: projs[0]!.id, actual: issue?.projectId ?? null },
    };
  },
};

const stageB5TriageAgent: StageDef = {
  id: "b5_triage_agent",
  label: "Triage agent resolved",
  branch: "B",
  expectations: ["account.triageAgentId or company CEO agent assigned to triage issue"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "B") return { status: "skipped" };
    const { email, account } = await getEmail(ctx);
    if (!email || !account) return { status: "skipped" };
    if (!email.matchedAgentId) return { status: "pending" };
    return {
      status: "passed",
      actuals: { agentId: email.matchedAgentId, source: account.triageAgentId === email.matchedAgentId ? "per-inbox" : "company-ceo-fallback" },
    };
  },
};

const stageB6TriageIssue: StageDef = {
  id: "b6_triage_issue",
  label: "Triage issue created + linked",
  branch: "B",
  expectations: ["email.issueId set", "issue.assigneeAgentId set", "issue.status = in_progress"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "B") return { status: "skipped" };
    const { email } = await getEmail(ctx);
    if (!email) return { status: "skipped" };
    if (!email.issueId) return { status: "failed", error: "email has no issueId" };
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, email.issueId)).limit(1);
    if (!issue) return { status: "failed", error: "linked issue missing" };
    const ok = !!issue.assigneeAgentId && issue.status === "in_progress";
    return {
      status: ok ? "passed" : "failed",
      actuals: { issueId: issue.id, status: issue.status, assigneeAgentId: issue.assigneeAgentId, title: issue.title },
    };
  },
};

const stageB8Wakeup: StageDef = {
  id: "b8_wakeup",
  label: "Triage agent wakeup queued",
  branch: "B",
  expectations: ["agent_wakeup_requests row with reason='email-triage' for the triage agent"],
  async evaluate(ctx) {
    if (ctx.cache.branch !== "B") return { status: "skipped" };
    const { email } = await getEmail(ctx);
    if (!email?.matchedAgentId) return { status: "skipped" };
    const wakeups = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, email.matchedAgentId), eq(agentWakeupRequests.reason, "email-triage")));
    return {
      status: wakeups.length > 0 ? "passed" : "failed",
      actuals: { count: wakeups.length, agentId: email.matchedAgentId },
    };
  },
};

// ---- Both branches converge: agent picks up + plan + decision + execute ----
const stage4AgentRun: StageDef = {
  id: "s4_agent_run",
  label: "Agent picked up wakeup",
  expectations: ["at least one wakeup request claimed (status != 'queued')"],
  async evaluate(ctx) {
    const { email } = await getEmail(ctx);
    if (!email?.matchedAgentId) return { status: "skipped" };
    const wakeups = await ctx.db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, email.matchedAgentId));
    if (wakeups.length === 0) return { status: "pending" };
    const claimed = wakeups.filter((w) => w.status !== "queued").length;
    return {
      status: claimed > 0 ? "passed" : "pending",
      actuals: { total: wakeups.length, claimed },
    };
  },
};

const stage5PlanProposed: StageDef = {
  id: "s5_plan_proposed",
  label: "Plan proposed",
  expectations: ["plans row with sourceEmailMessageId = this email"],
  async evaluate(ctx) {
    const planRows = await ctx.db
      .select()
      .from(plans)
      .where(eq(plans.sourceEmailMessageId, ctx.sourceId));
    ctx.cache.plans = planRows;
    if (planRows.length === 0) return { status: "pending" };
    return {
      status: "passed",
      actuals: {
        count: planRows.length,
        kinds: planRows.map((p) => p.kind),
        latestId: planRows[planRows.length - 1]!.id,
      },
    };
  },
};

const stage5bToken: StageDef = {
  id: "s5b_token",
  label: "Decision token issued (for email link approval)",
  parent: "s5_plan_proposed",
  expectations: ["plan_decision_tokens row exists for the latest plan"],
  async evaluate(ctx) {
    const planRows = ctx.cache.plans as Array<typeof plans.$inferSelect> | undefined;
    if (!planRows || planRows.length === 0) return { status: "skipped" };
    const latest = planRows[planRows.length - 1]!;
    const tokens = await ctx.db
      .select({ id: planDecisionTokens.id, usedAt: planDecisionTokens.usedAt, expiresAt: planDecisionTokens.expiresAt })
      .from(planDecisionTokens)
      .where(eq(planDecisionTokens.planId, latest.id));
    if (tokens.length === 0) return { status: "pending" };
    return {
      status: "passed",
      actuals: {
        count: tokens.length,
        usedAt: tokens.find((t) => t.usedAt)?.usedAt ?? null,
        expiresAt: tokens[0]!.expiresAt,
      },
    };
  },
};

const stage6Decision: StageDef = {
  id: "s6_decision",
  label: "Operator decision recorded",
  expectations: ["plan.decision != 'pending'"],
  async evaluate(ctx) {
    const planRows = ctx.cache.plans as Array<typeof plans.$inferSelect> | undefined;
    if (!planRows || planRows.length === 0) return { status: "skipped" };
    const latest = planRows[planRows.length - 1]!;
    if (latest.decision === "pending") return { status: "pending" };
    return {
      status: "passed",
      actuals: { decision: latest.decision, decidedAt: latest.decidedAt, note: latest.decisionNote },
    };
  },
};

const stage7Execute: StageDef = {
  id: "s7_execute",
  label: "Plan executed",
  expectations: ["plan.executionStatus = 'success'", "for create_issue: plan.issueId set"],
  async evaluate(ctx) {
    const planRows = ctx.cache.plans as Array<typeof plans.$inferSelect> | undefined;
    if (!planRows || planRows.length === 0) return { status: "skipped" };
    const latest = planRows[planRows.length - 1]!;
    if (latest.decision !== "approved") return { status: "skipped", actuals: { reason: "plan not approved" } };
    if (latest.executionStatus === "pending") return { status: "pending" };
    const ok = latest.executionStatus === "success";
    return {
      status: ok ? "passed" : "failed",
      actuals: {
        executionStatus: latest.executionStatus,
        executionError: latest.executionError,
        createdIssueId: latest.issueId,
      },
      error: ok ? undefined : latest.executionError ?? undefined,
    };
  },
};

void emailAttachments; // referenced for future stages (e.g. attachment validation)

export const inboundEmailWorkflow: WorkflowDefinition = {
  type: TYPE,
  label: "Inbound email triage",
  sourceTable: SOURCE_TABLE,
  async resolveCompanyId(ctx) {
    const { email, account } = await getEmail(ctx);
    if (!email) return null;
    return account?.companyId ?? null;
  },
  stages: [
    stageS1Persisted,
    stageS2Headers,
    stageS3Threading,
    stageA3Comment,
    stageA4Wakeup,
    stageB1Account,
    stageB3ClientMatch,
    stageB4ProjectAutoLink,
    stageB5TriageAgent,
    stageB6TriageIssue,
    stageB8Wakeup,
    stage4AgentRun,
    stage5PlanProposed,
    stage5bToken,
    stage6Decision,
    stage7Execute,
  ],
};

