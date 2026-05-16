import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const documentSources = pgTable(
  "document_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // v3: optional scope — null = company-wide, set = scoped to client/project
    clientId: uuid("client_id"),
    projectId: uuid("project_id"),
    type: text("type").notNull(), // "local" | "gdrive" | "github"
    name: text("name").notNull(),
    localPath: text("local_path"),
    driveFolderId: text("drive_folder_id"),
    githubRepoUrl: text("github_repo_url"),
    githubBranch: text("github_branch").default("main"),
    githubToken: text("github_token"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("document_sources_company_idx").on(table.companyId),
    clientIdx: index("document_sources_client_idx").on(table.clientId),
    projectIdx: index("document_sources_project_idx").on(table.projectId),
  }),
);
