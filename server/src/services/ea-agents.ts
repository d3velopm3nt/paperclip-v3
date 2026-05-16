import fs from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";

// Bump this when the prompt changes to force a re-seed of existing agents.
const PROMPT_VERSION = 7;

export interface EaAgentMetadata {
  currentTopicId?: string;
  currentTopicName?: string;
  lastMessagePreview?: string;
  claudeSessionId?: string;
}

type EaBundleRole = "ea-operator" | "ea-client";

function resolveEaInstructionsRoot(agentId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "ea", agentId, "instructions");
}

async function seedEaInstructionFiles(agentId: string, role: EaBundleRole, overwrite: boolean): Promise<string> {
  const root = resolveEaInstructionsRoot(agentId);
  await fs.mkdir(root, { recursive: true });

  const files = await loadDefaultAgentInstructionsBundle(role);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    if (overwrite) {
      await fs.writeFile(filePath, content, "utf-8");
    } else {
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, content, "utf-8");
      }
    }
  }

  return path.join(root, "AGENTS.md");
}

function buildBundleAdapterConfig(agentId: string): Record<string, unknown> {
  const root = resolveEaInstructionsRoot(agentId);
  return {
    instructionsBundleMode: "external",
    instructionsRootPath: root,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: path.join(root, "AGENTS.md"),
    promptVersion: PROMPT_VERSION,
  };
}

export function eaAgentsService(db: Db) {
  async function listEaAgents() {
    return db
      .select()
      .from(agents)
      .where(and(isNull(agents.companyId), eq(agents.adapterType, "ea")));
  }

  async function getEaAgent(role: "operator" | "client") {
    const name =
      role === "operator" ? "Executive Control Agent" : "Client Control Agent";
    const rows = await db
      .select()
      .from(agents)
      .where(
        and(isNull(agents.companyId), eq(agents.adapterType, "ea"), eq(agents.name, name)),
      );
    return rows[0] ?? null;
  }

  async function seedEaAgents() {
    const existing = await listEaAgents();
    const existingByName = new Map(existing.map((a) => [a.name, a]));

    const seedData: Array<{ name: string; bundleRole: EaBundleRole }> = [
      { name: "Executive Control Agent", bundleRole: "ea-operator" },
      { name: "Client Control Agent", bundleRole: "ea-client" },
    ];

    for (const seed of seedData) {
      const existingAgent = existingByName.get(seed.name);
      if (!existingAgent) {
        const [created] = await db.insert(agents).values({
          name: seed.name,
          role: "orchestrator",
          adapterType: "ea",
          companyId: null,
          adapterConfig: { promptVersion: PROMPT_VERSION },
          runtimeConfig: {},
          permissions: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          status: "idle",
        }).returning({ id: agents.id });

        if (created) {
          await seedEaInstructionFiles(created.id, seed.bundleRole, false);
          const bundleConfig = buildBundleAdapterConfig(created.id);
          await db.update(agents).set({ adapterConfig: bundleConfig, updatedAt: new Date() }).where(eq(agents.id, created.id));
        }
      } else {
        const existingConfig = (existingAgent.adapterConfig ?? {}) as Record<string, unknown>;
        const existingVersion = typeof existingConfig.promptVersion === "number" ? existingConfig.promptVersion : 0;
        if (existingVersion < PROMPT_VERSION) {
          await seedEaInstructionFiles(existingAgent.id, seed.bundleRole, true);
          const bundleConfig = buildBundleAdapterConfig(existingAgent.id);
          await db.update(agents).set({ adapterConfig: bundleConfig, updatedAt: new Date() }).where(eq(agents.id, existingAgent.id));
        }
      }
    }
  }

  async function setProcessing(
    id: string,
    topicId: string,
    topicName: string,
    messagePreview: string,
  ) {
    await db
      .update(agents)
      .set({
        status: "processing",
        metadata: {
          currentTopicId: topicId,
          currentTopicName: topicName,
          lastMessagePreview: messagePreview.slice(0, 120),
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));
  }

  async function setIdle(id: string, opts?: { clearSession?: boolean }) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, id)).limit(1);
    const existing = (row?.metadata ?? {}) as EaAgentMetadata;
    const keepSession = !opts?.clearSession && !!existing.claudeSessionId;
    await db
      .update(agents)
      .set({
        status: "idle",
        metadata: keepSession ? { claudeSessionId: existing.claudeSessionId } : {},
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id));
  }

  async function saveSessionId(id: string, sessionId: string) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, id)).limit(1);
    const existing = (row?.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(agents)
      .set({ metadata: { ...existing, claudeSessionId: sessionId }, updatedAt: new Date() })
      .where(eq(agents.id, id));
  }

  return { listEaAgents, getEaAgent, seedEaAgents, setProcessing, setIdle, saveSessionId };
}
