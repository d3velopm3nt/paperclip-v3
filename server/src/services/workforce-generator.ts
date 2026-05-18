import { spawn } from "node:child_process";
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

const SYSTEM_PROMPT = `You generate AI agent workforce configurations. Return ONLY valid JSON matching this exact schema — no markdown fences, no prose, no explanations:

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
- Default adapterType is "ea" unless context strongly suggests otherwise`;

// Nesting guard vars that make `claude` refuse to start when inherited from a parent session
const NESTING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
] as const;

export function runClaude(input: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of NESTING_VARS) delete env[key];

    const child = spawn("claude", ["--print"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.stdin.write(input);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude CLI timed out"));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function generateWorkforce(
  prompt: string,
  runner: (input: string) => Promise<string> = runClaude,
): Promise<GeneratedWorkforce> {
  const input = `${SYSTEM_PROMPT}\n\nUser request: ${prompt}`;
  const text = await runner(input);

  const parsed = JSON.parse(text.trim()) as unknown;
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
