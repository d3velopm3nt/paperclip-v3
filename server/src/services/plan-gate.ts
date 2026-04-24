// v3: plan-gate service.
//
// evaluateGate(ctx) — resolves the applicable policy (scope hierarchy in
// action-policies service), decides PASS or REQUIRES_PLAN.
// proposePlan(input) — writes a plans + approvals row for a REQUIRES_PLAN
// action, so the user can review + approve.
// executePlan(planId) — marks the plan executed; concrete dispatchers for
// create_issue / reply_to_sender / request_clarification will be added as
// downstream capabilities ship.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issues, plans, emailMessages, emailAccounts, companies } from "@paperclipai/db";
import { actionPolicyService, type ActionPolicyRow, type PolicyScope } from "./action-policies.js";
import { issueService } from "./issues.js";
import { sendEmailFromAccount } from "./email-sender.js";
import { logger } from "../middleware/logger.js";

export type Confidence = "low" | "medium" | "high";

export interface EvaluateInput {
  companyId: string;
  actionType: string;
  confidence?: Confidence;
  clientId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
}

export interface EvaluateResult {
  decision: "PASS" | "REQUIRES_PLAN";
  reason: string;
  policy: ActionPolicyRow | null;
  matchedScope: PolicyScope | null;
}

export interface ProposePlanInput {
  companyId: string;
  agentId: string;
  actionType: string;
  kind: string; // plans.kind — create_issue | reply_to_sender | ...
  proposalText: string;
  proposalMeta?: Record<string, unknown>;
  clientId?: string | null;
  projectId?: string | null;
  sourceEmailMessageId?: string | null;
  confidence?: Confidence;
}

export interface ProposedPlan {
  planId: string;
  approvalId: string;
  immediateEmail: boolean;
}

