import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { emailMessages } from "./email_messages.js";

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    sourceId: text("source_id"),
    sourceEmailMessageId: uuid("source_email_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
    senderIdentifier: text("sender_identifier"),
    content: text("content").notNull(),
    summary: text("summary"),
    intentCategory: text("intent_category"),
    importanceScore: integer("importance_score"),
    memoryType: text("memory_type").notNull().default("passive"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_items_company_idx").on(table.companyId),
    channelIdx: index("memory_items_channel_idx").on(table.sourceChannel),
    senderIdx: index("memory_items_sender_idx").on(table.senderIdentifier),
    typeIdx: index("memory_items_type_idx").on(table.memoryType),
  }),
);
