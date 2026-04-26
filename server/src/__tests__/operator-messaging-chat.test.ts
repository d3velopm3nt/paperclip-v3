import { describe, expect, it } from "vitest";
import { operatorMessagingService } from "../services/operator-messaging.js";

describe("operatorMessagingService.parseMentions", () => {
  const svc = operatorMessagingService(null as never);

  it("parses @mentions as agentNames", () => {
    const result = svc.parseMentions("hey @alice fix this");
    expect(result.agentNames).toContain("alice");
  });

  it("parses #mentions as roomSlugs", () => {
    const result = svc.parseMentions("broadcast to #engineering team");
    expect(result.roomSlugs).toContain("engineering");
  });

  it("@mention also tries room for backward compat", () => {
    const result = svc.parseMentions("@alice-room do something");
    expect(result.roomSlugs).toContain("alice-room");
  });
});