export function planGateService(db: Db) {
  const policies = actionPolicyService(db);

  async function evaluateGate(input: EvaluateInput): Promise<EvaluateResult> {
    const { policy, matchedScope } = await policies.resolvePolicy({
      companyId: input.companyId,
      actionType: input.actionType,
      clientId: input.clientId,
      projectId: input.projectId,
      agentId: input.agentId,
    });

    // confidence=low always forces a plan, overriding "requiresApproval=false"
    if (input.confidence === "low") {
      return {
        decision: "REQUIRES_PLAN",
        reason: "Agent reported low confidence — override to plan gate",
        policy,
        matchedScope,
      };
    }

    if (!policy) {
      return {
        decision: "PASS",
        reason: "No policy found for action at any scope",
        policy: null,
        matchedScope: null,
      };
    }

    if (policy.requiresApproval) {
      return {
        decision: "REQUIRES_PLAN",
        reason: `Policy at ${matchedScope} scope requires approval`,
        policy,
        matchedScope,
      };
    }

    return {
      decision: "PASS",
      reason: `Policy at ${matchedScope} scope allows without approval`,
      policy,
      matchedScope,
    };
  }

  // Writes plan + pending approval. Caller typically arrives here because
  // evaluateGate returned REQUIRES_PLAN, but proposePlan can also be called
  // unconditionally for explicitly gated actions.
  async function proposePlan(input: ProposePlanInput): Promise<ProposedPlan> {
    const evaluation = await evaluateGate({
      companyId: input.companyId,
      actionType: input.actionType,
      confidence: input.confidence,
      clientId: input.clientId,
      projectId: input.projectId,
      agentId: input.agentId,
    });

    return db.transaction(async (tx) => {
      const [plan] = await tx
        .insert(plans)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          clientId: input.clientId ?? null,
          projectId: input.projectId ?? null,
          actionType: input.actionType,
          kind: input.kind,
          sourceEmailMessageId: input.sourceEmailMessageId ?? null,
          proposalText: input.proposalText,
          proposalMeta: input.proposalMeta ?? {},
          confidence: input.confidence ?? "medium",
          updatedAt: new Date(),
        })
        .returning();

      const [approval] = await tx
        .insert(approvals)
        .values({
          companyId: input.companyId,
          type: "plan",
          planId: plan!.id,
          status: "pending",
          requestedByAgentId: input.agentId,
          payload: {
            summary: input.proposalText.slice(0, 200),
            actionType: input.actionType,
            kind: input.kind,
            proposalText: input.proposalText,
            proposalMeta: input.proposalMeta ?? {},
            sourceEmailMessageId: input.sourceEmailMessageId ?? null,
          },
          updatedAt: new Date(),
        })
        .returning();

      // Link the source email to the new approval/plan so the inbox shows
      // the "plan_proposed" state instead of staying at "pending".
      if (input.sourceEmailMessageId) {
        await tx
          .update(emailMessages)
          .set({
            processingState: "plan_proposed",
            processedAt: new Date(),
            approvalId: approval!.id,
            matchedClientId: input.clientId ?? null,
            matchedAgentId: input.agentId,
            matchedCompanyId: input.companyId,
          })
          .where(eq(emailMessages.id, input.sourceEmailMessageId));
      }

      const immediateEmail = evaluation.policy?.immediateEmail === true;
      logger.info(
        {
          planId: plan!.id,
          approvalId: approval!.id,
          actionType: input.actionType,
          matchedScope: evaluation.matchedScope,
          immediateEmail,
        },
        "plan-gate: plan proposed",
      );

      return { planId: plan!.id, approvalId: approval!.id, immediateEmail };
    }).then(async (result) => {
      // Fire-and-forget: notify team via agent_voice account. Failures don't
      // block plan creation — just logged so operators can still see the plan
      // in the UI.
      notifyTeamOfPlan(db, result.planId, input).catch((err) =>
        logger.warn({ err, planId: result.planId }, "plan-gate: notification failed"),
      );
      return result;
    });
  }

  // Transitions plan + approval records for a decision. Does not dispatch the
  // underlying action — dispatchers (send_email, create_issue etc.) live in
  // their own services once they exist.
  async function recordDecision(
    planId: string,
    decision: "approved" | "rejected" | "revision_requested",
    decidedByUserId: string | null,
    note?: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [plan] = await tx.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (!plan) throw new Error(`Plan not found: ${planId}`);
      await tx
        .update(plans)
        .set({
          decision,
          decidedByUserId,
          decidedAt: new Date(),
          decisionNote: note ?? null,
          updatedAt: new Date(),
        })
        .where(eq(plans.id, planId));
      await tx
        .update(approvals)
        .set({
          status: decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "pending",
          decisionNote: note ?? null,
          decidedByUserId: decidedByUserId ?? null,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(approvals.planId, planId), eq(approvals.type, "plan")));
    });
  }

  async function markExecuted(
    planId: string,
    result: { success: boolean; error?: string },
  ): Promise<void> {
    await db
      .update(plans)
      .set({
        executionStatus: result.success ? "success" : "failed",
        executionError: result.error ?? null,
        executedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(plans.id, planId));
  }

  // Dispatches the approved plan. Phase 2 only implements create_issue; other
  // kinds log and mark failed so they show up in the UI but don't silently
  // succeed. Caller should ensure plan.decision === 'approved' before invoking.
  async function executePlan(planId: string): Promise<{ issueId?: string }> {
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    if (plan.decision !== "approved") {
      throw new Error(`Plan not approved: ${planId} (decision=${plan.decision})`);
    }
    if (plan.executionStatus !== "pending") {
      throw new Error(`Plan already executed: ${planId} (status=${plan.executionStatus})`);
    }

    try {
      if (plan.kind === "create_issue") {
        const meta = (plan.proposalMeta ?? {}) as Record<string, unknown>;
        const srcEmail = (meta.sourceEmail ?? {}) as { subject?: string; from?: string };
        const title = srcEmail.subject?.trim() || plan.proposalText.slice(0, 200);
        // Issue description = the proposal text (the plan the operator
        // approved). The full email stays in /email/inbox — we reference
        // its id so the UI can deep-link, but we don't duplicate the body.
        const parts: string[] = [plan.proposalText];
        if (plan.sourceEmailMessageId) {
          parts.push("");
          parts.push(
            `Source email: see /email/inbox → message ${plan.sourceEmailMessageId}`,
          );
        }
        const description = parts.join("\n");
        const created = await issueService(db).create(plan.companyId, {
          title,
          description,
          clientId: plan.clientId ?? null,
          createdByAgentId: plan.agentId,
        });
        // Link the issue back to the plan + email for audit/inbox display.
        await db
          .update(plans)
          .set({
            issueId: created.id,
            executionStatus: "success",
            executedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(plans.id, planId));
        if (plan.sourceEmailMessageId) {
          await db
            .update(emailMessages)
            .set({
              issueId: created.id,
              processingState: "executed",
              processedAt: new Date(),
            })
            .where(eq(emailMessages.id, plan.sourceEmailMessageId));
        }
        logger.info({ planId, issueId: created.id }, "plan-gate: executed create_issue");
        return { issueId: created.id };
      }

      if (plan.kind === "reply_to_sender" || plan.kind === "request_clarification") {
        if (!plan.sourceEmailMessageId) {
          throw new Error(`${plan.kind} plan requires sourceEmailMessageId`);
        }
        const [msg] = await db
          .select({
            emailAccountId: emailMessages.emailAccountId,
            fromAddr: emailMessages.fromAddr,
            subject: emailMessages.subject,
            messageIdHeader: emailMessages.messageIdHeader,
          })
          .from(emailMessages)
          .where(eq(emailMessages.id, plan.sourceEmailMessageId))
          .limit(1);
        if (!msg) throw new Error("source email not found for reply");

        // Resolve the outbound account. Default is the inbox that received
        // the mail (continuity for the client). If inbound.reply_from_account_id
        // is set, use that account instead (e.g. reply via a dedicated voice).
        let senderAccountId = msg.emailAccountId;
        const [inboundAcct] = await db
          .select({ replyFromAccountId: emailAccounts.replyFromAccountId })
          .from(emailAccounts)
          .where(eq(emailAccounts.id, msg.emailAccountId))
          .limit(1);
        if (inboundAcct?.replyFromAccountId) {
          senderAccountId = inboundAcct.replyFromAccountId;
        }

        const meta = (plan.proposalMeta ?? {}) as Record<string, unknown>;
        const reply = (meta.reply ?? {}) as {
          subject?: string;
          text?: string;
          html?: string;
          to?: string;
        };
        const defaultPrefix =
          plan.kind === "request_clarification" ? "Clarification needed:" : "Re:";
        const baseSubject = msg.subject?.trim() || "(no subject)";
        const subject =
          reply.subject?.trim() ||
          (baseSubject.toLowerCase().startsWith("re:")
            ? baseSubject
            : `${defaultPrefix} ${baseSubject}`);
        const body =
          reply.text?.trim() ||
          plan.proposalText ||
          (plan.kind === "request_clarification"
            ? "Could you please provide more detail about your request?"
            : "Thanks — we have received your message.");
        const to = reply.to?.trim() || msg.fromAddr;

        const sent = await sendEmailFromAccount(db, {
          accountId: senderAccountId,
          to,
          subject,
          text: body,
          html: reply.html,
          inReplyTo: msg.messageIdHeader || null,
          references: msg.messageIdHeader ? [msg.messageIdHeader] : null,
        });

        await db
          .update(plans)
          .set({
            executionStatus: "success",
            executedAt: new Date(),
            updatedAt: new Date(),
            proposalMeta: {
              ...meta,
              sentEmail: {
                messageId: sent.messageId,
                to,
                subject,
                accepted: sent.accepted,
                rejected: sent.rejected,
                sentAt: new Date().toISOString(),
              },
            },
          })
          .where(eq(plans.id, planId));

        await db
          .update(emailMessages)
          .set({
            processingState: "executed",
            processedAt: new Date(),
          })
          .where(eq(emailMessages.id, plan.sourceEmailMessageId));

        logger.info(
          { planId, kind: plan.kind, messageId: sent.messageId },
          "plan-gate: executed email reply",
        );
        return {};
      }

      // Unsupported kinds — mark as failed with a clear error.
      const msg = `plan kind '${plan.kind}' is not dispatched by Phase 2 executor`;
      await markExecuted(planId, { success: false, error: msg });
      throw new Error(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markExecuted(planId, { success: false, error: message });
      throw err;
    }
  }

  return { evaluateGate, proposePlan, recordDecision, markExecuted, executePlan };
}

export type PlanGateService = ReturnType<typeof planGateService>;

// Best-effort team notification after a plan is proposed. Looks up the
// company's agent_voice account (if any) and sends a pending-plan email
// to the inbound account's team_emails. Silent success when either is missing.
async function notifyTeamOfPlan(
  db: Db,
  planId: string,
  input: ProposePlanInput,
): Promise<void> {
  const meta = (input.proposalMeta ?? {}) as Record<string, unknown>;
  let teamEmails = Array.isArray(meta.teamEmails) ? (meta.teamEmails as string[]) : [];
  if (teamEmails.length === 0) {
    // Fallback: company.owner_email if set, so operators get notified even
    // when a per-inbox team list wasn't configured.
    const [company] = await db
      .select({ ownerEmail: companies.ownerEmail })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1);
    if (company?.ownerEmail) {
      teamEmails = [company.ownerEmail];
    } else {
      logger.info({ planId }, "plan-gate: no team_emails or owner_email — skipping notification");
      return;
    }
  }

  const [voice] = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.companyId, input.companyId), eq(emailAccounts.role, "agent_voice")))
    .limit(1);
  if (!voice) {
    logger.info({ planId }, "plan-gate: no agent_voice account — skipping notification");
    return;
  }

  const sourceEmail = (meta.sourceEmail ?? {}) as {
    from?: string;
    subject?: string;
    account?: { address?: string; label?: string };
  };
  const clientMatched = (meta.clientMatched ?? null) as { name?: string } | null;

  // Generate a one-shot token for click-to-decide email links.
  const { planDecisionTokenService } = await import("./plan-decision-tokens.js");
  const { token } = await planDecisionTokenService(db).issue(planId);
  const baseUrl = resolvePublicBaseUrl();
  const approveLink = `${baseUrl}/api/plan-decisions/${token}?decision=approved`;
  const rejectLink = `${baseUrl}/api/plan-decisions/${token}?decision=rejected`;
  const paperclipLink = `${baseUrl}/governance/plans/${planId}`;
  // Ask-question: mailto reply to the agent voice, tagged so Phase C3 can
  // route the reply back to the triage issue.
  const askSubject = encodeURIComponent(`Re: [plan-${planId}] Question`);
  const askBody = encodeURIComponent(
    `(Type your question below — it will be routed to the triage agent)\n\n`,
  );
  // The mailto `to` is filled by the recipient's own client using the From of
  // this notification, so we leave the address empty and let the user reply.
  const askLink = `mailto:?subject=${askSubject}&body=${askBody}`;

  const subject = `[Plan pending approval] ${sourceEmail.subject ?? input.proposalText.slice(0, 80)}`;
  const text = renderPlanNotificationText({
    actionType: input.actionType,
    kind: input.kind,
    confidence: input.confidence ?? "medium",
    clientName: clientMatched?.name ?? "(unknown)",
    sourceEmail,
    proposalText: input.proposalText,
    approveLink,
    rejectLink,
    paperclipLink,
  });
  const html = renderPlanNotificationHtml({
    actionType: input.actionType,
    kind: input.kind,
    confidence: input.confidence ?? "medium",
    clientName: clientMatched?.name ?? "(unknown)",
    sourceEmail,
    proposalText: input.proposalText,
    approveLink,
    rejectLink,
    askLink,
    paperclipLink,
  });

  const { sendEmailFromAccount } = await import("./email-sender.js");
  await sendEmailFromAccount(db, {
    accountId: voice.id,
    to: teamEmails,
    subject,
    text,
    html,
  });
  logger.info({ planId, recipients: teamEmails.length }, "plan-gate: team notified");
}

