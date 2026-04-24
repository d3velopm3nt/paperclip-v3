// v3: per-company plan-gate action policies
import { api } from "./client";

export interface ActionPolicy {
  id: string;
  companyId: string;
  actionType: string;
  requiresApproval: boolean;
  immediateEmail: boolean;
  paramsJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ActionPolicyCreateRequest {
  actionType: string;
  requiresApproval?: boolean;
  immediateEmail?: boolean;
  paramsJson?: Record<string, unknown>;
}

export interface ActionPolicyUpdateRequest {
  requiresApproval?: boolean;
  immediateEmail?: boolean;
  paramsJson?: Record<string, unknown>;
}

export const actionPoliciesApi = {
  list: (companyId: string) =>
    api.get<ActionPolicy[]>(`/companies/${encodeURIComponent(companyId)}/action-policies`),
  create: (companyId: string, data: ActionPolicyCreateRequest) =>
    api.post<ActionPolicy>(`/companies/${encodeURIComponent(companyId)}/action-policies`, data),
  seedDefaults: (companyId: string) =>
    api.post<{ seeded: true; policies: ActionPolicy[] }>(
      `/companies/${encodeURIComponent(companyId)}/action-policies/seed-defaults`,
      {},
    ),
  update: (id: string, data: ActionPolicyUpdateRequest) =>
    api.patch<ActionPolicy>(`/action-policies/${encodeURIComponent(id)}`, data),
  delete: (id: string) =>
    api.delete<void>(`/action-policies/${encodeURIComponent(id)}`),
};
