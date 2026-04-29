import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { contactsApi, contactDisplayName, type Contact } from "../api/contacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import { Users, Mail, Phone, Briefcase } from "lucide-react";

export function Team() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId!;

  useEffect(() => {
    setBreadcrumbs([{ label: "Team" }]);
  }, [setBreadcrumbs]);

  const teamQuery = useQuery({
    queryKey: queryKeys.contacts.team(companyId),
    queryFn: () => contactsApi.listTeam(companyId),
    enabled: !!companyId,
  });

  if (!companyId) return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  if (teamQuery.isLoading) return <PageSkeleton />;

  const members = teamQuery.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Users className="h-6 w-6" /> Team
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          People in your company and partner organisations. Add contacts via the
          Clients page by marking a client as "My company".
        </p>
      </div>

      {members.length === 0 ? (
        <Card className="p-8 text-center">
          <Users className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            No team members yet. Go to Clients, mark one as "My company", then add
            contacts to it.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((c) => (
            <TeamCard key={c.id} contact={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamCard({ contact: c }: { contact: Contact }) {
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground shrink-0">
          {initials(c)}
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">
            {c.firstName || c.lastName
              ? contactDisplayName(c)
              : <span className="italic text-muted-foreground">Unnamed</span>}
          </p>
          {c.role && (
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
              <Briefcase className="h-3 w-3 shrink-0" />{c.role}
            </p>
          )}
        </div>
      </div>
      <div className="text-xs text-muted-foreground space-y-0.5">
        <p className="flex items-center gap-1.5 truncate">
          <Mail className="h-3 w-3 shrink-0" />
          <span className="font-mono truncate">{c.email}</span>
        </p>
        {c.phone && (
          <p className="flex items-center gap-1.5">
            <Phone className="h-3 w-3 shrink-0" />{c.phone}
          </p>
        )}
      </div>
    </Card>
  );
}

function initials(c: Contact): string {
  if (c.firstName && c.lastName) return `${c.firstName[0]}${c.lastName[0]}`.toUpperCase();
  if (c.firstName) return c.firstName[0]!.toUpperCase();
  if (c.lastName) return c.lastName[0]!.toUpperCase();
  return c.email[0]!.toUpperCase();
}
