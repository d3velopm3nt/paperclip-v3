import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { operatorMessages } from "./operator_messages.js";

export const messageThreads = pgTable(
  "message_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorMessageId: uuid("operator_message_id")
      .notNull()
      .references(() => operatorMessages.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    threadKey: text("thread_key").notNull(),
  },
  (table) => ({
    msgIdx: index("message_threads_msg_idx").on(table.operatorMessageId),
    platformKeyIdx: index("message_threads_platform_key_idx").on(
      table.platform,
      table.threadKey,
    ),
  }),
);
