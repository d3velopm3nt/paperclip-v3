import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const blockedSenderDomains = pgTable(
  "blocked_sender_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("blocked_sender_domains_company_idx").on(table.companyId),
    uniqueDomain: uniqueIndex("blocked_sender_domains_company_domain_idx").on(
      table.companyId,
      table.domain,
    ),
  }),
);
