// v3: clients service — per-company external-party records used by the
// router, plan-gate scoping, and downstream inbound-email → issue wiring.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clients } from "@paperclipai/db";
import { ensureClientFolder } from "./client-storage.js";

export type ClientRow = typeof clients.$inferSelect;

export interface CreateClientInput {
  name: string;
  emailDomain?: string | null;
  extraEmails?: string[];
  trustLevel?: string;
  isMyCompany?: boolean;
  notes?: string | null;
}

export interface UpdateClientInput {
  name?: string;
  emailDomain?: string | null;
  extraEmails?: string[];
  trustLevel?: string;
  isMyCompany?: boolean;
  notes?: string | null;
}

function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip leading @, strip protocol, drop any path.
  const withoutAt = trimmed.replace(/^@+/, "");
  return withoutAt.split("/")[0] ?? null;
}

export function clientService(db: Db) {
  async function list(companyId: string): Promise<ClientRow[]> {
    return db
      .select()
      .from(clients)
      .where(eq(clients.companyId, companyId))
      .orderBy(asc(clients.name));
  }

  async function getById(id: string): Promise<ClientRow | null> {
    const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
    return row ?? null;
  }

  async function create(companyId: string, input: CreateClientInput): Promise<ClientRow> {
    const [row] = await db
      .insert(clients)
      .values({
        companyId,
        name: input.name,
        emailDomain: normaliseDomain(input.emailDomain),
        extraEmails: input.extraEmails ?? [],
        trustLevel: input.trustLevel ?? "standard",
        isMyCompany: input.isMyCompany ?? false,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .returning();
    // Fire-and-forget — folder creation is async and non-blocking
    ensureClientFolder(db, row!.id).catch(() => {});
    return row!;
  }

  async function update(id: string, input: UpdateClientInput): Promise<ClientRow | null> {
    const updates: Partial<ClientRow> & { updatedAt: Date } = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.emailDomain !== undefined) updates.emailDomain = normaliseDomain(input.emailDomain);
    if (input.extraEmails !== undefined) updates.extraEmails = input.extraEmails;
    if (input.trustLevel !== undefined) updates.trustLevel = input.trustLevel;
    if (input.isMyCompany !== undefined) updates.isMyCompany = input.isMyCompany;
    if (input.notes !== undefined) updates.notes = input.notes;
    const [row] = await db.update(clients).set(updates).where(eq(clients.id, id)).returning();
    return row ?? null;
  }

  async function remove(id: string): Promise<void> {
    await db.delete(clients).where(eq(clients.id, id));
  }

  // Finds the best-matching client for an incoming email address within a
  // company: exact match against extraEmails first, then domain match.
  async function matchByEmail(
    companyId: string,
    email: string,
  ): Promise<ClientRow | null> {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return null;
    const rows = await db
      .select()
      .from(clients)
      .where(eq(clients.companyId, companyId));
    const exact = rows.find((r) => (r.extraEmails ?? []).some((e) => e.toLowerCase() === trimmed));
    if (exact) return exact;
    const atIdx = trimmed.lastIndexOf("@");
    if (atIdx === -1) return null;
    const domain = trimmed.slice(atIdx + 1);
    return rows.find((r) => (r.emailDomain ?? "").toLowerCase() === domain) ?? null;
  }

  return { list, getById, create, update, remove, matchByEmail };
}

export type ClientService = ReturnType<typeof clientService>;
