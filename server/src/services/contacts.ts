import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { contacts } from "@paperclipai/db";

export type ContactRow = typeof contacts.$inferSelect;

export interface UpdateContactInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  role?: string | null;
  notes?: string | null;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function contactService(db: Db) {
  // Insert or update contact stub for this email address.
  // Name fields start null — filled via update_contact MCP tool.
  // On conflict: preserve any existing name, upgrade clientId if now known.
  async function upsertByEmail(
    companyId: string,
    email: string,
    clientId: string | null,
  ): Promise<ContactRow> {
    const normEmail = normaliseEmail(email);
    const [row] = await db
      .insert(contacts)
      .values({ companyId, clientId, email: normEmail, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [contacts.companyId, contacts.email],
        set: {
          clientId: sql`COALESCE(EXCLUDED.client_id, contacts.client_id)`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  async function list(companyId: string): Promise<ContactRow[]> {
    return db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, companyId))
      .orderBy(asc(contacts.lastName), asc(contacts.firstName), asc(contacts.email));
  }

  async function getById(companyId: string, id: string): Promise<ContactRow | null> {
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.companyId, companyId)))
      .limit(1);
    return row ?? null;
  }

  async function listUnnamed(companyId: string): Promise<ContactRow[]> {
    return db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.companyId, companyId),
          isNull(contacts.firstName),
          isNull(contacts.lastName),
        ),
      )
      .orderBy(asc(contacts.email));
  }

  async function search(companyId: string, query: string): Promise<ContactRow[]> {
    const q = `%${query.trim()}%`;
    return db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.companyId, companyId),
          or(
            ilike(contacts.firstName, q),
            ilike(contacts.lastName, q),
            ilike(contacts.email, q),
          ),
        ),
      )
      .orderBy(asc(contacts.lastName), asc(contacts.firstName));
  }

  async function update(
    companyId: string,
    id: string,
    input: UpdateContactInput,
  ): Promise<ContactRow | null> {
    const patch: Partial<ContactRow> & { updatedAt: Date } = { updatedAt: new Date() };
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.role !== undefined) patch.role = input.role;
    if (input.notes !== undefined) patch.notes = input.notes;
    const [row] = await db
      .update(contacts)
      .set(patch)
      .where(and(eq(contacts.id, id), eq(contacts.companyId, companyId)))
      .returning();
    return row ?? null;
  }

  async function remove(companyId: string, id: string): Promise<void> {
    await db.delete(contacts).where(and(eq(contacts.id, id), eq(contacts.companyId, companyId)));
  }

  return { upsertByEmail, list, getById, listUnnamed, search, update, remove };
}

export type ContactService = ReturnType<typeof contactService>;
