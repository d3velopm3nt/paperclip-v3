import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { agentTemplates, agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type {
  AgentTemplateDefinition,
  TeamStructureEntry,
  DeployTemplateResult,
} from "@paperclipai/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveTemplatesRoot(): string {
  return path.resolve(__dirname, "../onboarding-assets/templates");
}

function resolveTemplateInstructionsRoot(agentId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "ea", agentId, "instructions");
}

async function seedInstructionFiles(agentId: string, bundleDir: string, templateSlug: string): Promise<void> {
  const src = path.join(resolveTemplatesRoot(), templateSlug, bundleDir);
  const dest = resolveTemplateInstructionsRoot(agentId);
  await fs.mkdir(dest, { recursive: true });
  let entries: string[] = [];
  try {
    entries = await fs.readdir(src);
  } catch {
    return;
  }
  for (const entry of entries) {
    const content = await fs.readFile(path.join(src, entry), "utf-8");
    await fs.writeFile(path.join(dest, entry), content, "utf-8");
  }
}

async function writeInlineInstructions(agentId: string, content: string): Promise<void> {
  const dest = resolveTemplateInstructionsRoot(agentId);
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, "AGENTS.md"), content, "utf-8");
}

function buildBundleAdapterConfig(agentId: string): Record<string, unknown> {
  const root = resolveTemplateInstructionsRoot(agentId);
  return {
    instructionsBundleMode: "external",
    instructionsRootPath: root,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: path.join(root, "AGENTS.md"),
  };
}

