import { boolean, index, pgTable, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { rooms } from "./rooms.js";

export const roomMembers = pgTable(
  "room_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    isOperator: boolean("is_operator").notNull().default(false),
    notifyOnMessage: boolean("notify_on_message").notNull().default(true),
  },
  (table) => ({
    roomIdx: index("room_members_room_idx").on(table.roomId),
    agentIdx: index("room_members_agent_idx").on(table.agentId),
  }),
);
