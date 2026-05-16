import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateWorkforce } from "../services/workforce-generator.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const VALID_RESPONSE = {
  name: "Sales Team",
  slug: "sales-team",
  description: "A B2B sales team.",
  category: "sales",
  agents: [
    {
      tempId: "manager-a1b2",
      name: "Sales Manager",
      role: "orchestrator",
      adapterType: "ea",
      reportsTo: null,
      instructions: "Manage the sales team and set strategy.",
    },
    {
      tempId: "rep-c3d4",
      name: "Account Executive",
      role: "worker",
      adapterType: "ea",
      reportsTo: "manager-a1b2",
      instructions: "Close deals and maintain customer relationships.",
    },
  ],
};

function makeAnthropicResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: content }],
    }),
  };
}

describe("generateWorkforce", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns agentDefinitions and teamStructure from valid Claude response", async () => {
    mockFetch.mockResolvedValue(makeAnthropicResponse(JSON.stringify(VALID_RESPONSE)));

    const result = await generateWorkforce("A B2B sales team", "sk-test");

    expect(result.name).toBe("Sales Team");
    expect(result.slug).toBe("sales-team");
    expect(result.category).toBe("sales");
    expect(result.agentDefinitions).toHaveLength(2);
    expect(result.agentDefinitions[0].tempId).toBe("manager-a1b2");
    expect(result.agentDefinitions[0].instructionsContent).toBe(
      "Manage the sales team and set strategy.",
    );
    expect(result.agentDefinitions[0].adapterConfig).toEqual({});
    expect(result.agentDefinitions[0].skills).toEqual([]);
    expect(result.agentDefinitions[0].budgetMonthlyCents).toBe(0);
    expect(result.teamStructure[0]).toEqual({ tempId: "manager-a1b2", reportsTo: null });
    expect(result.teamStructure[1]).toEqual({ tempId: "rep-c3d4", reportsTo: "manager-a1b2" });
  });

  it("throws when Claude returns invalid JSON", async () => {
    mockFetch.mockResolvedValue(makeAnthropicResponse("not json at all"));
    await expect(generateWorkforce("prompt", "sk-test")).rejects.toThrow();
  });

  it("throws when Claude returns JSON failing schema (invalid role)", async () => {
    const bad = {
      ...VALID_RESPONSE,
      agents: [{ ...VALID_RESPONSE.agents[0], role: "CEO" }],
    };
    mockFetch.mockResolvedValue(makeAnthropicResponse(JSON.stringify(bad)));
    await expect(generateWorkforce("prompt", "sk-test")).rejects.toThrow();
  });

  it("throws when fetch returns non-ok status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    await expect(generateWorkforce("prompt", "sk-test")).rejects.toThrow("Anthropic API error 401");
  });
});