export function agentTemplatesService(db: Db) {
  async function seedAgentTemplates(): Promise<void> {
    const templatesRoot = resolveTemplatesRoot();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(templatesRoot);
    } catch {
      return;
    }

    for (const dirName of entries) {
      const jsonPath = path.join(templatesRoot, dirName, "template.json");
      let raw: string;
      try {
        raw = await fs.readFile(jsonPath, "utf-8");
      } catch {
        continue;
      }
      const def = JSON.parse(raw) as {
        name: string;
        slug: string;
        description?: string;
        category: string;
        sourceType: string;
        metadata?: Record<string, unknown>;
        agentDefinitions: Record<string, unknown>[];
        teamStructure: Record<string, unknown>[];
      };

      const [existing] = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.slug, def.slug))
        .limit(1);

      if (!existing) {
        await db.insert(agentTemplates).values({
          name: def.name,
          slug: def.slug,
          description: def.description ?? null,
          category: def.category,
          sourceType: def.sourceType as "built_in" | "custom",
          agentDefinitions: def.agentDefinitions,
          teamStructure: def.teamStructure,
          metadata: def.metadata ?? null,
        });
      } else {
        const meta = (existing.metadata ?? {}) as Record<string, unknown>;
        if (meta.customized === true) continue;
        const existingVersion = typeof meta.version === "number" ? meta.version : 0;
        const newVersion = typeof def.metadata?.version === "number" ? def.metadata.version : 0;
        if (newVersion > existingVersion) {
          await db
            .update(agentTemplates)
            .set({
              name: def.name,
              description: def.description ?? null,
              agentDefinitions: def.agentDefinitions,
              teamStructure: def.teamStructure,
              metadata: def.metadata ?? null,
              updatedAt: new Date(),
            })
            .where(eq(agentTemplates.slug, def.slug));
        }
      }
    }
  }

  async function deployTemplate(templateId: string, companyId: string): Promise<DeployTemplateResult> {
    const [template] = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.id, templateId))
      .limit(1);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const defs = template.agentDefinitions as unknown as AgentTemplateDefinition[];
    const structure = template.teamStructure as unknown as TeamStructureEntry[];

    return await db.transaction(async (tx) => {
      const tempIdToRealId = new Map<string, string>();
      const agentNames: string[] = [];

      for (const def of defs) {
        const [created] = await tx
          .insert(agents)
          .values({
            companyId,
            name: def.name,
            role: def.role,
            adapterType: def.adapterType,
            adapterConfig: def.adapterConfig ?? {},
            runtimeConfig: {},
            capabilities: def.capabilities ?? null,
            permissions: def.permissions ?? {},
            budgetMonthlyCents: def.budgetMonthlyCents ?? 0,
            spentMonthlyCents: 0,
            status: "idle",
          })
          .returning({ id: agents.id });

        if (!created) continue;

        if (def.instructionsBundleDir) {
          await seedInstructionFiles(created.id, def.instructionsBundleDir, template.slug);
          const adapterConfig = buildBundleAdapterConfig(created.id);
          await tx
            .update(agents)
            .set({ adapterConfig, updatedAt: new Date() })
            .where(eq(agents.id, created.id));
        } else if (def.instructionsContent) {
          await writeInlineInstructions(created.id, def.instructionsContent);
          const adapterConfig = buildBundleAdapterConfig(created.id);
          await tx
            .update(agents)
            .set({ adapterConfig, updatedAt: new Date() })
            .where(eq(agents.id, created.id));
        }

        tempIdToRealId.set(def.tempId, created.id);
        agentNames.push(def.name);
      }

      for (const entry of structure) {
        if (!entry.reportsTo) continue;
        const agentId = tempIdToRealId.get(entry.tempId);
        const reportsToId = tempIdToRealId.get(entry.reportsTo);
        if (agentId && reportsToId) {
          await tx
            .update(agents)
            .set({ reportsTo: reportsToId, updatedAt: new Date() })
            .where(eq(agents.id, agentId));
        }
      }

      return { agentIds: Array.from(tempIdToRealId.values()), agentNames };
    });
  }

  async function saveAsTemplate(
    agentId: string,
    opts: {
      subtree: boolean;
      name: string;
      slug: string;
      description?: string;
      category: string;
    },
  ) {
    async function collectAgents(rootId: string): Promise<typeof agents.$inferSelect[]> {
      const [root] = await db.select().from(agents).where(eq(agents.id, rootId)).limit(1);
      if (!root) return [];
      if (!opts.subtree) return [root];
      const reports = await db.select().from(agents).where(eq(agents.reportsTo, rootId));
      const nested = await Promise.all(reports.map((r) => collectAgents(r.id)));
      return [root, ...nested.flat()];
    }

    const collected = await collectAgents(agentId);
    if (collected.length === 0) throw new Error(`Agent ${agentId} not found`);

    const agentDefinitions: AgentTemplateDefinition[] = collected.map((a) => ({
      tempId: a.id,
      name: a.name,
      role: a.role,
      adapterType: a.adapterType,
      adapterConfig: (a.adapterConfig ?? {}) as Record<string, unknown>,
      capabilities: a.capabilities ?? null,
      permissions: (a.permissions ?? {}) as Record<string, unknown>,
      budgetMonthlyCents: a.budgetMonthlyCents,
      instructionsBundleDir: null,
      instructionsContent: null,
      skills: [],
    }));

    const teamStructure: TeamStructureEntry[] = collected.map((a) => ({
      tempId: a.id,
      reportsTo: a.reportsTo ?? null,
    }));

    const [created] = await db
      .insert(agentTemplates)
      .values({
        name: opts.name,
        slug: opts.slug,
        description: opts.description ?? null,
        category: opts.category,
        sourceType: "custom",
        agentDefinitions: agentDefinitions as unknown as Record<string, unknown>[],
        teamStructure: teamStructure as unknown as Record<string, unknown>[],
        metadata: null,
      })
      .returning();

    return created;
  }

  async function listTemplates() {
    const rows = await db.select().from(agentTemplates);
    return rows.map((r) => ({
      ...r,
      agentCount: (r.agentDefinitions as unknown[]).length,
    }));
  }

  async function getTemplate(id: string) {
    const [row] = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .limit(1);
    return row ?? null;
  }

  async function updateTemplate(
    id: string,
    input: {
      name?: string;
      description?: string;
      category?: string;
      agentDefinitions?: Record<string, unknown>[];
      teamStructure?: Record<string, unknown>[];
      metadata?: Record<string, unknown>;
    },
  ) {
    const [existing] = await db
      .select({ metadata: agentTemplates.metadata, sourceType: agentTemplates.sourceType })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .limit(1);
    if (!existing) return null;

    const updatedMeta =
      existing.sourceType === "built_in"
        ? { ...(existing.metadata ?? {}), ...(input.metadata ?? {}), customized: true }
        : { ...(existing.metadata ?? {}), ...(input.metadata ?? {}) };

    const patch: Record<string, unknown> = { updatedAt: new Date(), metadata: updatedMeta };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.category !== undefined) patch.category = input.category;
    if (input.agentDefinitions !== undefined) patch.agentDefinitions = input.agentDefinitions;
    if (input.teamStructure !== undefined) patch.teamStructure = input.teamStructure;

    const [updated] = await db
      .update(agentTemplates)
      .set(patch as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(eq(agentTemplates.id, id))
      .returning();
    return updated ?? null;
  }

  async function deleteTemplate(id: string): Promise<boolean> {
    const [row] = await db
      .select({ sourceType: agentTemplates.sourceType })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .limit(1);
    if (!row) return false;
    if (row.sourceType === "built_in") throw new Error("Built-in templates cannot be deleted");
    await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
    return true;
  }

  return {
    seedAgentTemplates,
    deployTemplate,
    saveAsTemplate,
    listTemplates,
    getTemplate,
    updateTemplate,
    deleteTemplate,
  };
}
