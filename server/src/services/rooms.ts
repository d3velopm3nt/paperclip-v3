import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rooms, roomMembers } from "@paperclipai/db";

export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;

export interface RoomDetail extends RoomRow {
  members: RoomMemberRow[];
}

export interface CreateRoomInput {
  name: string;
  slug: string;
  description?: string | null;
  requireApproval?: boolean;
}

export interface AddMemberInput {
  agentId?: string | null;
  isOperator?: boolean;
  notifyOnMessage?: boolean;
}

export function roomService(db: Db) {
  async function list(companyId: string): Promise<RoomRow[]> {
    return db
      .select()
      .from(rooms)
      .where(eq(rooms.companyId, companyId))
      .orderBy(asc(rooms.name));
  }

  async function getById(id: string): Promise<RoomDetail | null> {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
    if (!room) return null;
    const members = await db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, id))
      .orderBy(asc(roomMembers.id));
    return { ...room, members };
  }

  async function findBySlug(companyId: string, slug: string): Promise<RoomRow | null> {
    const [row] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.companyId, companyId), eq(rooms.slug, slug)))
      .limit(1);
    return row ?? null;
  }

  async function create(companyId: string, input: CreateRoomInput): Promise<RoomRow> {
    const [row] = await db
      .insert(rooms)
      .values({
        companyId,
        name: input.name,
        slug: input.slug.toLowerCase().replace(/\s+/g, "-"),
        description: input.description ?? null,
        requireApproval: input.requireApproval ?? false,
        updatedAt: new Date(),
      })
      .returning();
    return row!;
  }

  async function update(id: string, input: Partial<CreateRoomInput>): Promise<RoomRow | null> {
    const [row] = await db
      .update(rooms)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(rooms.id, id))
      .returning();
    return row ?? null;
  }

  async function remove(id: string): Promise<void> {
    await db.delete(rooms).where(eq(rooms.id, id));
  }

  async function addMember(roomId: string, input: AddMemberInput): Promise<RoomMemberRow> {
    const [row] = await db
      .insert(roomMembers)
      .values({
        roomId,
        agentId: input.agentId ?? null,
        isOperator: input.isOperator ?? false,
        notifyOnMessage: input.notifyOnMessage ?? true,
      })
      .returning();
    return row!;
  }

  async function removeMember(memberId: string): Promise<void> {
    await db.delete(roomMembers).where(eq(roomMembers.id, memberId));
  }

  return { list, getById, findBySlug, create, update, remove, addMember, removeMember };
}
