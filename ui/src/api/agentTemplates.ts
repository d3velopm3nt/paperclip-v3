import type {
  AgentTemplate,
  AgentTemplateSummary,
  DeployTemplateResult,
  CreateCustomTemplateInput,
  UpdateTemplateInput,
} from "@paperclipai/shared";
import { api } from "./client";

export interface AgentTemplateSummaryWithCount extends AgentTemplateSummary {
  agentCount: number;
}

export const agentTemplatesApi = {
  list: () => api.get<AgentTemplateSummaryWithCount[]>("/agent-templates"),
  get: (id: string) => api.get<AgentTemplate>(`/agent-templates/${id}`),
  deploy: (id: string, companyId: string) =>
    api.post<DeployTemplateResult>(`/agent-templates/${id}/deploy`, { companyId }),
  create: (input: CreateCustomTemplateInput) =>
    api.post<AgentTemplate>("/agent-templates", input),
  update: (id: string, input: UpdateTemplateInput) =>
    api.put<AgentTemplate>(`/agent-templates/${id}`, input),
  delete: (id: string) => api.delete<{ ok: boolean }>(`/agent-templates/${id}`),
  saveAsTemplate: (input: {
    agentId: string;
    subtree: boolean;
    name: string;
    slug: string;
    description?: string;
    category: string;
  }) => api.post<AgentTemplate>("/agent-templates/save-as-template", input),
};
