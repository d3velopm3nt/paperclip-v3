import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

// v3: Telegram user ↔ app user pairing
export const telegramBindings = pgTable(
  "telegram_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: text("telegram_user_id").notNull(),
    telegramUsername: text("telegram_username"),
    appUserId: text("app_user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    pairingToken: text("pairing_token"),
    pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    telegramUserIdx: index("telegram_bindings_telegram_user_id_idx").on(table.telegramUserId),
    appUserIdx: index("telegram_bindings_app_user_id_idx").on(table.appUserId),
    pairingTokenIdx: index("telegram_bindings_pairing_token_idx").on(table.pairingToken),
  }),
);

export type TelegramBinding = typeof telegramBindings.$inferSelect;
export type NewTelegramBinding = typeof telegramBindings.$inferInsert;
