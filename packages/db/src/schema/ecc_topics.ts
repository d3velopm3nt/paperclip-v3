import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const eccTopics = pgTable(
  "ecc_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    currentState: text("current_state"),
    companyId: uuid("company_id").references(() => companies.id),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("ecc_topics_status_idx").on(table.status),
    companyIdx: index("ecc_topics_company_idx").on(table.companyId),
  }),
);

export const eccTopicIssues = pgTable(
  "ecc_topic_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id").notNull().references(() => eccTopics.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueLink: unique("ecc_topic_issues_unique").on(table.topicId, table.issueId),
  }),
);
