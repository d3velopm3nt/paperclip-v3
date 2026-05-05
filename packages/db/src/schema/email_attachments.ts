import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { emailMessages } from "./email_messages.js";

// v3: per-file attachment metadata for inbound emails
export const emailAttachments = pgTable(
  "email_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailMessageId: uuid("email_message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    contentId: text("content_id"),
    isInline: boolean("is_inline").notNull().default(false),
    sizeBytes: integer("size_bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    // v3: set when attachment is filed to client/project folder
    filedAt: timestamp("filed_at", { withTimezone: true }),
    filedPath: text("filed_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("email_attachments_message_idx").on(table.emailMessageId),
  }),
);
