import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// v3: email monitoring — per-company IMAP config
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    // v3: role drives behavior — inbound accounts are IMAP-polled and
    // their SMTP is used for client replies; agent_voice accounts are
    // not polled and used only for operator/team notifications.
    role: text("role").notNull().default("inbound"),
    // v3: addresses the agent may CC or directly email when asking the team
    // for clarification, and where plan-pending notifications are sent.
    teamEmails: jsonb("team_emails").$type<string[]>().notNull().default([]),
    // v3: optional per-inbox triage agent override. When null,
    // routeInbound falls back to the company's role='ceo' agent.
    triageAgentId: uuid("triage_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    // v3: optional override — when a client reply is sent, use this account's
    // SMTP instead of the inbox that received the mail. Null = reply from self.
    replyFromAccountId: uuid("reply_from_account_id"),
    // v3: auto-acknowledge inbound emails so the sender knows a human/agent
    // is looking at it. Optional per-inbox; disabled by default.
    autoAcknowledge: boolean("auto_acknowledge").notNull().default(false),
    ackSubject: text("ack_subject"),
    ackBody: text("ack_body"),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapUser: text("imap_user").notNull(),
    imapPasswordEnc: text("imap_password_enc").notNull(),
    imapTls: boolean("imap_tls").notNull().default(true),
    // v3: SMTP outbound — nullable so existing rows remain valid
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpUser: text("smtp_user"),
    smtpPasswordEnc: text("smtp_password_enc"),
    smtpSecure: boolean("smtp_secure").notNull().default(false),
    folder: text("folder").notNull().default("INBOX"),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),
    replyTo: text("reply_to"),
    pollIntervalSec: integer("poll_interval_sec").notNull().default(60),
    active: boolean("active").notNull().default(true),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastErrorText: text("last_error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("email_accounts_company_idx").on(table.companyId),
    activeIdx: index("email_accounts_active_idx").on(table.active),
  }),
);
