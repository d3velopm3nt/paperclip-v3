import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// v3: plan-gate — per-company rules for whether an action type requires approval
export const actionPolicies = pgTable(
  "action_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    immediateEmail: boolean("immediate_email").notNull().default(false),
    paramsJson: jsonb("params_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActionUniqueIdx: uniqueIndex("action_policies_company_action_idx").on(
      table.companyId,
      table.actionType,
    ),
  }),
);
