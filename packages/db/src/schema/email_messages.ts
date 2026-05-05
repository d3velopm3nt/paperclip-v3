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
import { contacts } from "./contacts.js";

// v3: email monitoring — inbound mail archive + processing state
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailAccountId: uuid("email_account_id")
      .notNull()
      .references(() => emailAccounts.id, { onDelete: "cascade" }),
    messageIdHeader: text("message_id_header").notNull(),
    // v3: RFC-2822 threading headers — let routeInbound continue an existing
    // triage issue when a client replies, instead of creating a new one.
    inReplyToHeader: text("in_reply_to_header"),
    referencesHeaders: jsonb("references_headers").$type<string[]>().notNull().default([]),
    fromAddr: text("from_addr").notNull(),
    toAddrs: jsonb("to_addrs").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    // v3: raw HTML body stored separately for rich rendering with inline images
    htmlBody: text("html_body"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // pending | analyzing | plan_proposed | clarifying | approved | declined | executed | ignored | error
    processingState: text("processing_state").notNull().default("pending"),
    matchedCompanyId: uuid("matched_company_id").references(() => companies.id),
    matchedAgentId: uuid("matched_agent_id").references(() => agents.id),
    // v3: client resolved from sender domain — enables per-client routing & policies
    matchedClientId: uuid("matched_client_id"),
    matchedContactId: uuid("matched_contact_id").references(() => contacts.id, { onDelete: "set null" }),
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
    inReplyToIdx: index("email_messages_in_reply_to_idx").on(table.inReplyToHeader),
    dedupIdx: uniqueIndex("email_messages_dedup_idx").on(
      table.emailAccountId,
      table.messageIdHeader,
    ),
  }),
);
