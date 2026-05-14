import { sql, eq, ilike, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, clients, projects, issues, topics, contacts } from "@paperclipai/db";

export type EntityType = "company" | "client" | "project" | "issue" | "topic" | "contact";

export interface EntityResult {
  type: EntityType;
  id: string;
  name: string;
  score: number;
  status?: string;
  company?: { id: string; name: string } | null;
  client?: { id: string; name: string } | null;
  project?: { id: string; name: string } | null;
}

export interface WorkingContextShape {
  companyId?: string | null;
  companyName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  topicId?: string | null;
  topicName?: string | null;
  notes?: string | null;
  updatedAt?: string;
}

const MAX_PER_TYPE = 5;
const SCORE_THRESHOLD = 0.15;

// Attempt pg_trgm query; fall back to ILIKE if extension unavailable (e.g. embedded dev DB).
async function withTrgmFallback<T>(
  trgm: () => Promise<T[]>,
  fallback: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await trgm();
  } catch {
    return await fallback();
  }
}

export async function searchEntities(
  db: Db,
  query: string,
  types: EntityType[] = ["company", "client", "project", "issue", "topic", "contact"],
): Promise<EntityResult[]> {
  const q = query.trim();
  if (!q) return [];
  const likeQ = `%${q}%`;
  const results: EntityResult[] = [];

  // ── companies ──────────────────────────────────────────────────────────────
  if (types.includes("company")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: companies.id,
            name: companies.name,
            score: sql<number>`similarity(${companies.name}, ${q})`,
          })
          .from(companies)
          .where(sql`${companies.name} % ${q}`)
          .orderBy(sql`similarity(${companies.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({ id: companies.id, name: companies.name, score: sql<number>`0.5` })
          .from(companies)
          .where(ilike(companies.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({ type: "company", id: r.id, name: r.name, score: r.score });
      }
    }
  }

  // ── clients ────────────────────────────────────────────────────────────────
  if (types.includes("client")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: clients.id,
            name: clients.name,
            companyId: clients.companyId,
            companyName: companies.name,
            score: sql<number>`similarity(${clients.name}, ${q})`,
          })
          .from(clients)
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(sql`${clients.name} % ${q}`)
          .orderBy(sql`similarity(${clients.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: clients.id,
            name: clients.name,
            companyId: clients.companyId,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(clients)
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(ilike(clients.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({
          type: "client",
          id: r.id,
          name: r.name,
          score: r.score,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  // ── projects ───────────────────────────────────────────────────────────────
  if (types.includes("project")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: projects.id,
            name: projects.name,
            clientId: projects.clientId,
            clientName: clients.name,
            companyId: companies.id,
            companyName: companies.name,
            score: sql<number>`similarity(${projects.name}, ${q})`,
          })
          .from(projects)
          .leftJoin(clients, eq(clients.id, projects.clientId))
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(sql`${projects.name} % ${q}`)
          .orderBy(sql`similarity(${projects.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: projects.id,
            name: projects.name,
            clientId: projects.clientId,
            clientName: clients.name,
            companyId: companies.id,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(projects)
          .leftJoin(clients, eq(clients.id, projects.clientId))
          .leftJoin(companies, eq(companies.id, clients.companyId))
          .where(ilike(projects.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({
          type: "project",
          id: r.id,
          name: r.name,
          score: r.score,
          client: r.clientId ? { id: r.clientId, name: r.clientName ?? "" } : null,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  // ── issues ─────────────────────────────────────────────────────────────────
  if (types.includes("issue")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: issues.id,
            title: issues.title,
            identifier: issues.identifier,
            status: issues.status,
            projectId: issues.projectId,
            projectName: projects.name,
            companyId: issues.companyId,
            companyName: companies.name,
            score: sql<number>`similarity(${issues.title}, ${q})`,
          })
          .from(issues)
          .leftJoin(projects, eq(projects.id, issues.projectId))
          .leftJoin(companies, eq(companies.id, issues.companyId))
          .where(or(sql`${issues.title} % ${q}`, ilike(issues.identifier, `${q}%`)))
          .orderBy(sql`similarity(${issues.title}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: issues.id,
            title: issues.title,
            identifier: issues.identifier,
            status: issues.status,
            projectId: issues.projectId,
            projectName: projects.name,
            companyId: issues.companyId,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(issues)
          .leftJoin(projects, eq(projects.id, issues.projectId))
          .leftJoin(companies, eq(companies.id, issues.companyId))
          .where(or(ilike(issues.title, likeQ), ilike(issues.identifier, `${q}%`)))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD || r.identifier?.toLowerCase().startsWith(q.toLowerCase())) {
        const displayName = r.identifier ? `${r.identifier} — ${r.title}` : r.title;
        results.push({
          type: "issue",
          id: r.id,
          name: displayName,
          score: r.score,
          status: r.status,
          project: r.projectId ? { id: r.projectId, name: r.projectName ?? "" } : null,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  // ── topics ─────────────────────────────────────────────────────────────────
  if (types.includes("topic")) {
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: topics.id,
            name: topics.name,
            status: topics.status,
            score: sql<number>`similarity(${topics.name}, ${q})`,
          })
          .from(topics)
          .where(sql`${topics.name} % ${q}`)
          .orderBy(sql`similarity(${topics.name}, ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({ id: topics.id, name: topics.name, status: topics.status, score: sql<number>`0.5` })
          .from(topics)
          .where(ilike(topics.name, likeQ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({ type: "topic", id: r.id, name: r.name, score: r.score, status: r.status });
      }
    }
  }

  // ── contacts ───────────────────────────────────────────────────────────────
  if (types.includes("contact")) {
    const fullName = sql`COALESCE(${contacts.firstName} || ' ' || ${contacts.lastName}, ${contacts.email})`;
    const rows = await withTrgmFallback(
      () =>
        db
          .select({
            id: contacts.id,
            name: fullName,
            companyId: contacts.companyId,
            companyName: companies.name,
            score: sql<number>`similarity(COALESCE(${contacts.firstName} || ' ' || ${contacts.lastName}, ''), ${q})`,
          })
          .from(contacts)
          .leftJoin(companies, eq(companies.id, contacts.companyId))
          .where(or(sql`(COALESCE(${contacts.firstName}, '') || ' ' || COALESCE(${contacts.lastName}, '')) % ${q}`, ilike(contacts.email, likeQ)))
          .orderBy(sql`similarity(COALESCE(${contacts.firstName} || ' ' || ${contacts.lastName}, ''), ${q}) DESC`)
          .limit(MAX_PER_TYPE),
      () =>
        db
          .select({
            id: contacts.id,
            name: fullName,
            companyId: contacts.companyId,
            companyName: companies.name,
            score: sql<number>`0.5`,
          })
          .from(contacts)
          .leftJoin(companies, eq(companies.id, contacts.companyId))
          .where(or(
            sql`(COALESCE(${contacts.firstName}, '') || ' ' || COALESCE(${contacts.lastName}, '')) ILIKE ${likeQ}`,
            ilike(contacts.email, likeQ)
          ))
          .limit(MAX_PER_TYPE),
    );
    for (const r of rows) {
      if (r.score >= SCORE_THRESHOLD) {
        results.push({
          type: "contact",
          id: r.id,
          name: String(r.name),
          score: r.score,
          company: r.companyId ? { id: r.companyId, name: r.companyName ?? "" } : null,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function switchContext(
  db: Db,
  query: string,
  topicId: string,
): Promise<{ switched: boolean; context: WorkingContextShape | null; message: string }> {
  const results = await searchEntities(db, query);
  if (results.length === 0) {
    return {
      switched: false,
      context: null,
      message: `No match found for '${query}'. Try search_entities to inspect available entities.`,
    };
  }

  // Pick highest-score result per type
  const byType = new Map<EntityType, EntityResult>();
  for (const r of results) {
    if (!byType.has(r.type)) byType.set(r.type, r);
  }

  const directCompany = byType.get("company");
  const companyFromClient = byType.get("client")?.company;
  const companyFromProject = byType.get("project")?.company;
  const company = directCompany
    ? { id: directCompany.id, name: directCompany.name }
    : companyFromClient ?? companyFromProject ?? null;
  const client = byType.get("client");
  const project = byType.get("project");
  const issue = byType.get("issue");
  const topic = byType.get("topic");

  // Resolve issue title/identifier from display name "DEV-12 — title"
  const issueParts = issue ? issue.name.split(" — ") : [];
  const issueIdentifier = issueParts.length > 1 ? issueParts[0] ?? null : null;
  const issueTitle = issueParts.length > 1 ? issueParts.slice(1).join(" — ") : (issue?.name ?? null);

  const ctx: WorkingContextShape = {
    companyId: company?.id ?? null,
    companyName: company?.name ?? null,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    issueId: issue?.id ?? null,
    issueIdentifier,
    issueTitle,
    topicId: topic?.id ?? null,
    topicName: topic?.name ?? null,
    updatedAt: new Date().toISOString(),
  };

  const updated = await db
    .update(topics)
    .set({ workingContext: ctx as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(topics.id, topicId))
    .returning({ id: topics.id });

  if (updated.length === 0) {
    return {
      switched: false,
      context: null,
      message: `Topic ${topicId} not found — context not saved. Verify topicId is correct.`,
    };
  }

  const parts = [
    ctx.companyName,
    ctx.clientName,
    ctx.projectName,
    ctx.issueIdentifier ?? null,
    ctx.topicName ? `topic:${ctx.topicName}` : null,
  ].filter(Boolean);

  return {
    switched: true,
    context: ctx,
    message: `Switched → ${parts.join(" | ")}`,
  };
}
