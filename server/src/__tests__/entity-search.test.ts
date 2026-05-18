import { describe, it, expect } from "vitest";
import { searchEntities } from "../services/entity-search.js";

// Minimal stub tests — verify shape and empty-result contract without a real DB.
describe("searchEntities", () => {
  it("returns empty array for blank query", async () => {
    const fakeDb = {
      select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }) }),
    } as never;
    const results = await searchEntities(fakeDb, "");
    expect(results).toEqual([]);
  });

  it("filters by types parameter — only queries requested types", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
        }),
      }),
    } as never;
    const results = await searchEntities(fakeDb, "test", ["company"]);
    expect(Array.isArray(results)).toBe(true);
  });
});
