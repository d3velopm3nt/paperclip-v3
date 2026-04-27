import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const referenceDocuments = pgTable(
  "reference_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    mimeType: text("mime_type"),
    sourceType: text("source_type").notNull().default("upload"), // "local" | "gdrive" | "upload"
    sourcePath: text("source_path"),
    driveFileId: text("drive_file_id"),
    driveWebUrl: text("drive_web_url"),
    extractedText: text("extracted_text"),
    checksum: text("checksum"),
    scope: text("scope").notNull().default("company"), // "company" | "project"
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    includeInContext: boolean("include_in_context").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("reference_documents_company_idx").on(table.companyId, table.updatedAt),
    projectIdx: index("reference_documents_project_idx").on(table.projectId),
    driveFileIdx: index("reference_documents_drive_file_idx").on(table.driveFileId),
    sourcePathIdx: index("reference_documents_source_path_idx").on(table.sourcePath),
  }),
);
