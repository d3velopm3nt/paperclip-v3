import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// v3: plan-gate — per-scope rules for whether an action type requires approval.
// scope ∈ { 'company' | 'client' | 'project' | 'agent' } and scope_ref_id is the
// id of that entity. Resolution order (most specific wins): agent → project →
// client → company.
export const actionPolicies = pgTable(
  "action_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("company"),
    scopeRefId: uuid("scope_ref_id").notNull(),
    actionType: text("action_type").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    immediateEmail: boolean("immediate_email").notNull().default(false),
    paramsJson: jsonb("params_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUniqueIdx: uniqueIndex("action_policies_scope_action_idx").on(
      table.scope,
      table.scopeRefId,
      table.actionType,
    ),
    companyLookupIdx: index("action_policies_company_lookup_idx").on(
      table.companyId,
      table.actionType,
    ),
  }),
);
