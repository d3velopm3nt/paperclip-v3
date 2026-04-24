import { api } from "./client";

export interface Plan {
  id: string;
  companyId: string;
  agentId: string;
  clientId: string | null;
  projectId: string | null;
  actionType: string | null;
  kind: string;
  revision: number;
  sourceEmailMessageId: string | null;
  proposalText: string;
  proposalMeta: Record<string, unknown>;
  confidence: "low" | "medium" | "high";
  proposedAt: string;
  decision: "pending" | "approved" | "rejected" | "revision_requested";
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  issueId: string | null;
  executedAt: string | null;
  executionStatus: "pending" | "success" | "failed";
  executionError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetail extends Plan {
  approval: Record<string, unknown> | null;
}

export type PlanDecisionResponse = Plan & {
  executionError?: string | null;
  createdIssueId?: string | null;
};

export const plansApi = {
  list: (companyId: string, decision?: string) => {
    const qs = decision ? `?decision=${encodeURIComponent(decision)}` : "";
    return api.get<Plan[]>(`/companies/${encodeURIComponent(companyId)}/plans${qs}`);
  },
  get: (id: string) => api.get<PlanDetail>(`/plans/${encodeURIComponent(id)}`),
  decide: (id: string, decision: "approved" | "rejected" | "revision_requested", note?: string) =>
    api.post<PlanDecisionResponse>(`/plans/${encodeURIComponent(id)}/decision`, {
      decision,
      note,
    }),
};
