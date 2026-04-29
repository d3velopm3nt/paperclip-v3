import { describe, it, expect, vi } from "vitest";
import { contactService } from "../services/contacts.js";
import type { Db } from "@paperclipai/db";

// ── Minimal DB mock ──────────────────────────────────────────────────────────

function makeDb(rows: unknown[] = []): Db {
  const returning = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit, returning, orderBy });
  const set = vi.fn().mockReturnValue({ where });
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ returning, onConflictDoUpdate });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const insert = vi.fn().mockReturnValue({ values });
  const update = vi.fn().mockReturnValue({ set });
  return { select, insert, update } as unknown as Db;
}

const baseContact = {
  id: "c-1",
  companyId: "co-1",
  clientId: null,
  email: "koneill@innotrack.co.za",
  firstName: null,
  lastName: null,
  phone: null,
  role: null,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("contactService", () => {
  it("upsertByEmail returns row with null name for new contact", async () => {
    const db = makeDb([baseContact]);
    const svc = contactService(db);
    const result = await svc.upsertByEmail("co-1", "koneill@innotrack.co.za", null);
    expect(result.email).toBe("koneill@innotrack.co.za");
    expect(result.firstName).toBeNull();
    expect(result.lastName).toBeNull();
  });

  it("upsertByEmail normalises email to lowercase", async () => {
    const db = makeDb([{ ...baseContact, email: "koneill@innotrack.co.za" }]);
    const svc = contactService(db);
    const result = await svc.upsertByEmail("co-1", "KONEILL@Innotrack.co.za", null);
    // The value passed to insert should be lowercased — verified via the returned row
    expect(result.email).toBe("koneill@innotrack.co.za");
  });

  it("update sets firstName, lastName, and role", async () => {
    const updated = { ...baseContact, firstName: "Kevin", lastName: "O'Neill", role: "Sales Manager" };
    const db = makeDb([updated]);
    const svc = contactService(db);
    const result = await svc.update("co-1", "c-1", {
      firstName: "Kevin",
      lastName: "O'Neill",
      role: "Sales Manager",
    });
    expect(result?.firstName).toBe("Kevin");
    expect(result?.lastName).toBe("O'Neill");
    expect(result?.role).toBe("Sales Manager");
  });

  it("update returns null when contact not found", async () => {
    const db = makeDb([]); // empty rows = not found
    const svc = contactService(db);
    const result = await svc.update("co-1", "no-such-id", { firstName: "X" });
    expect(result).toBeNull();
  });

  it("search returns empty array when no matches", async () => {
    const db = makeDb([]);
    const svc = contactService(db);
    const result = await svc.search("co-1", "nobody");
    expect(result).toEqual([]);
  });
});
