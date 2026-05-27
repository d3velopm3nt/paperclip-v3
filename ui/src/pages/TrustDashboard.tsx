// v3: trust dashboard — agent trust levels, promotion requests, skill auto-approve status
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import { ShieldCheck, TrendingUp, CheckCircle2, Clock } from "lucide-react";

interface AgentTrustLevel {
  agentId: string;
  agentName: string;
  actionType: string;
  approvedCount: number;
  declinedCount: number;
  lowScoreCount: number;
  trustLevel: string;
  autoApproveEnabled: boolean;
  threshold: number;
  promotedAt?: string;
}

export function TrustDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Trust & Scoring" }]);
  }, [setBreadcrumbs]);

  const { data: trustLevels = [], isLoading } = useQuery({
    queryKey: queryKeys.trustLevels(selectedCompanyId!),
    queryFn: async () => {
      const res = await fetch(`/api/companies/${selectedCompanyId}/trust-levels`);
      if (!res.ok) throw new Error("Failed to load trust levels");
      return res.json() as Promise<AgentTrustLevel[]>;
    },
    enabled: !!selectedCompanyId,
  });

  if (isLoading) return <PageSkeleton />;

  const promotedAgents = trustLevels.filter((t) => t.autoApproveEnabled);
  const pendingPromotions = trustLevels.filter(
    (t) => !t.autoApproveEnabled && t.approvedCount >= t.threshold,
  );

  return (
    <div className="container mx-auto max-w-6xl py-8 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Trust & Scoring</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Agent trust levels and skill promotion status
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-500/20 rounded">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-sm text-zinc-400">Auto-Approved Skills</p>
              <p className="text-2xl font-bold text-white">{promotedAgents.length}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-500/20 rounded">
              <Clock className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <p className="text-sm text-zinc-400">Pending Promotions</p>
              <p className="text-2xl font-bold text-white">{pendingPromotions.length}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/20 rounded">
              <TrendingUp className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-sm text-zinc-400">Total Tracked</p>
              <p className="text-2xl font-bold text-white">{trustLevels.length}</p>
            </div>
          </div>
        </Card>
      </div>

      {trustLevels.length === 0 ? (
        <Card className="p-12 text-center">
          <ShieldCheck className="w-12 h-12 text-zinc-600 mx-auto mb-4" />
          <p className="text-zinc-400">No trust levels tracked yet</p>
          <p className="text-sm text-zinc-500 mt-2">
            Trust levels are created when agents complete governed actions
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-white mb-3">Agent Trust Levels</h2>
            <div className="space-y-2">
              {trustLevels.map((level) => (
                <Card key={`${level.agentId}-${level.actionType}`} className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-white">{level.agentName}</h3>
                        <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                          {level.actionType}
                        </span>
                        {level.autoApproveEnabled && (
                          <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400">
                            Auto-Approved
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-sm text-zinc-400">
                        <span>✅ {level.approvedCount} approved</span>
                        <span>❌ {level.declinedCount} declined</span>
                        <span>⭐ {level.lowScoreCount} low scores</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-zinc-400">Trust Score</p>
                      <p className="text-2xl font-bold text-white">
                        {level.approvedCount}/{level.threshold}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
