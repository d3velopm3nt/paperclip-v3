import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const documentSources = pgTable(
  "document_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "local" | "gdrive"
    name: text("name").notNull(),
    localPath: text("local_path"),
    driveFolderId: text("drive_folder_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("document_sources_company_idx").on(table.companyId),
  }),
);
