import { api } from "./client";

export type StageStatus = "passed" | "failed" | "pending" | "skipped" | "unknown";

export interface WorkflowRun {
  id: string;
  companyId: string;
  workflowType: string;
  sourceTable: string;
  sourceId: string;
  overallStatus: "running" | "passed" | "failed" | "partial";
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface WorkflowStageResult {
  id: string;
  runId: string;
  stageId: string;
  parentStageId: string | null;
  branch: string | null;
  label: string;
  status: StageStatus;
  expectations: string[];
  actuals: Record<string, unknown>;
  errorText: string | null;
  ord: number;
  computedAt: string;
}

export interface WorkflowRunWithStages {
  run: WorkflowRun;
  stages: WorkflowStageResult[];
}

export const workflowRunsApi = {
  listForCompany: (companyId: string, type?: string, limit = 50) => {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    qs.set("limit", String(limit));
    return api.get<WorkflowRun[]>(
      `/companies/${encodeURIComponent(companyId)}/workflow-runs?${qs.toString()}`,
    );
  },
  listBySource: (workflowType: string, sourceId: string, limit = 10) =>
    api.get<WorkflowRun[]>(
      `/workflow-runs/by-source/${encodeURIComponent(workflowType)}/${encodeURIComponent(sourceId)}?limit=${limit}`,
    ),
  get: (id: string) => api.get<WorkflowRunWithStages>(`/workflow-runs/${encodeURIComponent(id)}`),
  run: (workflowType: string, sourceId: string) =>
    api.post<WorkflowRunWithStages>(
      `/workflow-runs/${encodeURIComponent(workflowType)}/${encodeURIComponent(sourceId)}/run`,
      {},
    ),
};
