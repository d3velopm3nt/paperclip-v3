import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatRoutes } from "../routes/chat.js";
import { errorHandler } from "../middleware/index.js";

const mockChatService = vi.hoisted(() => ({
  getOrCreateDispatcherThread: vi.fn(),
  listThreads: vi.fn(),
  listMessages: vi.fn(),
}));

const mockOperatorMessagingService = vi.hoisted(() => ({
  handleInbound: vi.fn(),
}));

vi.mock("../services/chat.js", () => ({ chatService: () => mockChatService }));
vi.mock("../services/operator-messaging.js", () => ({
  operatorMessagingService: () => mockOperatorMessagingService,
}));
vi.mock("./authz.js", () => ({
  assertCompanyAccess: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "user", userId: "u1", companyIds: ["co1"] };
    next();
  });
  app.use(chatRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/chat/threads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns thread list", async () => {
    mockChatService.listThreads.mockResolvedValue([
      { id: "t1", name: "Dispatcher", agentId: null, companyId: "co1", createdAt: new Date() },
    ]);
    const res = await request(createApp()).get("/companies/co1/chat/threads");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Dispatcher");
  });
});

describe("POST /companies/:companyId/chat/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires body", async () => {
    const res = await request(createApp())
      .post("/companies/co1/chat/messages")
      .send({});
    expect(res.status).toBe(400);
  });

  it("calls handleInbound and returns thread", async () => {
    mockChatService.getOrCreateDispatcherThread.mockResolvedValue({
      id: "t1", name: "Dispatcher", agentId: null, companyId: "co1",
    });
    mockOperatorMessagingService.handleInbound.mockResolvedValue(undefined);
    const res = await request(createApp())
      .post("/companies/co1/chat/messages")
      .send({ body: "hello @alice" });
    expect(res.status).toBe(200);
    expect(mockOperatorMessagingService.handleInbound).toHaveBeenCalledOnce();
  });
});
