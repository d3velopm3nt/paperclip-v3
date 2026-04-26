// v3: plan-gate decision endpoints + read helpers.
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, emailAccounts, plans } from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { planGateService, PlanReadinessError } from "../services/plan-gate.js";
import { planDecisionTokenService } from "../services/plan-decision-tokens.js";

const VALID_KINDS = new Set([
  "create_issue",
  "reply_to_sender",
  "request_clarification",
  "request_operator_input",
]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

export function planRoutes(db: Db) {
  const router = Router();
  const svc = planGateService(db);

  // GET /api/companies/:companyId/plans?decision=pending
  router.get("/companies/:companyId/plans", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const decision = typeof req.query.decision === "string" ? req.query.decision : null;
    const whereClause = decision
      ? and(eq(plans.companyId, companyId), eq(plans.decision, decision))
      : eq(plans.companyId, companyId);
    const rows = await db
      .select()
      .from(plans)
      .where(whereClause)
      .orderBy(desc(plans.proposedAt))
      .limit(200);
    res.json(rows);
  });

  // GET /api/plans/:id — includes linked approval row.
  router.get("/plans/:id", async (req, res) => {
    const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
    if (!plan) throw notFound("Plan not found");
    assertCompanyAccess(req, plan.companyId);
    const [approval] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.planId, plan.id), eq(approvals.type, "plan")))
      .limit(1);
    res.json({ ...plan, approval: approval ?? null });
  });

  // POST /api/companies/:companyId/plans — agent-facing plan proposal.
  // Used by triage agents to submit a plan after analyzing a source issue/email.
  router.post("/companies/:companyId/plans", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as {
      agentId?: string;
      kind?: string;
      actionType?: string;
      proposalText?: string;
      proposalMeta?: Record<string, unknown>;
      confidence?: string;
      clientId?: string | null;
      projectId?: string | null;
      sourceEmailMessageId?: string | null;
    };
    if (!body.agentId) throw badRequest("agentId is required");
    if (!body.kind || !VALID_KINDS.has(body.kind)) {
      throw badRequest(`kind must be one of: ${[...VALID_KINDS].join(", ")}`);
    }
    if (!body.proposalText || !body.proposalText.trim()) {
      throw badRequest("proposalText is required");
    }
    const confidence = body.confidence ?? "medium";
    if (!VALID_CONFIDENCE.has(confidence)) {
      throw unprocessable("confidence must be low | medium | high");
    }
    try {
      const proposed = await svc.proposePlan({
        companyId,
        agentId: body.agentId,
        kind: body.kind,
        actionType: body.actionType ?? body.kind,
        proposalText: body.proposalText,
        proposalMeta: body.proposalMeta ?? {},
        confidence: confidence as "low" | "medium" | "high",
        clientId: body.clientId ?? null,
        projectId: body.projectId ?? null,
        sourceEmailMessageId: body.sourceEmailMessageId ?? null,
        definitionOfDone: Array.isArray((body as { definitionOfDone?: unknown }).definitionOfDone)
          ? ((body as { definitionOfDone?: string[] }).definitionOfDone ?? [])
          : undefined,
      });
      res.status(201).json(proposed);
    } catch (err) {
      if (err instanceof PlanReadinessError) {
        res.status(422).json({
          error: err.message,
          missing: err.missing,
          hint: "Use kind='request_operator_input' (or 'request_clarification') to gather what's missing before re-submitting create_issue.",
        });
        return;
      }
      throw err;
    }
  });

  // POST /api/plans/:id/decision { decision: 'approved'|'rejected'|'revision_requested', note? }
  router.post("/plans/:id/decision", async (req, res) => {
    const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
    if (!plan) throw notFound("Plan not found");
    assertCompanyAccess(req, plan.companyId);
    const body = req.body as { decision?: string; note?: string };
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected" && decision !== "revision_requested") {
      throw badRequest("decision must be approved | rejected | revision_requested");
    }
    const actor = (req as { actor?: { userId?: string } }).actor;
    // decidedByUserId column is uuid — local_trusted mode uses sentinel "local-board"
    // which is not a uuid, so normalize to null in that case.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const decidedByUserId =
      actor?.userId && UUID_RE.test(actor.userId) ? actor.userId : null;
    await svc.recordDecision(plan.id, decision, decidedByUserId, body.note);

    // Auto-execute on approve so the user sees the issue immediately.
    let executionError: string | null = null;
    let createdIssueId: string | null = null;
    if (decision === "approved") {
      try {
        const result = await svc.executePlan(plan.id);
        createdIssueId = result.issueId ?? null;
      } catch (err) {
        executionError = err instanceof Error ? err.message : String(err);
      }
    }

    const [updated] = await db.select().from(plans).where(eq(plans.id, plan.id)).limit(1);
    res.json({ ...updated, executionError, createdIssueId });
  });

  // GET /api/plan-decisions/:token?decision=approved|rejected
  // Public token-authenticated decision — consumed by Approve/Reject links
  // in plan notification emails. Returns an HTML page for humans.
  router.get("/plan-decisions/:token", async (req, res) => {
    const token = req.params.token as string;
    const decision = typeof req.query.decision === "string" ? req.query.decision : null;
    if (decision !== "approved" && decision !== "rejected") {
      res.status(400).send(htmlPage("Invalid decision", "The decision must be approve or reject."));
      return;
    }
    const tokens = planDecisionTokenService(db);
    let planId: string;
    try {
      const result = await tokens.redeem(token);
      planId = result.planId;
    } catch (err) {
      res.status(400).send(htmlPage("Link invalid", (err as Error).message));
      return;
    }

    const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!plan) {
      res.status(404).send(htmlPage("Plan missing", "The linked plan no longer exists."));
      return;
    }
    if (plan.decision !== "pending") {
      res
        .status(409)
        .send(htmlPage("Already decided", `This plan is already ${plan.decision}.`));
      return;
    }

    try {
      await svc.recordDecision(plan.id, decision, null, "Decided via email link");
      let executionNote = "";
      if (decision === "approved") {
        try {
          const result = await svc.executePlan(plan.id);
          executionNote = result.issueId
            ? `Created issue ${result.issueId}.`
            : "Executed successfully.";
        } catch (err) {
          executionNote = `Execution failed: ${(err as Error).message}`;
        }
      }
      res.status(200).send(
        htmlPage(
          `Plan ${decision}`,
          `${decision === "approved" ? "Approved" : "Rejected"}. ${executionNote}`.trim(),
        ),
      );
    } catch (err) {
      res
        .status(500)
        .send(htmlPage("Decision failed", (err as Error).message));
    }
  });

  return router;
}

function htmlPage(title: string, message: string): string {
  const safeTitle = title.replace(/[<>]/g, "");
  const safeMsg = message.replace(/[<>]/g, "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;color:#18181b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:28px 32px;max-width:480px;box-shadow:0 1px 3px rgba(0,0,0,0.05);}
h1{margin:0 0 10px 0;font-size:20px;}p{margin:0;font-size:14px;color:#52525b;line-height:1.5;}</style>
</head><body><div class="card"><h1>${safeTitle}</h1><p>${safeMsg}</p></div></body></html>`;
}
