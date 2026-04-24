import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { applyPendingMigrations } from "../client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";
import { companies } from "../schema/companies.js";
import { clients } from "../schema/clients.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIf = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    await c?.();
  }
});

describeIf("clients schema", () => {
  it(
    "inserts clients, enforces (companyId, emailDomain) uniqueness, cascades on company delete",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("paperclip-clients-");
      cleanups.push(dbh.cleanup);
      const sql = postgres(dbh.connectionString);
      const db = drizzle(sql);
      await applyPendingMigrations(dbh.connectionString);

      const [co] = await db
        .insert(companies)
        .values({ name: "Dev", issuePrefix: "DEV" })
        .returning();

      const [c1] = await db
        .insert(clients)
        .values({
          companyId: co.id,
          name: "Acme",
          emailDomain: "acme.com",
          extraEmails: ["ops@acme-ops.com"],
          trustLevel: "standard",
        })
        .returning();
      expect(c1.emailDomain).toBe("acme.com");
      expect(c1.extraEmails).toEqual(["ops@acme-ops.com"]);

      // Same domain in same company must fail
      await expect(
        db
          .insert(clients)
          .values({ companyId: co.id, name: "Acme 2", emailDomain: "acme.com" }),
      ).rejects.toThrow();

      // Multiple null-domain clients in same company are allowed
      const [c2] = await db.insert(clients).values({ companyId: co.id, name: "One-off A" }).returning();
      const [c3] = await db.insert(clients).values({ companyId: co.id, name: "One-off B" }).returning();
      expect(c2.id).not.toBe(c3.id);

      // Cascade on company delete
      await db.delete(companies).where(eq(companies.id, co.id));
      const after = await db.select().from(clients).where(eq(clients.companyId, co.id));
      expect(after).toHaveLength(0);

      await sql.end();
    },
    20_000,
  );
});
