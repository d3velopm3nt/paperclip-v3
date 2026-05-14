import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { topicIssues, topics, issues } from "@paperclipai/db";
import type { WorkingContextShape } from "./entity-search.js";

export interface TopicRow {
  id: string;
  name: string;
  summary: string;
  currentState: string | null;
  companyId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  issueCount: number;
  workingContext: unknown | null;
}

export interface LinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  companyId: string;
}

export interface TopicWithIssues extends Omit<TopicRow, "issueCount"> {
  issues: LinkedIssue[];
}

export function topicsService(db: Db) {
  async function list(statusFilter?: string): Promise<TopicRow[]> {
    const q = db
      .select({
        id: topics.id,
        name: topics.name,
        summary: topics.summary,
        currentState: topics.currentState,
        companyId: topics.companyId,
        status: topics.status,
        createdAt: topics.createdAt,
        updatedAt: topics.updatedAt,
        workingContext: topics.workingContext,
        issueCount: sql<number>`count(${topicIssues.id})::int`,
      })
      .from(topics)
      .leftJoin(topicIssues, eq(topicIssues.topicId, topics.id))
      .groupBy(topics.id)
      .orderBy(desc(topics.updatedAt));

    if (statusFilter) {
      return q.where(eq(topics.status, statusFilter));
    }
    return q;
  }

  async function getById(id: string): Promise<TopicWithIssues | null> {
    const rows = await db
      .select()
      .from(topics)
      .where(eq(topics.id, id))
      .limit(1);
    const topic = rows[0];
    if (!topic) return null;

    const linkedIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        companyId: issues.companyId,
      })
      .from(topicIssues)
      .innerJoin(issues, eq(issues.id, topicIssues.issueId))
      .where(eq(topicIssues.topicId, id))
      .orderBy(asc(topicIssues.createdAt));

    return { ...topic, issues: linkedIssues };
  }

  async function create(data: { name: string; companyId?: string | null }): Promise<TopicRow> {
    const [row] = await db
      .insert(topics)
      .values({ name: data.name, companyId: data.companyId ?? null })
      .returning();
    return { ...row!, issueCount: 0 };
  }

  async function update(
    id: string,
    data: {
      name?: string;
      summary?: string;
      currentState?: string | null;
      status?: string;
      companyId?: string | null;
    },
  ): Promise<TopicRow | null> {
    const [row] = await db
      .update(topics)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(topics.id, id))
      .returning();
    if (!row) return null;
    return { ...row, issueCount: 0 };
  }

  async function remove(id: string): Promise<boolean> {
    const result = await db
      .delete(topics)
      .where(eq(topics.id, id))
      .returning({ id: topics.id });
    return result.length > 0;
  }

  async function linkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .insert(topicIssues)
      .values({ topicId, issueId })
      .onConflictDoNothing();
  }

  async function unlinkIssue(topicId: string, issueId: string): Promise<void> {
    await db
      .delete(topicIssues)
      .where(and(eq(topicIssues.topicId, topicId), eq(topicIssues.issueId, issueId)));
  }

  async function setWorkingContext(topicId: string, context: WorkingContextShape): Promise<void> {
    await db
      .update(topics)
      .set({ workingContext: context as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(topics.id, topicId));
  }

  return { list, getById, create, update, remove, linkIssue, unlinkIssue, setWorkingContext };
}
