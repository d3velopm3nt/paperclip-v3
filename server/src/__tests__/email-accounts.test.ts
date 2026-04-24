import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailAccountRoutes } from "../routes/email-accounts.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockList = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockTestConnection = vi.hoisted(() => vi.fn());

vi.mock("../services/email-accounts.js", () => ({
  emailAccountService: () => ({
    list: mockList,
    getById: mockGetById,
    create: mockCreate,
    update: mockUpdate,
    delete: mockDelete,
    testConnection: mockTestConnection,
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", emailAccountRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const ACCOUNT_WITH_PASSWORD = {
  id: "acc-1",
  companyId: "company-1",
  label: "Support inbox",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapUser: "support@example.com",
  imapPasswordEnc: "SHOULD_NEVER_APPEAR",
  imapTls: true,
  folder: "INBOX",
  fromName: "Support",
  fromEmail: "support@example.com",
  replyTo: null,
  pollIntervalSec: 60,
  active: true,
  lastPolledAt: null,
  lastErrorText: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const ACCOUNT_WITHOUT_PASSWORD = (() => {
  const { imapPasswordEnc: _stripped, ...rest } = ACCOUNT_WITH_PASSWORD;
  return rest;
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- LIST ---

  describe("GET /api/companies/:companyId/email-accounts", () => {
    it("returns accounts without imapPasswordEnc", async () => {
      mockList.mockResolvedValue([ACCOUNT_WITH_PASSWORD]);

      const res = await request(createApp())
        .get("/api/companies/company-1/email-accounts");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).not.toHaveProperty("imapPasswordEnc");
      expect(res.body[0].id).toBe("acc-1");
    });

    it("returns 403 when accessing a different company", async () => {
      const res = await request(createApp())
        .get("/api/companies/other-company/email-accounts");

      // local_implicit actor allows all — use a non-local actor to test 403
      const restrictedApp = express();
      restrictedApp.use(express.json());
      restrictedApp.use((req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: "user-1",
          companyIds: ["company-1"],
          source: "session",
          isInstanceAdmin: false,
        };
        next();
      });
      restrictedApp.use("/api", emailAccountRoutes({} as any));
      restrictedApp.use(errorHandler);

      const restrictedRes = await request(restrictedApp)
        .get("/api/companies/other-company/email-accounts");

      expect(restrictedRes.status).toBe(403);
    });
  });

  // --- CREATE ---

  describe("POST /api/companies/:companyId/email-accounts", () => {
    it("creates account and returns it without imapPasswordEnc", async () => {
      mockCreate.mockResolvedValue(ACCOUNT_WITH_PASSWORD);

      const body = {
        label: "Support inbox",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapUser: "support@example.com",
        imapPassword: "secret123",
        imapTls: true,
        folder: "INBOX",
        fromName: "Support",
        fromEmail: "support@example.com",
      };

      const res = await request(createApp())
        .post("/api/companies/company-1/email-accounts")
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty("imapPasswordEnc");
      expect(res.body.id).toBe("acc-1");
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await request(createApp())
        .post("/api/companies/company-1/email-accounts")
        .send({ label: "test" });

      expect(res.status).toBe(400);
    });
  });

  // --- GET BY ID ---

  describe("GET /api/email-accounts/:id", () => {
    it("returns account without imapPasswordEnc", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);

      const res = await request(createApp())
        .get("/api/email-accounts/acc-1");

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("imapPasswordEnc");
      expect(res.body.id).toBe("acc-1");
    });

    it("returns 404 when not found", async () => {
      mockGetById.mockResolvedValue(null);

      const res = await request(createApp())
        .get("/api/email-accounts/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  // --- UPDATE ---

  describe("PATCH /api/email-accounts/:id", () => {
    it("updates account and returns it without imapPasswordEnc", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      mockUpdate.mockResolvedValue({ ...ACCOUNT_WITH_PASSWORD, label: "Updated" });

      const res = await request(createApp())
        .patch("/api/email-accounts/acc-1")
        .send({ label: "Updated" });

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("imapPasswordEnc");
      expect(res.body.label).toBe("Updated");
    });

    it("returns 404 when not found", async () => {
      mockGetById.mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/email-accounts/nonexistent")
        .send({ label: "X" });

      expect(res.status).toBe(404);
    });
  });

  // --- DELETE ---

  describe("DELETE /api/email-accounts/:id", () => {
    it("deletes account and returns 204", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      mockDelete.mockResolvedValue(undefined);

      const res = await request(createApp())
        .delete("/api/email-accounts/acc-1");

      expect(res.status).toBe(204);
    });

    it("returns 404 when not found", async () => {
      mockGetById.mockResolvedValue(null);

      const res = await request(createApp())
        .delete("/api/email-accounts/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  // --- TEST CONNECTION ---

  describe("POST /api/email-accounts/:id/test-connection", () => {
    it("returns ok: true when connection succeeds", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      mockTestConnection.mockResolvedValue({ ok: true });

      const res = await request(createApp())
        .post("/api/email-accounts/acc-1/test-connection");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns ok: false with error when connection fails", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      mockTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

      const res = await request(createApp())
        .post("/api/email-accounts/acc-1/test-connection");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, error: "Connection refused" });
    });

    it("returns 404 when account not found", async () => {
      mockGetById.mockResolvedValue(null);

      const res = await request(createApp())
        .post("/api/email-accounts/nonexistent/test-connection");

      expect(res.status).toBe(404);
    });
  });

  // --- imapPasswordEnc NEVER in ANY response ---

  describe("imapPasswordEnc security", () => {
    it("is never returned in list response", async () => {
      mockList.mockResolvedValue([ACCOUNT_WITH_PASSWORD, ACCOUNT_WITH_PASSWORD]);
      const res = await request(createApp()).get("/api/companies/company-1/email-accounts");
      expect(JSON.stringify(res.body)).not.toContain("imapPasswordEnc");
      expect(JSON.stringify(res.body)).not.toContain("SHOULD_NEVER_APPEAR");
    });

    it("is never returned in create response", async () => {
      mockCreate.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      const res = await request(createApp())
        .post("/api/companies/company-1/email-accounts")
        .send({
          label: "x", imapHost: "h", imapPort: 993, imapUser: "u",
          imapPassword: "p", imapTls: true, folder: "INBOX",
          fromName: "n", fromEmail: "e@e.com",
        });
      expect(JSON.stringify(res.body)).not.toContain("imapPasswordEnc");
      expect(JSON.stringify(res.body)).not.toContain("SHOULD_NEVER_APPEAR");
    });

    it("is never returned in get-by-id response", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      const res = await request(createApp()).get("/api/email-accounts/acc-1");
      expect(JSON.stringify(res.body)).not.toContain("imapPasswordEnc");
      expect(JSON.stringify(res.body)).not.toContain("SHOULD_NEVER_APPEAR");
    });

    it("is never returned in update response", async () => {
      mockGetById.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      mockUpdate.mockResolvedValue(ACCOUNT_WITH_PASSWORD);
      const res = await request(createApp())
        .patch("/api/email-accounts/acc-1")
        .send({ label: "y" });
      expect(JSON.stringify(res.body)).not.toContain("imapPasswordEnc");
      expect(JSON.stringify(res.body)).not.toContain("SHOULD_NEVER_APPEAR");
    });
  });
});
