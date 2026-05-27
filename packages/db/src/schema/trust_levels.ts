import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

// v3: trust levels - agent permission escalation based on approved actions
export const trustLevels = pgTable(
  "trust_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(), // send_email | deploy | delete_data | etc
    level: integer("level").notNull().default(0), // 0-5 derived from counts
    approvedCount: integer("approved_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    lowScoreCount: integer("low_score_count").notNull().default(0), // scores ≤ 2
    lastDecisionAt: timestamp("last_decision_at", { withTimezone: true }),
    autoApproveEnabled: boolean("auto_approve_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentActionUniqueIdx: uniqueIndex("trust_levels_agent_action_uniq").on(table.agentId, table.actionType),
  }),
);
