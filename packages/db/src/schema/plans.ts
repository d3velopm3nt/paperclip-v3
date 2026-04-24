import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { emailMessages } from "./email_messages.js";

// v3: plan gate — every governed agent action requires a human-approved plan.
//
// Valid kinds:
//   create_issue | update_issue | reply_to_sender | request_clarification | delegate | other
// Valid decisions:
//   pending | approved | revision_requested | rejected
// Valid executionStatus:
//   pending | success | failed
// Valid confidence:
//   low | medium | high
//
// Note: approvalId is not defined here to avoid a circular import with approvals.ts.
// approvals.planId -> plans.id is the link used instead (declared on approvals side).
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").references(() => issues.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // v3: scope hints used by plan-gate to resolve which policy applied
    clientId: uuid("client_id"),
    projectId: uuid("project_id"),
    actionType: text("action_type"),
    kind: text("kind").notNull(),
    revision: integer("revision").notNull().default(1),
    parentPlanId: uuid("parent_plan_id"),
    sourceEmailMessageId: uuid("source_email_message_id").references(
      () => emailMessages.id,
    ),
    proposalText: text("proposal_text").notNull(),
    proposalMeta: jsonb("proposal_meta")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    confidence: text("confidence").notNull().default("medium"),
    proposedAt: timestamp("proposed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decision: text("decision").notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionStatus: text("execution_status").notNull().default("pending"),
    executionError: text("execution_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("plans_company_idx").on(table.companyId),
    agentIdx: index("plans_agent_idx").on(table.agentId),
    decisionIdx: index("plans_decision_idx").on(table.decision),
  }),
);
