export interface AgentTemplateDefinition {
  tempId: string;
  name: string;
  role: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  capabilities?: string | null;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  instructionsBundleDir?: string | null;
  instructionsContent?: string | null;
  skills: string[];
}

export interface TeamStructureEntry {
  tempId: string;
  reportsTo: string | null;
}

export interface AgentTemplate {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  sourceType: "built_in" | "custom";
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplateSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  sourceType: "built_in" | "custom";
  agentCount: number;
  metadata: Record<string, unknown> | null;
}

export interface DeployTemplateResult {
  agentIds: string[];
  agentNames: string[];
}

export interface CreateCustomTemplateInput {
  name: string;
  slug: string;
  description?: string;
  category: string;
  agentDefinitions: AgentTemplateDefinition[];
  teamStructure: TeamStructureEntry[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  agentDefinitions?: AgentTemplateDefinition[];
  teamStructure?: TeamStructureEntry[];
  metadata?: Record<string, unknown>;
}
