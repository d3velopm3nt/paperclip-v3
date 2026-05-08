import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { eccTopics } from "./ecc_topics.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  ts: string; // ISO string
}

export const eccConversations = pgTable(
  "ecc_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => eccTopics.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // active | expired | extended
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    recentMessages: jsonb("recent_messages")
      .$type<ConversationMessage[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    topicStatusIdx: index("ecc_conversations_topic_status_idx").on(
      table.topicId,
      table.status,
    ),
    expiresIdx: index("ecc_conversations_expires_idx").on(table.expiresAt),
    topicLastMsgIdx: index("ecc_conversations_topic_last_msg_idx").on(
      table.topicId,
      table.lastMessageAt,
    ),
  }),
);