function resolvePublicBaseUrl(): string {
  const explicit = process.env.PAPERCLIP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const port = Number(process.env.PORT) || 3100;
  return `http://localhost:${port}`;
}

interface PlanNotificationVars {
  actionType: string;
  kind: string;
  confidence: string;
  clientName: string;
  sourceEmail: { from?: string; subject?: string; account?: { address?: string; label?: string } };
  proposalText: string;
  approveLink: string;
  rejectLink: string;
  askLink?: string;
  paperclipLink: string;
}

function renderPlanNotificationText(v: PlanNotificationVars): string {
  return [
    `A new plan requires your approval.`,
    ``,
    `Action: ${v.actionType} (${v.kind})`,
    `Confidence: ${v.confidence}`,
    `Client: ${v.clientName}`,
    ``,
    `Source email:`,
    `  From: ${v.sourceEmail.from ?? "(unknown)"}`,
    `  Subject: ${v.sourceEmail.subject ?? "(no subject)"}`,
    `  Received by: ${v.sourceEmail.account?.address ?? "(unknown inbox)"}`,
    ``,
    `Proposal:`,
    v.proposalText,
    ``,
    `Approve: ${v.approveLink}`,
    `Reject:  ${v.rejectLink}`,
    `Open in Paperclip: ${v.paperclipLink}`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPlanNotificationHtml(v: PlanNotificationVars): string {
  const proposalHtml = escapeHtml(v.proposalText).replace(/\n/g, "<br>");
  const confidenceColor =
    v.confidence === "high" ? "#059669" : v.confidence === "medium" ? "#b45309" : "#b91c1c";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f5;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden;">
      <tr><td style="padding:20px 24px 8px 24px;">
        <div style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.05em;">Plan pending approval</div>
        <h1 style="margin:6px 0 0 0;font-size:20px;line-height:1.3;">${escapeHtml(v.sourceEmail.subject ?? "(no subject)")}</h1>
      </td></tr>
      <tr><td style="padding:4px 24px 8px 24px;font-size:13px;color:#52525b;">
        <div><strong>Action:</strong> ${escapeHtml(v.actionType)} <span style="color:#a1a1aa;">(${escapeHtml(v.kind)})</span></div>
        <div><strong>Client:</strong> ${escapeHtml(v.clientName)}</div>
        <div><strong>Confidence:</strong> <span style="color:${confidenceColor};font-weight:600;">${escapeHtml(v.confidence)}</span></div>
      </td></tr>
      <tr><td style="padding:12px 24px;">
        <div style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:6px;padding:12px 14px;font-size:13px;line-height:1.55;white-space:pre-wrap;">${proposalHtml}</div>
      </td></tr>
      <tr><td style="padding:4px 24px 12px 24px;font-size:12px;color:#71717a;">
        <div><strong>From:</strong> ${escapeHtml(v.sourceEmail.from ?? "(unknown)")}</div>
        <div><strong>Received by:</strong> ${escapeHtml(v.sourceEmail.account?.address ?? "(unknown inbox)")}</div>
      </td></tr>
      <tr><td style="padding:8px 24px 20px 24px;" align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="padding:4px;">
              <a href="${v.approveLink}" style="display:inline-block;background:#16a34a;color:#ffffff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Approve</a>
            </td>
            <td style="padding:4px;">
              <a href="${v.rejectLink}" style="display:inline-block;background:#dc2626;color:#ffffff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Reject</a>
            </td>
            ${v.askLink ? `<td style="padding:4px;">
              <a href="${v.askLink}" style="display:inline-block;background:#ffffff;color:#18181b;border:1px solid #d4d4d8;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Ask a question</a>
            </td>` : ""}
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 24px 22px 24px;" align="center">
        <a href="${v.paperclipLink}" style="font-size:12px;color:#71717a;">Or open in Paperclip</a>
      </td></tr>
    </table>
    <div style="font-size:11px;color:#a1a1aa;padding-top:12px;">Approve / Reject links are single-use and expire in 24 hours.</div>
  </td></tr>
</table>
</body></html>`;
}
