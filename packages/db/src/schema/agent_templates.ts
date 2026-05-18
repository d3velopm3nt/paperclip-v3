import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    category: text("category").notNull().default("custom"),
    sourceType: text("source_type").notNull().default("custom"),
    agentDefinitions: jsonb("agent_definitions")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    teamStructure: jsonb("team_structure")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUniqueIdx: uniqueIndex("agent_templates_slug_idx").on(table.slug),
  }),
);
