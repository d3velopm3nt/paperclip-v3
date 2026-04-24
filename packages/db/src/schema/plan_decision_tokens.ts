// v3: one-shot tokens that let a human approve / reject a plan via an email
// link without logging in. Each plan gets a token when the notification email
// is sent; the token is consumed on first use and expires after a set window.
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { plans } from "./plans.js";

export const planDecisionTokens = pgTable(
  "plan_decision_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("plan_decision_tokens_token_idx").on(table.token),
    planIdx: index("plan_decision_tokens_plan_idx").on(table.planId),
  }),
);
