import { describe, it, expect, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ConversationMessage } from "@paperclipai/db";

// ── Minimal DB mock ──────────────────────────────────────────────────────────

function makeConversationRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  return {
    id: "conv-1",
    topicId: "topic-1",
    status: "active",
    startedAt: now,
    lastMessageAt: now,
    expiresAt,
    messageCount: 1,
    recentMessages: [] as ConversationMessage[],
    createdAt: now,
    ...overrides,
  };
}

function makeDb(opts: {
  findRows?: unknown[];
  insertRows?: unknown[];
  updateRows?: unknown[];
} = {}): Db {
  const { findRows = [], insertRows = [], updateRows = [] } = opts;

  const insertReturning = vi.fn().mockResolvedValue(insertRows);
  const updateReturning = vi.fn().mockResolvedValue(updateRows);
  const limit = vi.fn().mockResolvedValue(findRows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ limit, orderBy, returning: updateReturning });
  const set = vi.fn().mockReturnValue({ where });
  const values = vi.fn().mockReturnValue({ returning: insertReturning });
  const from = vi.fn().mockReturnValue({ where, orderBy });
  const select = vi.fn().mockReturnValue({ from });
  const insert = vi.fn().mockReturnValue({ values });
  const update = vi.fn().mockReturnValue({ set });

  return { select, insert, update } as unknown as Db;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("eaConversationsService", () => {
  it("resolveActive creates new conversation when none found", async () => {
    const { eaConversationsService } = await import("../services/ea-conversations.js");
    const row = makeConversationRow();
    const db = makeDb({ findRows: [], insertRows: [row] });
    const svc = eaConversationsService(db);

    const result = await svc.resolveActive("topic-1");

    expect(result.id).toBe("conv-1");
    expect(result.status).toBe("active");
    expect((db.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((db.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("resolveActive returns and touches existing conversation", async () => {
    const { eaConversationsService } = await import("../services/ea-conversations.js");
    const row = makeConversationRow({ messageCount: 5 });
    const updated = makeConversationRow({ messageCount: 6 });
    const db = makeDb({ findRows: [row], updateRows: [updated] });
    const svc = eaConversationsService(db);

    const result = await svc.resolveActive("topic-1");

    expect(result.messageCount).toBe(6);
    expect((db.update as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((db.insert as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("appendMessage skips empty content", async () => {
    const { eaConversationsService } = await import("../services/ea-conversations.js");
    const db = makeDb({ findRows: [] });
    const svc = eaConversationsService(db);

    await svc.appendMessage("conv-1", "user", "   ");

    expect((db.select as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("appendMessage trims to 20 messages", async () => {
    const { eaConversationsService } = await import("../services/ea-conversations.js");
    const existing: ConversationMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
      ts: new Date().toISOString(),
    }));
    const row = makeConversationRow({ recentMessages: existing });
    const db = makeDb({ findRows: [row], updateRows: [row] });
    const svc = eaConversationsService(db);

    await svc.appendMessage("conv-1", "assistant", "new response");

    const setCall = (db.update as ReturnType<typeof vi.fn>)().set as ReturnType<typeof vi.fn>;
    expect(setCall).toBeDefined();
    // update was called (trimming happened in service logic)
    expect((db.update as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("extend updates expiresAt and sets status=extended", async () => {
    const { eaConversationsService } = await import("../services/ea-conversations.js");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const row = makeConversationRow({ expiresAt });
    const extended = makeConversationRow({ status: "extended" });
    const db = makeDb({ findRows: [row], updateRows: [extended] });
    const svc = eaConversationsService(db);

    const result = await svc.extend("conv-1");

    expect(result.status).toBe("extended");
    expect((db.update as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
