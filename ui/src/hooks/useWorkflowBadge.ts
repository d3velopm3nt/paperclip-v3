// Sidebar badge for the Email → Workflows entry. Counts the latest run per
// source whose overall status is not "passed" — i.e., something the operator
// might want to look at (in flight, stalled, or failed).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { workflowRunsApi, type WorkflowRun } from "../api/workflowRuns";

const WORKFLOW_TYPE = "inbound_email";
const ATTENTION_STATUSES = new Set(["running", "partial", "failed"]);

export interface WorkflowBadge {
  total: number;
  running: number;
  partial: number;
  failed: number;
  hasFailed: boolean;
}

export function useWorkflowBadge(companyId: string | null): WorkflowBadge {
  const runsQuery = useQuery({
    queryKey: ["workflow-runs", "company", companyId, WORKFLOW_TYPE, "badge"],
    queryFn: () => workflowRunsApi.listForCompany(companyId!, WORKFLOW_TYPE, 100),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });

  return useMemo<WorkflowBadge>(() => {
    const rows: WorkflowRun[] = runsQuery.data ?? [];
    const seen = new Set<string>();
    let running = 0;
    let partial = 0;
    let failed = 0;
    for (const r of rows) {
      if (seen.has(r.sourceId)) continue;
      seen.add(r.sourceId);
      if (!ATTENTION_STATUSES.has(r.overallStatus)) continue;
      if (r.overallStatus === "running") running++;
      else if (r.overallStatus === "partial") partial++;
      else if (r.overallStatus === "failed") failed++;
    }
    const total = running + partial + failed;
    return { total, running, partial, failed, hasFailed: failed > 0 };
  }, [runsQuery.data]);
}
