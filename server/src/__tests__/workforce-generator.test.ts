import { describe, it, expect } from "vitest";
import { generateWorkforce } from "../services/workforce-generator.js";

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

describe("generateWorkforce", () => {
  it("returns agentDefinitions and teamStructure from valid response", async () => {
    const runner = async () => JSON.stringify(VALID_RESPONSE);

    const result = await generateWorkforce("A B2B sales team", runner);

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

  it("throws when runner returns invalid JSON", async () => {
    const runner = async () => "not json at all";
    await expect(generateWorkforce("prompt", runner)).rejects.toThrow();
  });

  it("throws when runner returns JSON failing schema (invalid role)", async () => {
    const bad = {
      ...VALID_RESPONSE,
      agents: [{ ...VALID_RESPONSE.agents[0], role: "CEO" }],
    };
    const runner = async () => JSON.stringify(bad);
    await expect(generateWorkforce("prompt", runner)).rejects.toThrow();
  });

  it("throws when runner rejects", async () => {
    const runner = async () => { throw new Error("claude CLI exited with code 1"); };
    await expect(generateWorkforce("prompt", runner)).rejects.toThrow("claude CLI exited");
  });
});
