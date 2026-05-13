import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companies, clients } from "@paperclipai/db";
import { hasStorageRoot, backfillClientAttachments } from "../services/client-storage.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping client-storage tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("client-storage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-client-storage-");
    db = createDb(tempDb.connectionString);
    const [co] = await db.insert(companies).values({ name: "Test Co" }).returning();
    companyId = co!.id;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("hasStorageRoot", () => {
    it("returns false when no root configured", async () => {
      expect(await hasStorageRoot(db, companyId)).toBe(false);
    });

    it("returns true when localPath set", async () => {
      await db.update(companies)
        .set({ storageLocalPath: "/tmp/test" })
        .where(eq(companies.id, companyId));
      expect(await hasStorageRoot(db, companyId)).toBe(true);
    });
  });

  describe("backfillClientAttachments", () => {
    it("no-ops when client has no localPath or driveFolderId", async () => {
      const [client] = await db.insert(clients).values({ companyId, name: "Acme" }).returning();
      await expect(backfillClientAttachments(db, client!.id)).resolves.toBeUndefined();
    });
  });
});
