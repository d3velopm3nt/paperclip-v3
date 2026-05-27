import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// v3: Telegram bot configuration (null companyId = global bot)
export const telegramBots = pgTable(
  "telegram_bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    botTokenEnc: text("bot_token_enc").notNull(),
    botUsername: text("bot_username").notNull(),
    deliveryMode: text("delivery_mode").notNull().default("longpoll"), // longpoll | webhook
    webhookSecret: text("webhook_secret"),
    publicBaseUrl: text("public_base_url"),
    allowlist: jsonb("allowlist").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastOffset: integer("last_offset").default(0),
    lastErrorText: text("last_error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("telegram_bots_company_id_idx").on(table.companyId),
    activeIdx: index("telegram_bots_active_idx").on(table.active),
  }),
);

export type TelegramBot = typeof telegramBots.$inferSelect;
export type NewTelegramBot = typeof telegramBots.$inferInsert;
