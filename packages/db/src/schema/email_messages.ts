import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emailAccounts } from "./email_accounts.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { approvals } from "./approvals.js";

// v3: email monitoring — inbound mail archive + processing state
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailAccountId: uuid("email_account_id")
      .notNull()
      .references(() => emailAccounts.id, { onDelete: "cascade" }),
    messageIdHeader: text("message_id_header").notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddrs: jsonb("to_addrs").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // pending | analyzing | plan_proposed | clarifying | approved | declined | executed | ignored | error
    processingState: text("processing_state").notNull().default("pending"),
    matchedCompanyId: uuid("matched_company_id").references(() => companies.id),
    matchedAgentId: uuid("matched_agent_id").references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    attachmentsPath: text("attachments_path"),
    rawHeaders: jsonb("raw_headers").$type<Record<string, unknown>>(),
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdx: index("email_messages_account_idx").on(table.emailAccountId),
    stateIdx: index("email_messages_state_idx").on(table.processingState),
    dedupIdx: uniqueIndex("email_messages_dedup_idx").on(
      table.emailAccountId,
      table.messageIdHeader,
    ),
  }),
);
