import { useNavigate } from "@/lib/router";
import { useQueries } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useCompany } from "../../context/CompanyContext";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import type { Company } from "@paperclipai/shared";
import type { Issue } from "@paperclipai/shared";

function CompanyCard({
  company,
  issues,
  isLoading,
  isPersonal,
}: {
  company: Company;
  issues: Issue[] | undefined;
  isLoading: boolean;
  isPersonal: boolean;
}) {
  const navigate = useNavigate();
  const openIssues = issues?.filter((i) => ["backlog", "todo", "in_progress"].includes(i.status)) ?? [];
  const blockedIssues = issues?.filter((i) => i.status === "blocked") ?? [];

  return (
    <button
      onClick={() => navigate(`/${company.issuePrefix}/dashboard`)}
      className="text-left rounded-lg border border-border bg-card p-4 hover:border-foreground/20 transition-colors w-full"
    >
      <div className="flex items-center gap-2 mb-3">
        {company.brandColor && (
          <span
            className="inline-block w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: company.brandColor }}
          />
        )}
        <span className="font-medium text-sm">{company.name}</span>
        {isPersonal && (
          <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">Personal</span>
        )}
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{openIssues.length} open</span>
          {blockedIssues.length > 0 && (
            <span className="text-red-500 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {blockedIssues.length} blocked
            </span>
          )}
        </div>
      )}
    </button>
  );
}

export function FounderOverview() {
  const navigate = useNavigate();
  const { companies } = useCompany();
  const activeCompanies = companies.filter((c) => c.status !== "archived");

  const personalCompanyId = localStorage.getItem("founder.personalCompanyId") ?? "";

  const issueQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.issues.list(company.id),
      queryFn: () => issuesApi.list(company.id),
      staleTime: 30_000,
    })),
  });

  const allIssues = activeCompanies.flatMap((_, i) => issueQueries[i]?.data ?? []);
  const blockedIssues = allIssues.filter((i) => i.status === "blocked");
  const needsAttention = [...blockedIssues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  const companyById = new Map(activeCompanies.map((c) => [c.id, c]));

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Company Cards */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Companies
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {activeCompanies.map((company, i) => (
            <CompanyCard
              key={company.id}
              company={company}
              issues={issueQueries[i]?.data}
              isLoading={issueQueries[i]?.isLoading ?? false}
              isPersonal={company.id === personalCompanyId}
            />
          ))}
        </div>
      </section>

      {/* Needs Attention */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Needs Attention
        </h2>
        {needsAttention.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing blocked across your companies.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="text-left px-4 py-2">Company</th>
                  <th className="text-left px-4 py-2">Issue</th>
                  <th className="text-left px-4 py-2">Title</th>
                  <th className="text-left px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {needsAttention.map((issue) => {
                  const company = companyById.get(issue.companyId);
                  return (
                    <tr
                      key={issue.id}
                      className={cn(
                        "border-t border-border hover:bg-muted/30 cursor-pointer",
                      )}
                      onClick={() => navigate(`/${company?.issuePrefix ?? ""}/issues/${issue.id}`)}
                    >
                      <td className="px-4 py-2 text-muted-foreground">{company?.name ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{issue.identifier}</td>
                      <td className="px-4 py-2">{issue.title}</td>
                      <td className="px-4 py-2">
                        <span className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-1.5 py-0.5 rounded">
                          {issue.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
