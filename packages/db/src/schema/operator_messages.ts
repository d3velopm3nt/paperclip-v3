import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatThreads } from "./chat_threads.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { rooms } from "./rooms.js";

export const operatorMessages = pgTable(
  "operator_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    direction: text("direction").notNull(),
    platform: text("platform").notNull(),
    source: text("source").notNull().default("email"),
    chatThreadId: uuid("chat_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    fromAgentId: uuid("from_agent_id").references(() => agents.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    rawPayload: jsonb("raw_payload"),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("operator_messages_company_idx").on(table.companyId),
    issueIdx: index("operator_messages_issue_idx").on(table.issueId),
    roomIdx: index("operator_messages_room_idx").on(table.roomId),
    sourceIdx: index("operator_messages_source_idx").on(table.source),
  }),
);
