// v3: generic workflow viewer — runs are evaluation snapshots of a pipeline
// (defined in code) against a specific source row. They power the "what
// should have happened vs what did" diagnostic page.
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowType: text("workflow_type").notNull(),
    sourceTable: text("source_table").notNull(),
    sourceId: uuid("source_id").notNull(),
    overallStatus: text("overall_status").notNull(), // running | passed | failed | partial
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIdx: index("workflow_runs_source_idx").on(
      table.workflowType,
      table.sourceId,
      table.startedAt,
    ),
    companyIdx: index("workflow_runs_company_idx").on(table.companyId),
  }),
);
