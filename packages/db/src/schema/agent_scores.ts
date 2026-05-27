import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { plans } from "./plans.js";
import { operatorMessages } from "./operator_messages.js";
import { authUsers } from "./auth.js";

// v3: agent scores - human ratings of agent performance
export const agentScores = pgTable(
  "agent_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => operatorMessages.id, { onDelete: "set null" }),
    scoredByUserId: text("scored_by_user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    score: integer("score").notNull(), // 1-5
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_scores_agent_idx").on(table.agentId),
    scoredByIdx: index("agent_scores_scored_by_idx").on(table.scoredByUserId),
  }),
);
