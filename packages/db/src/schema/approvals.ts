import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// v3: approval `type` column is used as the "kind" field in plan-gate contexts.
// Valid values now include plan-gate kinds: 'plan' | 'promotion' | 'clarification'
// (in addition to any pre-existing upstream values).
//
// planId -> plans.id is declared without a Drizzle `.references()` to avoid a circular
// import with plans.ts (plans.sourceEmailMessageId / plans.issueId already reference
// other tables, and plans itself is a separate entity). The FK is added in the
// migration SQL instead. See packages/db/src/migrations/0051_*.sql.
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    planId: uuid("plan_id"), // v3: FK added manually in migration
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
  }),
);
