import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// v3: first-class clients for per-sender policy scoping + inbound routing.
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Primary email domain used for sender matching (e.g. "acme.com"). Can be
    // null when a client is managed purely by assignment.
    emailDomain: text("email_domain"),
    // Extra addresses we still route to this client (individual contacts whose
    // personal domains don't match emailDomain).
    extraEmails: jsonb("extra_emails").$type<string[]>().notNull().default([]),
    trustLevel: text("trust_level").notNull().default("standard"),
    isMyCompany: boolean("is_my_company").notNull().default(false),
    notes: text("notes"),
    // v3: document storage — client folder location
    localPath: text("local_path"),
    driveFolderId: text("drive_folder_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("clients_company_idx").on(table.companyId),
    // Postgres treats NULLs as distinct in unique indexes, so this allows
    // multiple client rows per company with no emailDomain set.
    domainIdx: uniqueIndex("clients_company_email_domain_idx").on(
      table.companyId,
      table.emailDomain,
    ),
  }),
);
