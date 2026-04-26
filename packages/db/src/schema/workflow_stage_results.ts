import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { workflowRuns } from "./workflow_runs.js";

export const workflowStageResults = pgTable(
  "workflow_stage_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    parentStageId: text("parent_stage_id"),
    branch: text("branch"),
    label: text("label").notNull(),
    status: text("status").notNull(), // passed | failed | pending | skipped | unknown
    expectations: jsonb("expectations").$type<string[]>().notNull().default([]),
    actuals: jsonb("actuals").$type<Record<string, unknown>>().notNull().default({}),
    errorText: text("error_text"),
    ord: integer("ord").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("workflow_stage_results_run_idx").on(table.runId, table.ord),
  }),
);
