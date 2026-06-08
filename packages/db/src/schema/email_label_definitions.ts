import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const emailLabelDefinitions = pgTable(
  "email_label_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6b7280"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("email_label_definitions_company_idx").on(table.companyId),
    uniqueName: uniqueIndex("email_label_definitions_company_name_idx").on(
      table.companyId,
      table.name,
    ),
  }),
);
