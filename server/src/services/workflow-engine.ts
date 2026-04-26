// v3: workflow engine — runs a hard-coded WorkflowDefinition against a source
// row, persists per-stage status into workflow_runs + workflow_stage_results,
// and trims old runs. Pure of any specific workflow knowledge — definitions
// live alongside their source domain.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStageResults } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type StageStatus = "passed" | "failed" | "pending" | "skipped" | "unknown";

export interface StageResult {
  status: StageStatus;
  actuals?: Record<string, unknown>;
  error?: string;
}

export interface StageDef {
  id: string;
  label: string;
  parent?: string;
  branch?: string;
  expectations: string[];
  evaluate: (ctx: WorkflowContext) => Promise<StageResult>;
}

export interface WorkflowDefinition {
  type: string;
  label: string;
  sourceTable: string;
  /** Resolves the company id from the source row; required for persistence. */
  resolveCompanyId: (ctx: WorkflowContext) => Promise<string | null>;
  stages: StageDef[];
}

export interface WorkflowContext {
  db: Db;
  sourceId: string;
  /** Stage-id → status; populated as stages run so dependents can short-circuit. */
  results: Map<string, StageStatus>;
  /** Free-form scratch space for stages to share lookups (e.g. fetched rows). */
  cache: Record<string, unknown>;
}

export interface WorkflowRunResult {
  runId: string;
  overallStatus: "passed" | "failed" | "partial";
  finishedAt: Date;
}

export function workflowEngine(db: Db) {
  async function runWorkflow(
    def: WorkflowDefinition,
    sourceId: string,
    opts?: { keepRuns?: number },
  ): Promise<WorkflowRunResult | null> {
    const ctx: WorkflowContext = {
      db,
      sourceId,
      results: new Map(),
      cache: {},
    };
    const companyId = await def.resolveCompanyId(ctx);
    if (!companyId) {
      logger.warn(
        { workflowType: def.type, sourceId },
        "workflow-engine: cannot resolve companyId — skipping run",
      );
      return null;
    }

    const startedAt = new Date();
    const [run] = await db
      .insert(workflowRuns)
      .values({
        companyId,
        workflowType: def.type,
        sourceTable: def.sourceTable,
        sourceId,
        overallStatus: "running",
        startedAt,
      })
      .returning();

    const stageRows: Array<{
      runId: string;
      stageId: string;
      parentStageId: string | null;
      branch: string | null;
      label: string;
      status: StageStatus;
      expectations: string[];
      actuals: Record<string, unknown>;
      errorText: string | null;
      ord: number;
    }> = [];

    let ord = 0;
    let anyFailed = false;
    let anyPending = false;

    for (const stage of def.stages) {
      let result: StageResult;
      try {
        result = await stage.evaluate(ctx);
      } catch (err) {
        result = {
          status: "unknown",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      ctx.results.set(stage.id, result.status);
      if (result.status === "failed") anyFailed = true;
      if (result.status === "pending") anyPending = true;

      stageRows.push({
        runId: run!.id,
        stageId: stage.id,
        parentStageId: stage.parent ?? null,
        branch: stage.branch ?? null,
        label: stage.label,
        status: result.status,
        expectations: stage.expectations,
        actuals: result.actuals ?? {},
        errorText: result.error ?? null,
        ord: ord++,
      });
    }

    if (stageRows.length > 0) {
      await db.insert(workflowStageResults).values(stageRows);
    }

    const finishedAt = new Date();
    const overallStatus: WorkflowRunResult["overallStatus"] = anyFailed
      ? "failed"
      : anyPending
        ? "partial"
        : "passed";
    await db
      .update(workflowRuns)
      .set({ overallStatus, finishedAt })
      .where(eq(workflowRuns.id, run!.id));

    const keepRuns = opts?.keepRuns ?? 10;
    await purgeOldRuns(def.type, sourceId, keepRuns);

    return { runId: run!.id, overallStatus, finishedAt };
  }

  async function purgeOldRuns(
    workflowType: string,
    sourceId: string,
    keepN: number,
  ): Promise<void> {
    if (keepN <= 0) return;
    const all = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowType, workflowType), eq(workflowRuns.sourceId, sourceId)))
      .orderBy(desc(workflowRuns.startedAt));
    const toDelete = all.slice(keepN).map((r) => r.id);
    if (toDelete.length === 0) return;
    await db.delete(workflowRuns).where(
      sql`${workflowRuns.id} IN (${sql.join(toDelete.map((id) => sql`${id}`), sql`, `)})`,
    );
  }

  async function listRuns(
    workflowType: string,
    sourceId: string,
    limit = 10,
  ): Promise<Array<typeof workflowRuns.$inferSelect>> {
    return db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowType, workflowType), eq(workflowRuns.sourceId, sourceId)))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);
  }

  async function getRun(runId: string): Promise<{
    run: typeof workflowRuns.$inferSelect | null;
    stages: Array<typeof workflowStageResults.$inferSelect>;
  }> {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run) return { run: null, stages: [] };
    const stages = await db
      .select()
      .from(workflowStageResults)
      .where(eq(workflowStageResults.runId, runId))
      .orderBy(workflowStageResults.ord);
    return { run, stages };
  }

  /** Background-fire-and-forget helper — logs failures so callers don't have to wrap.
   * Skipped entirely when PAPERCLIP_DISABLE_WORKFLOW_EVAL is set (tests). */
  function runFireAndForget(def: WorkflowDefinition, sourceId: string): void {
    if (process.env.PAPERCLIP_DISABLE_WORKFLOW_EVAL === "1") return;
    void runWorkflow(def, sourceId).catch((err) =>
      logger.warn({ err, workflowType: def.type, sourceId }, "workflow-engine: run failed"),
    );
  }

  return { runWorkflow, listRuns, getRun, purgeOldRuns, runFireAndForget };
}

export type WorkflowEngineService = ReturnType<typeof workflowEngine>;
