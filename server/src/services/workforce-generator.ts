import { z } from "zod";
import type { AgentTemplateDefinition, TeamStructureEntry } from "@paperclipai/shared";

const GeneratedAgentSchema = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["orchestrator", "worker", "observer"]),
  adapterType: z.enum(["ea", "claude_local", "codex_local", "gemini_local", "cursor", "opencode_local"]),
  reportsTo: z.string().nullable(),
  instructions: z.string().min(1),
});

const GeneratedWorkforceSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  category: z.enum(["dev", "sales", "finance", "support", "custom"]),
  agents: z.array(GeneratedAgentSchema).min(1),
});

export interface GeneratedWorkforce {
  name: string;
  slug: string;
  description: string;
  category: string;
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
}

const SYSTEM_PROMPT = `You generate AI agent workforce configurations. Return ONLY valid JSON matching this exact schema:

{
  "name": "string",
  "slug": "string (lowercase letters, digits, hyphens only — e.g. 'sales-team')",
  "description": "string (one sentence)",
  "category": "dev" | "sales" | "finance" | "support" | "custom",
  "agents": [
    {
      "tempId": "string (slugified name + 4 random chars — e.g. 'tech-lead-a1b2')",
      "name": "string",
      "role": "orchestrator" | "worker" | "observer",
      "adapterType": "ea" | "claude_local" | "codex_local" | "gemini_local" | "cursor" | "opencode_local",
      "reportsTo": "tempId of parent" | null,
      "instructions": "string (2-4 sentences describing role responsibilities)"
    }
  ]
}

Rules:
- Exactly one agent must have reportsTo: null (the root orchestrator)
- All other reportsTo values must be a valid tempId in the same agents array
- Default adapterType is "ea" unless context strongly suggests otherwise
- Return valid JSON only — no markdown fences, no prose, no explanations`;

export async function generateWorkforce(
  prompt: string,
  apiKey: string,
): Promise<GeneratedWorkforce> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const block = data.content[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Unexpected response type from Anthropic API");
  }

  const parsed = JSON.parse(block.text) as unknown;
  const validated = GeneratedWorkforceSchema.parse(parsed);

  const agentDefinitions: AgentTemplateDefinition[] = validated.agents.map((a) => ({
    tempId: a.tempId,
    name: a.name,
    role: a.role,
    adapterType: a.adapterType,
    adapterConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    skills: [],
    instructionsContent: a.instructions,
  }));

  const teamStructure: TeamStructureEntry[] = validated.agents.map((a) => ({
    tempId: a.tempId,
    reportsTo: a.reportsTo,
  }));

  return {
    name: validated.name,
    slug: validated.slug,
    description: validated.description,
    category: validated.category,
    agentDefinitions,
    teamStructure,
  };
}
